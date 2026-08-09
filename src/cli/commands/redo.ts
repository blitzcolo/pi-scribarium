import { clearDecision } from "../../gates/file.js";
import { loadPipeline } from "../../pipeline/load.js";
import { UsageError } from "../../util/errors.js";
import { findLatestRun, RunLayout } from "../../workspace/layout.js";
import { RunStateStore } from "../../workspace/run-state.js";

export interface RedoOptions {
	workspace: string;
	stepId: string;
	runId?: string;
	feedback?: string;
}

/**
 * Re-open one step of an existing run so the next `resume` re-runs it.
 *
 * Gates cover feedback that arrives while the run is waiting. Feedback often
 * arrives later — a colleague reads the outline the next day — and by then the
 * gate is answered and the run is finished. Starting over would re-analyse the
 * whole corpus and pay for it again, so this reopens just the step in question.
 *
 * Everything after it is reopened too, including gates: a downstream stage was
 * written against the artifact that is about to change, and an approval given
 * for the old version is not an approval of the new one.
 */
export function commandRedo(options: RedoOptions): number {
	const { workspace } = options;
	const runId = options.runId ?? findLatestRun(workspace);
	if (runId === undefined) throw new UsageError(`No runs found in ${workspace}.`);

	const layout = new RunLayout(workspace, runId);
	const store = new RunStateStore(layout);
	const state = store.load();

	// The frozen copy, so the step order matches the run being edited.
	const spec = loadPipeline(layout.pipelineCopy);
	const index = spec.steps.findIndex((step) => step.id === options.stepId);
	if (index === -1) {
		throw new UsageError(
			`Run ${runId} has no step "${options.stepId}". Steps: ${spec.steps.map((s) => s.id).join(", ")}`,
		);
	}
	if (state.steps[options.stepId] === undefined) {
		throw new UsageError(`Step "${options.stepId}" never ran in ${runId}; nothing to redo.`);
	}

	const reopened: string[] = [];
	for (const step of spec.steps.slice(index)) {
		const stepState = state.steps[step.id];
		if (stepState === undefined) continue;
		stepState.status = "pending";
		delete stepState.error;
		if (step.kind === "gate") clearDecision(layout, step.id);
		reopened.push(step.id);
	}

	const target = state.steps[options.stepId];
	if (target !== undefined && options.feedback !== undefined) {
		target.pendingFeedback = options.feedback;
	}

	state.status = "running";
	state.cursor = { stepIndex: index, stepId: options.stepId };
	store.save(state);

	process.stdout.write(
		`Reopened ${reopened.join(", ")} in ${runId}.\n` +
			(options.feedback === undefined
				? ""
				: `Feedback will be folded into "${options.stepId}".\n`) +
			`\nContinue with: scribarium resume ${runId}\n`,
	);
	return 0;
}
