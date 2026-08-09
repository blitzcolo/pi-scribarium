/**
 * Pipeline specification.
 *
 * M1 supports two step kinds executed strictly in order:
 *
 *   - `agent`   — run one agent definition to completion
 *   - `builtin` — deterministic code (corpus ingest today, citation checking in M4)
 *
 * `foreach` fan-out and `gate` steps arrive in M2 and M3. Their fields are
 * reserved here so a pipeline written today keeps parsing, but the loader
 * rejects them with a clear "not yet supported" message rather than silently
 * ignoring a step the author expected to run.
 */

export const PIPELINE_VERSION = 1;

export type StepKind = "agent" | "builtin" | "foreach" | "gate";

export interface AgentStepSpec {
	kind: "agent";
	id: string;
	agent: string;
	/** Task prompt; may reference `${vars.*}`, `${steps.*.outputs}`, `${output}`. */
	input?: string;
	/** Declared artifact paths, relative to the run's artifacts dir. */
	outputs: string[];
	/** Per-step model override, `provider/model[:thinking]`. */
	model?: string;
	maxTurns?: number;
	timeoutMs?: number;
}

export type BuiltinName = "ingest";

export interface BuiltinStepSpec {
	kind: "builtin";
	id: string;
	run: BuiltinName;
	/** Builtin-specific options, validated by the builtin itself. */
	with: Record<string, unknown>;
	outputs: string[];
}

export type StepSpec = AgentStepSpec | BuiltinStepSpec;

export interface PipelineDefaults {
	model?: string;
	maxTurns?: number;
	timeoutMs?: number;
}

export interface PipelineSpec {
	version: number;
	name: string;
	description?: string;
	defaults: PipelineDefaults;
	vars: Record<string, string>;
	steps: StepSpec[];
	/** Verbatim source, frozen into the run directory for reproducible resume. */
	source: string;
	/** Path the spec was loaded from. */
	filePath: string;
}

export const BUILTIN_NAMES: readonly BuiltinName[] = ["ingest"];
