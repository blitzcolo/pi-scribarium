import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeReporter } from "../../src/cli/commands/run-shared.js";
import type { PipelineEvent } from "../../src/pipeline/engine.js";

/**
 * What a long fan-out actually shows while it runs.
 *
 * The analysis stage is the longest wait in a run — one model call per paper
 * over a hundred-odd papers — so it is the one place progress has to be right,
 * and the one place a silent stretch is most often mistaken for a hang.
 */

let out: string;
let restore: () => void;

function capture(tty: boolean): void {
	out = "";
	const originalWrite = process.stdout.write.bind(process.stdout);
	const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
	Object.defineProperty(process.stdout, "isTTY", { value: tty, configurable: true });
	process.stdout.write = ((chunk: string) => {
		out += chunk;
		return true;
	}) as typeof process.stdout.write;

	restore = () => {
		process.stdout.write = originalWrite;
		if (descriptor === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY;
		else Object.defineProperty(process.stdout, "isTTY", descriptor);
	};
}

afterEach(() => restore?.());

/**
 * A fan-out of `total` items reporting `done` of them, one every `msPerItem`.
 *
 * The clock is injected rather than spent: a heartbeat measured in tens of
 * seconds cannot be exercised by a test that actually waits for it.
 */
function fanout(tty: boolean, total: number, done: number, msPerItem = 9_000): string {
	capture(tty);
	let clock = 1_000_000;
	const reporter = makeReporter(false, () => clock);

	reporter.handle({
		type: "step_start",
		stepId: "analyze",
		index: 7,
		total: 19,
		kind: "foreach",
	} satisfies PipelineEvent);
	reporter.handle({
		type: "fanout_start",
		stepId: "analyze",
		total,
		concurrency: 4,
	} satisfies PipelineEvent);

	for (let i = 1; i <= done; i += 1) {
		clock += msPerItem;
		reporter.handle({
			type: "fanout_progress",
			stepId: "analyze",
			itemId: `paper-${String(i).padStart(2, "0")}`,
			completed: i,
			failed: 0,
			total,
		} satisfies PipelineEvent);
	}
	return out;
}

describe("fan-out progress on a terminal", () => {
	beforeEach(() => {
		restore = () => {};
	});

	it("names the step, the item count, and the concurrency", () => {
		const shown = fanout(true, 100, 1);
		expect(shown).toContain("[8/19] analyze (foreach)");
		expect(shown).toContain("100 items, 4 at a time");
	});

	it("rewrites one line in place rather than scrolling", () => {
		const shown = fanout(true, 100, 5);
		// A carriage return and a clear-line escape per update.
		expect(shown.split("\r").length - 1).toBe(5);
		expect(shown).toContain("5/100 done");
	});

	it("offers a remaining estimate once it has enough history", () => {
		const shown = fanout(true, 100, 5);
		const lines = shown.split("\r");
		expect(lines[1]).not.toContain("~");
		expect(lines[lines.length - 1]).toMatch(/~\d+[smh]/);
	});

	// "No fan-out running" was once sentinelled as 0, which a real clock reading
	// can equal — and when it did, the estimate silently vanished for the whole
	// stage. Production never hit it because Date.now() is never 0, which is
	// exactly the kind of bug that survives until someone changes the clock.
	it("still estimates when the clock starts at zero", () => {
		capture(true);
		let clock = 0;
		const reporter = makeReporter(false, () => clock);

		reporter.handle({ type: "fanout_start", stepId: "analyze", total: 100, concurrency: 4 });
		for (let i = 1; i <= 5; i += 1) {
			clock += 9_000;
			reporter.handle({
				type: "fanout_progress",
				stepId: "analyze",
				itemId: `paper-0${i}`,
				completed: i,
				failed: 0,
				total: 100,
			});
		}

		expect(out).toMatch(/~\d+[smh]/);
	});
});

describe("fan-out progress when output is not a terminal", () => {
	beforeEach(() => {
		restore = () => {};
	});

	// The explore pipeline's whole point is long unattended runs — file gate mode
	// exists so a batch does not hold a session open waiting for a human. Those
	// runs are piped to a log, and a log that says nothing for an hour is
	// indistinguishable from a hung process.
	it("still reports periodically instead of going silent until the end", () => {
		// 12 items at 9s each is nearly two minutes — long enough that a reader
		// tailing the log would otherwise have nothing to look at.
		const shown = fanout(false, 100, 12);
		const progressLines = shown.split("\n").filter((line) => line.includes("done"));

		expect(progressLines.length).toBeGreaterThan(1);
		expect(shown).toContain("~");
	});

	it("does not emit a line for every single item", () => {
		const shown = fanout(false, 100, 12);
		const progressLines = shown.split("\n").filter((line) => line.includes("done"));

		// A line per item would bury the log; the point is a heartbeat, not a trace.
		// 12 items over ~108s at a 20s cadence is five or six lines.
		expect(progressLines.length).toBeLessThan(8);
	});

	// A fast fan-out should not gain a line it did not need.
	it("stays quiet when the whole stage fits inside one interval", () => {
		const shown = fanout(false, 4, 3, 1_000);
		expect(shown.split("\n").filter((line) => line.includes("done"))).toEqual([]);
	});

	it("always reports the final tally", () => {
		const shown = fanout(false, 4, 4, 1_000);
		expect(shown).toContain("4/4 done");
	});
});
