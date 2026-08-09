import * as fs from "node:fs";

import { LineCounter, parseDocument, type Document } from "yaml";

import type { AgentRegistry } from "../agents/registry.js";
import { ScribariumError } from "../util/errors.js";
import {
	BUILTIN_NAMES,
	PIPELINE_VERSION,
	type AgentStepSpec,
	type BuiltinStepSpec,
	type PipelineSpec,
	type StepSpec,
} from "./schema.js";

export class PipelineError extends ScribariumError {
	readonly exitCode = 2;
}

const KNOWN_STEP_KEYS = new Set([
	"id",
	"agent",
	"input",
	"output",
	"outputs",
	"model",
	"max_turns",
	"timeout_ms",
	"builtin",
	"with",
]);

/**
 * Parse and fully validate a pipeline file.
 *
 * Every error carries `file:line:col`, because the errors users actually hit are
 * semantic (an agent that does not exist, a `${var}` that never resolves) rather
 * than syntactic, and a message without a position sends them hunting. All of it
 * runs before the first model call: discovering a typo after twelve papers have
 * been analysed is the expensive failure mode this exists to prevent.
 */
export function loadPipeline(filePath: string, registry?: AgentRegistry): PipelineSpec {
	let source: string;
	try {
		source = fs.readFileSync(filePath, "utf-8");
	} catch {
		throw new PipelineError(`Cannot read pipeline file: ${filePath}`);
	}
	return parsePipeline(source, filePath, registry);
}

export function parsePipeline(
	source: string,
	filePath: string,
	registry?: AgentRegistry,
): PipelineSpec {
	const lineCounter = new LineCounter();
	const doc = parseDocument(source, { lineCounter, keepSourceTokens: true });

	for (const error of doc.errors) {
		throw new PipelineError(`${at(filePath, lineCounter, error.pos[0])}: ${error.message}`);
	}

	const ctx = new Context(filePath, doc, lineCounter);
	const root = doc.toJS() as Record<string, unknown> | null;
	if (root === null || typeof root !== "object" || Array.isArray(root)) {
		throw new PipelineError(`${filePath}: pipeline must be a YAML mapping`);
	}

	const version = root["version"] ?? PIPELINE_VERSION;
	if (version !== PIPELINE_VERSION) {
		throw new PipelineError(
			`${ctx.at(["version"])}: unsupported pipeline version ${String(version)} ` +
				`(this build understands ${PIPELINE_VERSION})`,
		);
	}

	const name = typeof root["name"] === "string" ? root["name"] : "pipeline";
	const description = typeof root["description"] === "string" ? root["description"] : undefined;
	const vars = readVars(root["vars"], ctx);
	const defaults = readDefaults(root["defaults"], ctx);

	const rawSteps = root["steps"];
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		throw new PipelineError(`${ctx.at(["steps"])}: pipeline needs a non-empty "steps" list`);
	}

	const steps: StepSpec[] = [];
	const seenIds = new Set<string>();

	for (const [index, raw] of rawSteps.entries()) {
		const step = readStep(raw, index, ctx, defaults);
		if (seenIds.has(step.id)) {
			throw new PipelineError(`${ctx.at(["steps", index, "id"])}: duplicate step id "${step.id}"`);
		}
		seenIds.add(step.id);
		steps.push(step);
	}

	const spec: PipelineSpec = {
		version: PIPELINE_VERSION,
		name,
		defaults,
		vars,
		steps,
		source,
		filePath,
		...(description !== undefined ? { description } : {}),
	};

	validateReferences(spec, ctx, registry);
	return spec;
}

function readStep(
	raw: unknown,
	index: number,
	ctx: Context,
	defaults: PipelineSpec["defaults"],
): StepSpec {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new PipelineError(`${ctx.at(["steps", index])}: each step must be a mapping`);
	}
	const step = raw as Record<string, unknown>;

	// Reject reserved-but-unimplemented kinds explicitly. Silently skipping a
	// `gate` would let a run sail past an approval the author asked for.
	for (const [key, milestone] of [
		["foreach", "M2"],
		["gate", "M3"],
		["parallel", "M2"],
	] as const) {
		if (step[key] !== undefined) {
			throw new PipelineError(
				`${ctx.at(["steps", index, key])}: "${key}" is not supported yet (planned for ${milestone})`,
			);
		}
	}

	for (const key of Object.keys(step)) {
		if (!KNOWN_STEP_KEYS.has(key)) {
			throw new PipelineError(
				`${ctx.at(["steps", index, key])}: unknown step key "${key}". ` +
					`Known keys: ${[...KNOWN_STEP_KEYS].sort().join(", ")}`,
			);
		}
	}

	const id = requireString(step["id"], ["steps", index, "id"], ctx);
	if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
		throw new PipelineError(
			`${ctx.at(["steps", index, "id"])}: step id must be lowercase and hyphenated, got "${id}"`,
		);
	}

	const outputs = readOutputs(step["output"] ?? step["outputs"], ["steps", index, "output"], ctx);
	const hasAgent = step["agent"] !== undefined;
	const hasBuiltin = step["builtin"] !== undefined;

	if (hasAgent === hasBuiltin) {
		throw new PipelineError(
			`${ctx.at(["steps", index])}: step "${id}" must set exactly one of "agent" or "builtin"`,
		);
	}

	if (hasBuiltin) {
		const run = requireString(step["builtin"], ["steps", index, "builtin"], ctx);
		if (!(BUILTIN_NAMES as readonly string[]).includes(run)) {
			throw new PipelineError(
				`${ctx.at(["steps", index, "builtin"])}: unknown builtin "${run}". ` +
					`Available: ${BUILTIN_NAMES.join(", ")}`,
			);
		}
		const withOptions = step["with"];
		if (withOptions !== undefined && (typeof withOptions !== "object" || withOptions === null)) {
			throw new PipelineError(`${ctx.at(["steps", index, "with"])}: "with" must be a mapping`);
		}
		const builtin: BuiltinStepSpec = {
			kind: "builtin",
			id,
			run: run as BuiltinStepSpec["run"],
			with: (withOptions as Record<string, unknown>) ?? {},
			outputs,
		};
		return builtin;
	}

	const agent = requireString(step["agent"], ["steps", index, "agent"], ctx);
	const model = optionalString(step["model"], ["steps", index, "model"], ctx) ?? defaults.model;
	const maxTurns =
		optionalInteger(step["max_turns"], ["steps", index, "max_turns"], ctx) ?? defaults.maxTurns;
	const timeoutMs =
		optionalInteger(step["timeout_ms"], ["steps", index, "timeout_ms"], ctx) ?? defaults.timeoutMs;
	const input = optionalString(step["input"], ["steps", index, "input"], ctx);

	const agentStep: AgentStepSpec = {
		kind: "agent",
		id,
		agent,
		outputs,
		...(input !== undefined ? { input } : {}),
		...(model !== undefined ? { model } : {}),
		...(maxTurns !== undefined ? { maxTurns } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
	return agentStep;
}

/**
 * Check every reference now: agent names against the registry, and every
 * `${...}` placeholder against what will actually be in scope at run time.
 */
function validateReferences(spec: PipelineSpec, ctx: Context, registry?: AgentRegistry): void {
	const producedBy = new Map<string, number>();

	for (const [index, step] of spec.steps.entries()) {
		if (step.kind === "agent" && registry !== undefined && !registry.has(step.agent)) {
			throw new PipelineError(
				`${ctx.at(["steps", index, "agent"])}: unknown agent "${step.agent}". ` +
					`Known agents: ${registry.names().join(", ") || "(none found)"}`,
			);
		}

		const scope = new Set(["output", "workspace", "runId"]);
		for (const key of Object.keys(spec.vars)) scope.add(`vars.${key}`);
		for (const [earlier, earlierIndex] of producedBy) {
			if (earlierIndex < index) scope.add(`steps.${earlier}.outputs`);
		}

		const templates = [
			...(step.kind === "agent" && step.input !== undefined ? [step.input] : []),
			...step.outputs,
			...(step.kind === "builtin" ? Object.values(step.with).filter(isString) : []),
		];

		for (const template of templates) {
			for (const reference of placeholders(template)) {
				if (scope.has(reference)) continue;
				throw new PipelineError(
					`${ctx.at(["steps", index])}: step "${step.id}" references \${${reference}}, ` +
						`which is not in scope. Available: ${[...scope].sort().join(", ")}`,
				);
			}
		}

		producedBy.set(step.id, index);
	}
}

export function placeholders(template: string): string[] {
	return [...template.matchAll(/\$\{([^}]+)\}/g)].map((match) => (match[1] ?? "").trim());
}

function readVars(raw: unknown, ctx: Context): Record<string, string> {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new PipelineError(`${ctx.at(["vars"])}: "vars" must be a mapping`);
	}
	const vars: Record<string, string> = {};
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		vars[key] = String(value);
	}
	return vars;
}

function readDefaults(raw: unknown, ctx: Context): PipelineSpec["defaults"] {
	if (raw === undefined || raw === null) return {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new PipelineError(`${ctx.at(["defaults"])}: "defaults" must be a mapping`);
	}
	const record = raw as Record<string, unknown>;
	const model = optionalString(record["model"], ["defaults", "model"], ctx);
	const maxTurns = optionalInteger(record["max_turns"], ["defaults", "max_turns"], ctx);
	const timeoutMs = optionalInteger(record["timeout_ms"], ["defaults", "timeout_ms"], ctx);
	return {
		...(model !== undefined ? { model } : {}),
		...(maxTurns !== undefined ? { maxTurns } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
	};
}

function readOutputs(raw: unknown, at: Path, ctx: Context): string[] {
	if (raw === undefined || raw === null) return [];
	if (typeof raw === "string") return raw.trim().length > 0 ? [raw.trim()] : [];
	if (Array.isArray(raw)) return raw.map((entry) => String(entry).trim()).filter((e) => e.length > 0);
	throw new PipelineError(`${ctx.at(at)}: "output" must be a string or a list of strings`);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

type Path = Array<string | number>;

function requireString(value: unknown, at: Path, ctx: Context): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new PipelineError(`${ctx.at(at)}: expected a non-empty string`);
	}
	return value.trim();
}

function optionalString(value: unknown, at: Path, ctx: Context): string | undefined {
	if (value === undefined || value === null) return undefined;
	return requireString(value, at, ctx);
}

function optionalInteger(value: unknown, at: Path, ctx: Context): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
		throw new PipelineError(`${ctx.at(at)}: expected a positive whole number`);
	}
	return value;
}

/** Maps a document path back to a `file:line:col` position for diagnostics. */
class Context {
	constructor(
		private readonly filePath: string,
		private readonly doc: Document.Parsed,
		private readonly lineCounter: LineCounter,
	) {}

	at(path: Path): string {
		const node = this.doc.getIn(path, true) as { range?: [number, number, number] } | undefined;
		const offset = node?.range?.[0];
		if (offset === undefined) return this.filePath;
		return at(this.filePath, this.lineCounter, offset);
	}
}

function at(filePath: string, lineCounter: LineCounter, offset: number): string {
	const { line, col } = lineCounter.linePos(offset);
	return `${filePath}:${line}:${col}`;
}
