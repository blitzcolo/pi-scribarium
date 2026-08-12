import type { AgentRegistry } from "../../agents/registry.js";
import { progressLabel } from "../../util/progress.js";
import type { PipelineEvent } from "../../pipeline/engine.js";
import type { PipelineSpec } from "../../pipeline/schema.js";
import type { RunLayout } from "../../workspace/layout.js";
import type { RunState } from "../../workspace/run-state.js";

/**
 * Every model reference a run will need, for preflight.
 *
 * Shared by `run` and `resume` because they drifted: `run` checked only
 * `kind === "agent"` and so skipped every fan-out. That is exactly backwards —
 * a fan-out is where a wrong model costs the most, and in the shipped pipeline
 * the fan-outs are the steps most likely to name a *different* provider from
 * the rest of the run. A missing credential passed preflight, ingest ran, and
 * then all thirty items failed one at a time.
 */
export function collectModelRefs(
	spec: PipelineSpec,
	registry: AgentRegistry,
	fallbackModel?: string,
): string[] {
	const refs = new Set<string>();
	for (const step of spec.steps) {
		if (step.kind !== "agent" && step.kind !== "foreach") continue;
		const ref = registry.get(step.agent).modelRef ?? step.model ?? fallbackModel;
		if (ref !== undefined) refs.add(ref);
	}
	return [...refs];
}

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
	/** When the current fan-out began, for the remaining-time estimate. */
	private fanoutStartedAt = 0;

	constructor(private readonly quiet: boolean) {}

	handle(event: PipelineEvent): void {
		switch (event.type) {
			case "step_start":
				this.endFanoutLine();
				process.stdout.write(`[${event.index + 1}/${event.total}] ${event.stepId} (${event.kind})\n`);
				break;

			case "fanout_start":
				this.fanoutStartedAt = Date.now();
				process.stdout.write(
					`      ${event.total} items, ${event.concurrency} at a time\n`,
				);
				break;

			case "fanout_progress": {
				const done = event.completed + event.failed;
				// The longest wait in a run is a fan-out over a large corpus, and it
				// is the one place an estimate is both cheap and worth having: the
				// items are similar and the concurrency is fixed.
				const eta =
					this.fanoutStartedAt === 0
						? ""
						: remainingLabel(done, event.total, Date.now() - this.fanoutStartedAt);
				const line =
					`      ${done}/${event.total} done` +
					(event.failed > 0 ? `, ${event.failed} failed` : "") +
					eta +
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
		this.fanoutStartedAt = 0;
	}
}

/** `, ~4m left` — empty until an estimate would be more use than noise. */
function remainingLabel(done: number, total: number, elapsedMs: number): string {
	const label = progressLabel(done, total, elapsedMs);
	const gap = label.indexOf("~");
	return gap === -1 ? "" : `, ${label.slice(gap)}`;
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
