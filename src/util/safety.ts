import { ScribariumError } from "./errors.js";

/**
 * Recursion guard.
 *
 * The orchestrator does not spawn agents that spawn agents, but `bash` can be
 * opted into per agent, and an agent with a shell can invoke `scribarium`. That
 * is a cycle that would keep paying for itself, so depth is tracked through the
 * environment. The variable names follow the pi subagent ecosystem's convention
 * so that nesting is counted correctly across tools, not just within this one.
 */
export const DEPTH_VAR = "PI_SUBAGENT_DEPTH";
export const MAX_DEPTH_VAR = "PI_SUBAGENT_MAX_DEPTH";
export const DEFAULT_MAX_DEPTH = 3;

export class RecursionError extends ScribariumError {
	readonly exitCode = 2;
}

export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env[DEPTH_VAR] ?? "0", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

export function maxDepth(env: NodeJS.ProcessEnv = process.env): number {
	const parsed = Number.parseInt(env[MAX_DEPTH_VAR] ?? "", 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_DEPTH;
}

/** @throws {RecursionError} when nested too deeply. */
export function assertDepthAllowed(env: NodeJS.ProcessEnv = process.env): void {
	const depth = currentDepth(env);
	const limit = maxDepth(env);
	if (depth >= limit) {
		throw new RecursionError(
			`Refusing to run: already ${depth} level(s) deep (${DEPTH_VAR}=${depth}, limit ${limit}).\n` +
				"An agent with the bash tool appears to have invoked scribarium, which would " +
				`recurse. Raise ${MAX_DEPTH_VAR} only if you are certain the nesting terminates.`,
		);
	}
}

/** Environment for any child process, with the depth incremented. */
export function childEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	return { ...env, [DEPTH_VAR]: String(currentDepth(env) + 1) };
}

/**
 * Credential-shaped strings, redacted before anything is written to disk.
 *
 * Run logs and the event stream are the artefacts a user is most likely to paste
 * into an issue or share with a colleague, and a provider error can quote the
 * request that carried the key. Redacting at the write boundary means every
 * writer is covered without each one having to remember.
 */
const SECRET_PATTERNS: Array<{ pattern: RegExp; replace: string }> = [
	// Provider API keys: sk-…, sk-ant-…, sk-kimi-…, and similar prefixed tokens.
	{ pattern: /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, replace: "$1-[REDACTED]" },
	// Bearer tokens in quoted headers.
	{ pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replace: "$1 [REDACTED]" },
	// Long hex blobs, which are usually tokens rather than prose.
	{ pattern: /\b[a-f0-9]{40,}\b/gi, replace: "[REDACTED]" },
	// `"apiKey": "..."` and friends, whatever the value looks like.
	{
		pattern: /(["']?(?:api[_-]?key|authorization|token|secret)["']?\s*[:=]\s*["'])[^"']{8,}(["'])/gi,
		replace: "$1[REDACTED]$2",
	},
];

export function redactSecrets(text: string): string {
	let result = text;
	for (const { pattern, replace } of SECRET_PATTERNS) {
		result = result.replace(pattern, replace);
	}
	return result;
}
