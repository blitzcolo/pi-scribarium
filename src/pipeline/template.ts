import { PipelineError } from "./load.js";

export interface TemplateScope {
	vars: Record<string, string>;
	workspace: string;
	runId: string;
	/** The step's own declared output paths, joined for prompts. */
	output?: string;
	/** Outputs produced by earlier steps, keyed by step id. */
	steps: Record<string, { outputs: string[] }>;
}

/**
 * Substitute `${...}` references.
 *
 * The loader has already proved every reference resolves, so an unresolved one
 * here is a bug rather than user error — it throws instead of leaving the
 * literal `${...}` in a prompt, where the model would silently treat it as
 * instructions it could not follow.
 */
export function interpolate(template: string, scope: TemplateScope): string {
	return template.replace(/\$\{([^}]+)\}/g, (_match, rawReference: string) => {
		const reference = rawReference.trim();
		const value = lookup(reference, scope);
		if (value === undefined) {
			throw new PipelineError(`Unresolved template reference \${${reference}}`);
		}
		return value;
	});
}

function lookup(reference: string, scope: TemplateScope): string | undefined {
	if (reference === "workspace") return scope.workspace;
	if (reference === "runId") return scope.runId;
	if (reference === "output") return scope.output;

	const varMatch = /^vars\.(.+)$/.exec(reference);
	if (varMatch?.[1] !== undefined) return scope.vars[varMatch[1]];

	const stepMatch = /^steps\.([^.]+)\.outputs$/.exec(reference);
	if (stepMatch?.[1] !== undefined) {
		const outputs = scope.steps[stepMatch[1]]?.outputs;
		return outputs === undefined ? undefined : outputs.join(", ");
	}

	return undefined;
}
