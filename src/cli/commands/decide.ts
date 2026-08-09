import { writeDecision } from "../../gates/file.js";
import type { GateDecision } from "../../gates/types.js";
import { UsageError } from "../../util/errors.js";
import { findLatestRun, RunLayout } from "../../workspace/layout.js";
import { RunStateStore } from "../../workspace/run-state.js";

/**
 * Kept out of `resume.ts` on purpose.
 *
 * Recording a decision touches only files on disk, but `resume.ts` pulls in the
 * agent SDK — and importing that costs real time before anything runs. Approve
 * and reject are the two commands a reviewer types most often, and they should
 * not wait for a runtime they never use.
 *
 * Record a reviewer's decision for a pending gate.
 */
export function commandDecide(
	workspace: string,
	runId: string | undefined,
	stepId: string | undefined,
	decision: GateDecision,
): number {
	const resolved = runId ?? findLatestRun(workspace);
	if (resolved === undefined) throw new UsageError(`No runs found in ${workspace}.`);

	const layout = new RunLayout(workspace, resolved);
	const state = new RunStateStore(layout).load();

	const pending =
		stepId ??
		Object.entries(state.steps).find(([, step]) => step.status === "awaiting")?.[0];
	if (pending === undefined) {
		throw new UsageError(`Run ${resolved} is not waiting at a gate.`);
	}
	if (state.steps[pending]?.type !== "gate") {
		throw new UsageError(`Step "${pending}" in run ${resolved} is not a gate.`);
	}

	writeDecision(layout, pending, decision);
	process.stdout.write(
		`Recorded ${decision.kind} for ${pending}. Continue with: scribarium resume ${resolved}\n`,
	);
	return 0;
}
