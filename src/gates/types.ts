import type { SelectableItem } from "./keep.js";
import type { GateStepSpec } from "../pipeline/schema.js";
import type { StageUsage } from "../runtime/run-stage.js";

export type GateDecision =
	/**
	 * `keep` prunes the gate's `select:` list to these ids before continuing.
	 * Absent means keep everything, which is what an unattended `--yes` does.
	 */
	| { kind: "approve"; keep?: string[] }
	/**
	 * Re-run `target` with `feedback` folded into its prompt.
	 *
	 * Called `revise` because that is what it does: the feedback is required,
	 * the previous attempt is handed to the retry alongside it, and the gate
	 * reopens. It was called `reject` for one release, and the terminal prompt
	 * offering `[a]pprove [r]eject` read as "accept this or throw it away" —
	 * a reviewer with notes could not see where their notes went, which is the
	 * one thing a gate exists to collect. Decisions written under the old name
	 * are still read (see `readDecision`), so a run waiting on one survives.
	 */
	| { kind: "revise"; feedback: string; target?: string }
	/** Continue past the gate without approving; the step is marked skipped. */
	| { kind: "skip" }
	| { kind: "abort" };

export interface GateRequest {
	step: GateStepSpec;
	runId: string;
	workspace: string;
	/** Absolute paths of the artifacts to review, with their sizes. */
	artifacts: Array<{ path: string; absolutePath: string; bytes: number; exists: boolean }>;
	/** Spend so far, so the reviewer can weigh a regenerate against its cost. */
	usageSoFar: StageUsage;
	/**
	 * The list this gate lets the reviewer prune, when it declares `select:`.
	 * Best-effort: an unreadable list still opens the gate, with no items, so it
	 * can be looked at and rejected.
	 */
	selectable?: { file: string; items: SelectableItem[] };
}

/**
 * A gate handler either returns a decision, or `"defer"` to say the run should
 * stop and wait for one to arrive out of band.
 */
export type GateHandler = (request: GateRequest) => Promise<GateDecision | "defer">;

/** Recorded on the step so `status` and `resume` can see the history. */
export interface GateDecisionRecord {
	at: string;
	kind: GateDecision["kind"];
	feedback?: string;
	target?: string;
}
