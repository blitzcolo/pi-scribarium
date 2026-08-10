/**
 * Pipeline specification.
 *
 * Four step kinds, executed in order:
 *
 *   - `agent`   — run one agent definition to completion
 *   - `foreach` — fan the same agent out over many items, one session each
 *   - `builtin` — deterministic code: ingest, assemble, build-index, citations
 *   - `gate`    — stop for a human decision
 *
 * Only a gate can move the cursor backwards: rejecting one rewinds to its
 * `on_reject` target and reopens every step from there on.
 */

export const PIPELINE_VERSION = 1;

export type StepKind = "agent" | "builtin" | "foreach" | "gate";

/** Fields exposed to templates for each fan-out item. */
export interface ForeachItem {
	id: string;
	index: number;
	path?: string;
	stem?: string;
	[key: string]: unknown;
}

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

export type BuiltinName = "ingest" | "assemble" | "check-citations" | "build-index";

export interface BuiltinStepSpec {
	kind: "builtin";
	id: string;
	run: BuiltinName;
	/** Builtin-specific options, validated by the builtin itself. */
	with: Record<string, unknown>;
	outputs: string[];
}

/** Where a fan-out gets its items. Exactly one field is set. */
export type ForeachSource =
	| { kind: "glob"; pattern: string }
	| { kind: "json"; file: string; path?: string }
	| { kind: "items"; values: Array<Record<string, unknown>> };

export interface ForeachStepSpec {
	kind: "foreach";
	id: string;
	source: ForeachSource;
	/** The agent run once per item. */
	agent: string;
	input?: string;
	/** Must reference ${item.*}; enforced at load time. */
	outputs: string[];
	model?: string;
	maxTurns?: number;
	timeoutMs?: number;
	concurrency: number;
	/** Stop scheduling after this many item failures. Unset means isolate all. */
	maxFailures?: number;
	/**
	 * Skip an item whose outputs already exist and are newer than its source.
	 *
	 * For fan-outs whose product is a property of the input file rather than of
	 * a run — a summary of a paper that has not changed is the same summary.
	 * Requires a glob source, since only those items carry a source path.
	 */
	cache?: boolean;
	/** Matching no items is a skipped step rather than a failure. */
	optional?: boolean;
}

export interface GateStepSpec {
	kind: "gate";
	id: string;
	title: string;
	/** Artifacts to show the reviewer before they decide. */
	show: string[];
	/** Step to re-run when the reviewer rejects. Must be an earlier step. */
	onReject?: string;
	outputs: string[];
}

export type StepSpec = AgentStepSpec | BuiltinStepSpec | ForeachStepSpec | GateStepSpec;

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

export const BUILTIN_NAMES: readonly BuiltinName[] = [
	"ingest",
	"assemble",
	"check-citations",
	"build-index",
];
