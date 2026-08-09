import type { PipelineEvent } from "../../pipeline/engine.js";
import type { RunLayout } from "../../workspace/layout.js";
import type { RunState } from "../../workspace/run-state.js";

/** A run stopped at a gate, waiting for a human decision. */
export const EXIT_AWAITING_GATE = 10;

/**
 * Render pipeline progress.
 *
 * On a TTY a fan-out redraws one line in place, because thirty papers would
 * otherwise scroll the interesting parts of the run off screen. When output is
 * piped to a file there is no cursor to move, so each transition gets its own
 * line instead.
 */
export class ProgressReporter {
	private readonly tty = process.stdout.isTTY === true;
	private fanoutLine = false;

	constructor(private readonly quiet: boolean) {}

	handle(event: PipelineEvent): void {
		switch (event.type) {
			case "step_start":
				this.endFanoutLine();
				process.stdout.write(`[${event.index + 1}/${event.total}] ${event.stepId} (${event.kind})\n`);
				break;

			case "fanout_start":
				process.stdout.write(
					`      ${event.total} items, ${event.concurrency} at a time\n`,
				);
				break;

			case "fanout_progress": {
				const done = event.completed + event.failed;
				const line =
					`      ${done}/${event.total} done` +
					(event.failed > 0 ? `, ${event.failed} failed` : "") +
					`  (${event.itemId})`;
				if (this.tty) {
					process.stdout.write(`\r\u001b[2K${line}`);
					this.fanoutLine = true;
				} else if (event.error !== undefined || done === event.total) {
					process.stdout.write(`${line}\n`);
				}
				// A failure is worth a line of its own even mid-fan-out.
				if (event.error !== undefined) {
					this.endFanoutLine();
					process.stderr.write(`      ! ${event.itemId}: ${event.error}\n`);
				}
				break;
			}

			case "step_end":
				this.endFanoutLine();
				process.stdout.write(
					event.status === "completed"
						? `      ${event.stepId}: ok\n`
						: `      ${event.stepId}: ${event.status} — ${event.error ?? ""}\n`,
				);
				break;

			case "log":
				this.endFanoutLine();
				process.stdout.write(`${event.message}\n`);
				break;

			case "stage":
				// Per-tool chatter is noise during a fan-out; it belongs to one item
				// among many and the progress line already says which.
				if (this.quiet || this.fanoutLine) break;
				if (event.event.type === "tool") process.stdout.write(`      · ${event.event.tool}\n`);
				else if (event.event.type === "steer") process.stdout.write("      · wrapping up (turn budget)\n");
				else if (event.event.type === "warn") process.stderr.write(`      ! ${event.event.message}\n`);
				break;
		}
	}

	private endFanoutLine(): void {
		if (!this.fanoutLine) return;
		process.stdout.write("\n");
		this.fanoutLine = false;
	}
}

/** List every failed item so a partial run is actionable, not just "27/30". */
export function formatFailures(state: RunState, layout: RunLayout): string {
	const lines: string[] = [];
	for (const [stepId, step] of Object.entries(state.steps)) {
		for (const [itemId, item] of Object.entries(step.items ?? {})) {
			if (item.status !== "failed") continue;
			lines.push(
				`  ${stepId}/${itemId}  ${item.error?.code ?? "FAILED"}: ${item.error?.message ?? ""}`,
				`      log: ${layout.logFile(stepId, itemId)}`,
			);
		}
		if (step.status === "failed" && step.items === undefined) {
			lines.push(`  ${stepId}  ${step.error?.code ?? "FAILED"}: ${step.error?.message ?? ""}`);
		}
	}
	return lines.length === 0 ? "" : `\nFailures:\n${lines.join("\n")}\n`;
}


export function makeReporter(quiet: boolean): ProgressReporter {
	return new ProgressReporter(quiet);
}
