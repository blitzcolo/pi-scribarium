import * as fs from "node:fs";

import { LineCounter, parseDocument, type Document } from "yaml";

import type { AgentRegistry } from "../agents/registry.js";
import { ScribariumError } from "../util/errors.js";
import { DEFAULT_CONCURRENCY, MAX_CONCURRENCY } from "./pool.js";
import {
	BUILTIN_NAMES,
	PIPELINE_VERSION,
	type AgentStepSpec,
	type BuiltinStepSpec,
	type ForeachSource,
	type ForeachStepSpec,
	type GateStepSpec,
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
	"foreach",
	"parallel",
	"max_failures",
	"cache",
	"optional",
	"gate",
	"show",
	"on_reject",
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
export function loadPipeline(
	filePath: string,
	registry?: AgentRegistry,
	overrides: Record<string, string> = {},
): PipelineSpec {
	let source: string;
	try {
		source = fs.readFileSync(filePath, "utf-8");
	} catch {
		throw new PipelineError(`Cannot read pipeline file: ${filePath}`);
	}
	return parsePipeline(source, filePath, registry, overrides);
}

export function parsePipeline(
	source: string,
	filePath: string,
	registry?: AgentRegistry,
	overrides: Record<string, string> = {},
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
	const vars = { ...readVars(root["vars"], ctx), ...overrides };
	const defaults = readDefaults(root["defaults"], ctx);

	const rawSteps = root["steps"];
	if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
		throw new PipelineError(`${ctx.at(["steps"])}: pipeline needs a non-empty "steps" list`);
	}

	const steps: StepSpec[] = [];
	const seenIds = new Set<string>();

	for (const [index, raw] of rawSteps.entries()) {
		const step = readStep(raw, index, ctx, defaults, vars);
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
	vars: Record<string, string>,
): StepSpec {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new PipelineError(`${ctx.at(["steps", index])}: each step must be a mapping`);
	}
	const step = raw as Record<string, unknown>;

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

	if (step["gate"] !== undefined) {
		const title =
			typeof step["gate"] === "string" && step["gate"].trim().length > 0
				? step["gate"].trim()
				: `Approve ${id}`;
		const onReject = optionalString(step["on_reject"], ["steps", index, "on_reject"], ctx);
		const gate: GateStepSpec = {
			kind: "gate",
			id,
			title,
			show: readOutputs(step["show"], ["steps", index, "show"], ctx),
			outputs,
			...(onReject !== undefined ? { onReject } : {}),
		};
		return gate;
	}

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
	// `model` is resolved against vars at load time rather than run time, so a
	// pipeline can name a role ("the cheap one") without hardcoding a provider,
	// and preflight still sees a concrete reference to check credentials for.
	const model = resolveModelRef(
		optionalString(step["model"], ["steps", index, "model"], ctx) ?? defaults.model,
		vars,
		["steps", index, "model"],
		ctx,
	);
	// Kept apart from `defaults`, which the engine resolves *after* the agent's own
	// declaration. Folding them together here made a pipeline-wide default override
	// every agent's budget: with `defaults: max_turns: 30`, a polisher that declared
	// 40 was cut to 30 and failed the run on a long manuscript. An explicit per-step
	// value is still an override — that is what writing it on the step means.
	const maxTurns = optionalInteger(step["max_turns"], ["steps", index, "max_turns"], ctx);
	const timeoutMs = optionalInteger(step["timeout_ms"], ["steps", index, "timeout_ms"], ctx);
	const input = optionalString(step["input"], ["steps", index, "input"], ctx);

	if (step["foreach"] !== undefined) {
		const source = readForeachSource(step["foreach"], ["steps", index, "foreach"], ctx);
		const concurrency =
			optionalInteger(step["parallel"], ["steps", index, "parallel"], ctx) ?? DEFAULT_CONCURRENCY;
		if (concurrency > MAX_CONCURRENCY) {
			throw new PipelineError(
				`${ctx.at(["steps", index, "parallel"])}: parallel is capped at ${MAX_CONCURRENCY}`,
			);
		}
		const maxFailures = optionalInteger(step["max_failures"], ["steps", index, "max_failures"], ctx);
		const cache = optionalBoolean(step["cache"], ["steps", index, "cache"], ctx) ?? false;
		const optional = optionalBoolean(step["optional"], ["steps", index, "optional"], ctx) ?? false;

		// Caching compares each output against its source file's mtime, and only
		// glob items carry a source path. Refusing here beats a `cache: true`
		// that silently never caches anything.
		if (cache && source.kind !== "glob") {
			throw new PipelineError(
				`${ctx.at(["steps", index, "cache"])}: cache requires a glob foreach, ` +
					`because only file-backed items have a source to compare against`,
			);
		}

		// "Every declared output is newer than its source" is vacuously true when
		// nothing is declared, so a cached step without one reports every item
		// cached and never runs a single session.
		if (cache && outputs.length === 0) {
			throw new PipelineError(
				`${ctx.at(["steps", index, "cache"])}: cache requires at least one output, ` +
					`or every item counts as cached and the step silently runs nothing`,
			);
		}

		// Without an ${item.*} reference every item writes the same path, and N
		// concurrent sessions race on one file — silently, with the last writer
		// winning. Cheaper to refuse than to debug.
		for (const output of outputs) {
			if (!/\$\{item\./.test(output)) {
				throw new PipelineError(
					`${ctx.at(["steps", index, "output"])}: a foreach output must reference \${item.*} ` +
						`(e.g. analysis/\${item.id}.md), or every item would write to "${output}"`,
				);
			}
		}

		const foreachStep: ForeachStepSpec = {
			kind: "foreach",
			id,
			source,
			agent,
			outputs,
			concurrency,
			...(input !== undefined ? { input } : {}),
			...(model !== undefined ? { model } : {}),
			...(maxTurns !== undefined ? { maxTurns } : {}),
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
			...(maxFailures !== undefined ? { maxFailures } : {}),
			...(cache ? { cache } : {}),
			...(optional ? { optional } : {}),
		};
		return foreachStep;
	}

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
		if (
			(step.kind === "agent" || step.kind === "foreach") &&
			registry !== undefined &&
			!registry.has(step.agent)
		) {
			throw new PipelineError(
				`${ctx.at(["steps", index, "agent"])}: unknown agent "${step.agent}". ` +
					`Known agents: ${registry.names().join(", ") || "(none found)"}`,
			);
		}

		const scope = new Set(["output", "workspace", "runId"]);
		// A fan-out step's own templates may reference the current item. The exact
		// field set depends on the source and is only known at run time, so any
		// `item.*` reference is accepted here and resolved per item later.
		const allowsItem = step.kind === "foreach";
		for (const key of Object.keys(spec.vars)) scope.add(`vars.${key}`);
		for (const [earlier, earlierIndex] of producedBy) {
			if (earlierIndex < index) scope.add(`steps.${earlier}.outputs`);
		}

		const templates = [
			...((step.kind === "agent" || step.kind === "foreach") && step.input !== undefined
				? [step.input]
				: []),
			...(step.kind === "gate" ? step.show : []),
			...step.outputs,
			...(step.kind === "builtin" ? Object.values(step.with).filter(isString) : []),
		];

		for (const template of templates) {
			for (const reference of placeholders(template)) {
				if (scope.has(reference)) continue;
				if (allowsItem && reference.startsWith("item.")) continue;
				throw new PipelineError(
					`${ctx.at(["steps", index])}: step "${step.id}" references \${${reference}}, ` +
						`which is not in scope. Available: ${[...scope].sort().join(", ")}`,
				);
			}
		}

		// A gate that rejects must jump back to a step that has already run,
		// otherwise "regenerate" would target something that produced nothing.
		if (step.kind === "gate" && step.onReject !== undefined) {
			const target = producedBy.get(step.onReject);
			if (target === undefined) {
				throw new PipelineError(
					`${ctx.at(["steps", index, "on_reject"])}: on_reject must name an earlier step, ` +
						`and "${step.onReject}" is not one. Earlier steps: ${[...producedBy.keys()].join(", ") || "(none)"}`,
				);
			}
		}

		producedBy.set(step.id, index);
	}
}

function readForeachSource(raw: unknown, at: Path, ctx: Context): ForeachSource {
	if (typeof raw === "string") return { kind: "glob", pattern: raw };
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new PipelineError(`${ctx.at(at)}: "foreach" must be a glob string or a mapping`);
	}
	const source = raw as Record<string, unknown>;

	if (typeof source["glob"] === "string") return { kind: "glob", pattern: source["glob"] };
	if (typeof source["json"] === "string") {
		const jsonPath = source["path"];
		return {
			kind: "json",
			file: source["json"],
			...(typeof jsonPath === "string" ? { path: jsonPath } : {}),
		};
	}
	if (Array.isArray(source["items"])) {
		return { kind: "items", values: source["items"] as Array<Record<string, unknown>> };
	}
	throw new PipelineError(
		`${ctx.at(at)}: "foreach" needs one of glob, json, or items`,
	);
}

function resolveModelRef(
	ref: string | undefined,
	vars: Record<string, string>,
	at: Path,
	ctx: Context,
): string | undefined {
	if (ref === undefined) return undefined;
	for (const reference of placeholders(ref)) {
		const key = /^vars\.(.+)$/.exec(reference)?.[1];
		if (key === undefined || vars[key] === undefined) {
			throw new PipelineError(
				`${ctx.at(at)}: "model" may only reference \${vars.*}, and \${${reference}} is not defined. ` +
					`Defined vars: ${Object.keys(vars).join(", ") || "(none)"}`,
			);
		}
	}
	const resolved = ref.replace(/\$\{vars\.([^}]+)\}/g, (_m, key: string) => vars[key.trim()] ?? "");
	// An empty role var means "unset": fall through to the session default rather
	// than passing an empty string on as if it named a model.
	return resolved.trim().length > 0 ? resolved.trim() : undefined;
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

function optionalBoolean(value: unknown, at: Path, ctx: Context): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		throw new PipelineError(`${ctx.at(at)}: expected true or false`);
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
