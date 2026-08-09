import type { GateStepSpec } from "../pipeline/schema.js";
import type { StageUsage } from "../runtime/run-stage.js";

export type GateDecision =
	| { kind: "approve" }
	/** Re-run `target` with `feedback` folded into its prompt. */
	| { kind: "reject"; feedback: string; target?: string }
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
