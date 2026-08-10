import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

import { AgentDefinitionError } from "../util/errors.js";
import {
	AGENT_DEFAULTS,
	BUILTIN_TOOLS,
	THINKING_LEVELS,
	type AgentDefinition,
	type AgentFrontmatter,
	type AgentSource,
	type PromptMode,
	type ThinkingLevelName,
} from "./types.js";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/**
 * Normalize the `tools` field, which may be written either as pi's
 * comma-separated string (`tools: read, grep`) or as a YAML list
 * (`tools: [read, grep]`). `parseFrontmatter` delegates to the real `yaml`
 * package, so both forms reach us as their natural JS types.
 *
 * Returns `undefined` to mean "unspecified — fall back to DEFAULT_TOOLS", and
 * an empty array to mean "explicitly no tools", which the SDK honours as a real
 * empty allowlist (CLAUDE.md gotcha #8).
 */
export function normalizeTools(value: unknown, filePath: string): readonly string[] | undefined {
	if (value === undefined || value === null) return undefined;

	let names: string[];
	if (Array.isArray(value)) {
		names = value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
	} else if (typeof value === "string") {
		const trimmed = value.trim();
		// `all` means every built-in tool. Returning undefined here would instead
		// mean "unset", which resolves to DEFAULT_TOOLS — a read-only set — so
		// `tools: all` granted strictly *fewer* tools than spelling them out, and
		// the agent burned its whole budget before failing without a `write`.
		if (trimmed === "all") return [...BUILTIN_TOOLS];
		if (trimmed === "" || trimmed === "none") return [];
		names = trimmed
			.split(",")
			.map((entry) => entry.trim())
			.filter((entry) => entry.length > 0);
	} else {
		throw new AgentDefinitionError(
			filePath,
			`"tools" must be a comma-separated string or a list, got ${typeof value}`,
		);
	}

	const deduped = [...new Set(names)];
	const unknown = deduped.filter((name) => !BUILTIN_TOOLS.includes(name as never));
	if (unknown.length > 0) {
		// pi silently ignores unknown tool names, which would leave the agent
		// quietly tool-less. Fail loudly instead.
		throw new AgentDefinitionError(
			filePath,
			`unknown tool${unknown.length > 1 ? "s" : ""} ${unknown.map((n) => `"${n}"`).join(", ")}. ` +
				`Valid tools: ${BUILTIN_TOOLS.join(", ")}`,
		);
	}
	return deduped;
}

/** Parse and validate one agent definition file. */
export function parseAgentFile(
	content: string,
	filePath: string,
	source: AgentSource,
): AgentDefinition {
	const { frontmatter, body } = parseFrontmatter<AgentFrontmatter>(content);

	const name = requiredString(frontmatter.name, "name", filePath);
	if (!NAME_PATTERN.test(name)) {
		throw new AgentDefinitionError(
			filePath,
			`"name" must match ${NAME_PATTERN.source} (lowercase, no spaces), got "${name}"`,
		);
	}

	const description = requiredString(frontmatter.description, "description", filePath);

	const systemPrompt = body.trim();
	if (systemPrompt.length === 0) {
		throw new AgentDefinitionError(
			filePath,
			"the body is empty; it is used as the agent's system prompt",
		);
	}

	const modelRef = optionalString(frontmatter.model, "model", filePath);
	const thinking = optionalEnum<ThinkingLevelName>(
		frontmatter.thinking,
		"thinking",
		THINKING_LEVELS,
		filePath,
	);
	const promptMode =
		optionalEnum<PromptMode>(frontmatter.prompt_mode, "prompt_mode", ["replace", "append"], filePath) ??
		AGENT_DEFAULTS.promptMode;
	const maxTurns =
		optionalInteger(frontmatter.max_turns, "max_turns", { min: 1 }, filePath) ??
		AGENT_DEFAULTS.maxTurns;
	const softTurnRatio =
		optionalNumber(frontmatter.soft_turn_ratio, "soft_turn_ratio", { min: 0, max: 1, exclusiveMin: true }, filePath) ??
		AGENT_DEFAULTS.softTurnRatio;
	const timeoutMs = optionalInteger(frontmatter.timeout_ms, "timeout_ms", { min: 1 }, filePath);
	const tools = normalizeTools(frontmatter.tools, filePath);
	const compaction = optionalBoolean(frontmatter.compaction, "compaction", filePath) ?? AGENT_DEFAULTS.compaction;
	const inheritResources =
		optionalBoolean(frontmatter.inherit_resources, "inherit_resources", filePath) ??
		AGENT_DEFAULTS.inheritResources;

	return {
		name,
		description,
		promptMode,
		maxTurns,
		softTurnRatio,
		outputs: normalizeOutputs(frontmatter.output, filePath),
		compaction,
		inheritResources,
		systemPrompt,
		source,
		filePath,
		// Spread conditionally: `exactOptionalPropertyTypes` forbids assigning
		// `undefined` to an optional property.
		...(modelRef !== undefined ? { modelRef } : {}),
		...(thinking !== undefined ? { thinking } : {}),
		...(timeoutMs !== undefined ? { timeoutMs } : {}),
		...(tools !== undefined ? { tools } : {}),
	};
}

function normalizeOutputs(value: unknown, filePath: string): readonly string[] {
	if (value === undefined || value === null) return [];
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? [trimmed] : [];
	}
	if (Array.isArray(value)) {
		return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
	}
	throw new AgentDefinitionError(filePath, `"output" must be a string or a list of strings`);
}

function requiredString(value: unknown, field: string, filePath: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AgentDefinitionError(
			filePath,
			`missing required frontmatter field "${field}". ` +
				`pi's own agent loader skips files without name and description.`,
		);
	}
	return value.trim();
}

function optionalString(value: unknown, field: string, filePath: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new AgentDefinitionError(filePath, `"${field}" must be a non-empty string`);
	}
	return value.trim();
}

function optionalEnum<T extends string>(
	value: unknown,
	field: string,
	allowed: readonly string[],
	filePath: string,
): T | undefined {
	if (value === undefined || value === null) return undefined;
	const text = String(value).trim();
	if (!allowed.includes(text)) {
		throw new AgentDefinitionError(
			filePath,
			`"${field}" must be one of ${allowed.join(", ")}, got "${text}"`,
		);
	}
	return text as T;
}

function optionalBoolean(value: unknown, field: string, filePath: string): boolean | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		throw new AgentDefinitionError(filePath, `"${field}" must be true or false`);
	}
	return value;
}

function optionalInteger(
	value: unknown,
	field: string,
	bounds: { min?: number; max?: number },
	filePath: string,
): number | undefined {
	const parsed = optionalNumber(value, field, bounds, filePath);
	if (parsed === undefined) return undefined;
	if (!Number.isInteger(parsed)) {
		throw new AgentDefinitionError(filePath, `"${field}" must be a whole number, got ${parsed}`);
	}
	return parsed;
}

function optionalNumber(
	value: unknown,
	field: string,
	bounds: { min?: number; max?: number; exclusiveMin?: boolean },
	filePath: string,
): number | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new AgentDefinitionError(filePath, `"${field}" must be a number`);
	}
	const { min, max, exclusiveMin } = bounds;
	if (min !== undefined && (exclusiveMin === true ? value <= min : value < min)) {
		throw new AgentDefinitionError(
			filePath,
			`"${field}" must be ${exclusiveMin === true ? "greater than" : "at least"} ${min}, got ${value}`,
		);
	}
	if (max !== undefined && value > max) {
		throw new AgentDefinitionError(filePath, `"${field}" must be at most ${max}, got ${value}`);
	}
	return value;
}
