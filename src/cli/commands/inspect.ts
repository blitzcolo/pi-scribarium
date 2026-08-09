import { buildUsageReport, formatUsageReport } from "../../report/usage.js";
import { UsageError } from "../../util/errors.js";
import { findLatestRun, RunLayout } from "../../workspace/layout.js";
import { EventLog, RunStateStore, type RunState } from "../../workspace/run-state.js";

function load(workspace: string, runId?: string): { state: RunState; layout: RunLayout } {
	const resolved = runId ?? findLatestRun(workspace);
	if (resolved === undefined) {
		throw new UsageError(`No runs found in ${workspace}. Run a pipeline first.`);
	}
	const layout = new RunLayout(workspace, resolved);
	return { state: new RunStateStore(layout).load(), layout };
}

/** Human-readable snapshot of where a run got to. */
export function commandStatus(workspace: string, runId: string | undefined, json: boolean): number {
	const { state, layout } = load(workspace, runId);

	if (json) {
		process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
		return state.status === "completed" ? 0 : 1;
	}

	process.stdout.write(`run      ${state.runId}\n`);
	process.stdout.write(`status   ${state.status}\n`);
	process.stdout.write(`pipeline ${state.pipelinePath}\n`);
	process.stdout.write(`started  ${state.createdAt}\n`);
	process.stdout.write(`updated  ${state.updatedAt}\n\n`);

	const entries = Object.entries(state.steps);
	if (entries.length === 0) {
		process.stdout.write("No steps have started yet.\n");
	} else {
		const width = Math.max(...entries.map(([id]) => id.length));
		for (const [id, step] of entries) {
			const detail =
				step.error !== undefined
					? `  ${step.error.code}: ${step.error.message}`
					: step.outputs.length > 0
						? `  -> ${step.outputs.join(", ")}`
						: "";
			process.stdout.write(`${id.padEnd(width)}  ${step.status.padEnd(9)}${detail}\n`);
		}
	}

	if (state.status !== "completed") {
		process.stdout.write(`\nDetails: ${layout.runDir}\n`);
	}
	return state.status === "completed" ? 0 : 1;
}

/** Token and cost accounting, per step and in total. */
export function commandReport(workspace: string, runId: string | undefined, json: boolean): number {
	const { state } = load(workspace, runId);
	const report = buildUsageReport(state);

	process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatUsageReport(report));
	return 0;
}

/** The append-only narrative of a run, for debugging. */
export function commandEvents(workspace: string, runId: string | undefined): number {
	const { layout } = load(workspace, runId);
	for (const event of new EventLog(layout.eventsFile).read()) {
		const { at, type, ...rest } = event;
		const detail = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : "";
		process.stdout.write(`${at}  ${type}${detail}\n`);
	}
	return 0;
}
