/**
 * Error taxonomy.
 *
 * Every error the orchestrator raises deliberately carries an `exitCode`, so the
 * CLI can map failures onto a stable contract without a lookup table:
 *
 *   0   success
 *   1   one or more stages failed
 *   2   usage / configuration error (bad YAML, unknown agent, bad frontmatter)
 *   3   preflight failure (missing credentials, unresolvable model)
 *  10   run halted at a gate, awaiting a human decision
 * 130   interrupted (SIGINT)
 */

export abstract class ScribariumError extends Error {
	abstract readonly exitCode: number;

	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** A malformed or invalid agent definition file. */
export class AgentDefinitionError extends ScribariumError {
	readonly exitCode = 2;

	constructor(
		readonly filePath: string,
		message: string,
	) {
		super(`${filePath}: ${message}`);
	}
}

/** A pipeline or CLI referenced an agent that does not exist. */
export class UnknownAgentError extends ScribariumError {
	readonly exitCode = 2;

	constructor(name: string, known: readonly string[]) {
		const suggestions = suggest(name, known);
		const hint =
			suggestions.length > 0
				? ` Did you mean: ${suggestions.join(", ")}?`
				: known.length > 0
					? ` Known agents: ${known.join(", ")}.`
					: " No agent definitions were found.";
		super(`Unknown agent "${name}".${hint}`);
	}
}

/** Invalid stage configuration discovered while preparing a run. */
export class StageConfigError extends ScribariumError {
	readonly exitCode = 2;
}

/** Missing credentials, or a model that no configured provider can serve. */
export class PreflightError extends ScribariumError {
	readonly exitCode = 3;
}

/** Return known names within a small edit distance of `name`. */
function suggest(name: string, known: readonly string[]): string[] {
	const target = name.toLowerCase();
	return known
		.map((candidate) => ({ candidate, distance: editDistance(target, candidate.toLowerCase()) }))
		.filter(({ distance }) => distance <= Math.max(2, Math.floor(target.length / 3)))
		.sort((a, b) => a.distance - b.distance)
		.slice(0, 3)
		.map(({ candidate }) => candidate);
}

/** Standard Levenshtein distance, iterative single-row form. */
function editDistance(a: string, b: string): number {
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;

	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
			const insertion = (current[j - 1] ?? 0) + 1;
			const deletion = (previous[j] ?? 0) + 1;
			current.push(Math.min(substitution, insertion, deletion));
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}
