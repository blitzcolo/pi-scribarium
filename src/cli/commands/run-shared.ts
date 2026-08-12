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
	/**
	 * When the current fan-out began, for the remaining-time estimate.
	 *
	 * `undefined` rather than 0 for "no fan-out running": 0 is a legitimate
	 * reading from an injected clock, and a sentinel that a real value can equal
	 * silently disables the estimate for the whole stage.
	 */
	private fanoutStartedAt: number | undefined;
	/** Last time a fan-out heartbeat was written, when not on a terminal. */
	private lastHeartbeatAt: number | undefined;

	constructor(
		private readonly quiet: boolean,
		/** Injectable so the timed behaviour can be tested without spending it. */
		private readonly now: () => number = Date.now,
	) {}

	handle(event: PipelineEvent): void {
		switch (event.type) {
			case "step_start":
				this.endFanoutLine();
				process.stdout.write(`[${event.index + 1}/${event.total}] ${event.stepId} (${event.kind})\n`);
				break;

			case "fanout_start":
				this.fanoutStartedAt = this.now();
				// Counted from the header, so the first heartbeat lands one interval
				// in rather than on the first item to settle.
				this.lastHeartbeatAt = this.now();
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
					this.fanoutStartedAt === undefined
						? ""
						: remainingLabel(done, event.total, this.now() - this.fanoutStartedAt);
				const line =
					`      ${done}/${event.total} done` +
					(event.failed > 0 ? `, ${event.failed} failed` : "") +
					eta +
					`  (${event.itemId})`;
				if (this.tty) {
					process.stdout.write(`\r\u001b[2K${line}`);
					this.fanoutLine = true;
				} else if (event.error !== undefined || done === event.total || this.dueForHeartbeat()) {
					// Without the heartbeat a redirected run printed nothing between the
					// item count and the final tally. That is the explore pipeline's
					// normal mode — file gates exist so an unattended batch does not hold
					// a session open — and an hour of silence in a log is
					// indistinguishable from a hung process.
					//
					// Timed rather than every Nth item: a hundred papers and a dozen want
					// the same cadence in seconds, not the same count.
					this.lastHeartbeatAt = this.now();
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

	/** True at most once per interval, so a log gets a pulse and not a trace. */
	private dueForHeartbeat(): boolean {
		if (this.lastHeartbeatAt === undefined) return true;
		return this.now() - this.lastHeartbeatAt >= HEARTBEAT_MS;
	}

	// Deliberately does not clear the fan-out's timing state: it is also called
	// for an unrelated log line mid-stage, and resetting the start time there
	// would silently drop the estimate for the rest of the fan-out. `fanout_start`
	// owns that state.
	private endFanoutLine(): void {
		if (!this.fanoutLine) return;
		process.stdout.write("\n");
		this.fanoutLine = false;
	}
}

/**
 * How often a non-terminal run reports fan-out progress.
 *
 * Long enough that a hundred-item stage does not fill a log, short enough that
 * a reader tailing it can tell the run apart from a hang within a coffee break.
 */
const HEARTBEAT_MS = 20_000;

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


export function makeReporter(quiet: boolean, now?: () => number): ProgressReporter {
	return now === undefined ? new ProgressReporter(quiet) : new ProgressReporter(quiet, now);
}
