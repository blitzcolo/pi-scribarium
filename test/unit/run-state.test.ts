import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	findLatestRun,
	hashPipeline,
	newRunId,
	RunLayout,
} from "../../src/workspace/layout.js";
import {
	addUsage,
	emptyUsage,
	EventLog,
	RunStateError,
	RunStateStore,
	type RunState,
} from "../../src/workspace/run-state.js";

let workspace: string;
let layout: RunLayout;
let store: RunStateStore;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-state-"));
	layout = new RunLayout(workspace, "20260809T183000-abcd");
	layout.ensure();
	store = new RunStateStore(layout);
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

function seed(overrides: Partial<RunState> = {}): RunState {
	return RunStateStore.create(layout, {
		runId: layout.runId,
		workspace,
		pipelinePath: "pipelines/paper.yaml",
		pipelineHash: hashPipeline("steps: []"),
		createdAt: new Date().toISOString(),
		status: "running",
		vars: { topic: "emulation" },
		cursor: { stepIndex: 0 },
		steps: {},
		usageTotal: emptyUsage(),
		...overrides,
	});
}

describe("RunStateStore", () => {
	it("round-trips a checkpoint", () => {
		const state = seed();
		state.steps["outline"] = {
			type: "agent",
			status: "completed",
			attempts: 1,
			outputs: ["outline/outline.md"],
			turns: 4,
		};
		store.save(state);

		const loaded = store.load();
		expect(loaded.runId).toBe(layout.runId);
		expect(loaded.vars["topic"]).toBe("emulation");
		expect(loaded.steps["outline"]?.outputs).toEqual(["outline/outline.md"]);
		expect(loaded.updatedAt).toBeTypeOf("string");
	});

	// The property that matters for resume: a process killed mid-write must leave
	// the previous complete checkpoint, never a truncated one. Writing to a temp
	// file and renaming gives that; writeFileSync straight to the target does not.
	// Simulated by making the temp path unwritable, so the write throws exactly
	// where a crash would land — no mocking involved.
	it("leaves the previous checkpoint intact when a write fails midway", () => {
		const state = seed();
		state.steps["first"] = { type: "agent", status: "completed", attempts: 1, outputs: ["a.md"] };
		store.save(state);

		// Occupy the temp path with a directory so writeFileSync fails (EISDIR).
		const tempPath = `${layout.statusFile}.${process.pid}.tmp`;
		fs.mkdirSync(tempPath, { recursive: true });

		state.steps["second"] = { type: "agent", status: "completed", attempts: 1, outputs: ["b.md"] };
		expect(() => store.save(state)).toThrow();

		fs.rmSync(tempPath, { recursive: true, force: true });

		// The committed state is still the previous one, and still parses.
		const loaded = store.load();
		expect(loaded.steps["first"]?.outputs).toEqual(["a.md"]);
		expect(loaded.steps["second"]).toBeUndefined();
	});

	it("never leaves a temp file behind on success", () => {
		seed();
		store.save(store.load());
		const leftovers = fs.readdirSync(layout.runDir).filter((f) => f.endsWith(".tmp"));
		expect(leftovers).toEqual([]);
	});

	it("reports a corrupt or missing checkpoint clearly", () => {
		expect(() => store.load()).toThrow(RunStateError);

		seed();
		fs.writeFileSync(layout.statusFile, '{"runId": "truncated"');
		expect(() => store.load()).toThrow(/not valid JSON/);
	});

	it("refuses a checkpoint from an incompatible schema version", () => {
		const state = seed();
		fs.writeFileSync(layout.statusFile, JSON.stringify({ ...state, schemaVersion: 999 }));
		expect(() => store.load()).toThrow(/incompatible version/);
	});
});

describe("EventLog", () => {
	it("appends events and reads them back in order", () => {
		const log = new EventLog(layout.eventsFile);
		log.append("run_start", { pipeline: "paper.yaml" });
		log.append("step_start", { stepId: "outline" });
		log.append("step_end", { stepId: "outline", status: "completed" });

		const events = log.read();
		expect(events.map((e) => e.type)).toEqual(["run_start", "step_start", "step_end"]);
		expect(events[1]?.["stepId"]).toBe("outline");
		expect(events[0]?.at).toBeTypeOf("string");
	});

	// A killed process can truncate the final line; that must not make the whole
	// log unreadable, since it is the audit trail for a failed run.
	it("skips a partial trailing line from a killed process", () => {
		const log = new EventLog(layout.eventsFile);
		log.append("run_start", {});
		fs.appendFileSync(layout.eventsFile, '{"at":"2026-01-01","type":"step_st');

		expect(log.read().map((e) => e.type)).toEqual(["run_start"]);
	});

	it("returns nothing for a log that does not exist", () => {
		expect(new EventLog(path.join(workspace, "nope.jsonl")).read()).toEqual([]);
	});
});

describe("layout", () => {
	it("generates sortable run ids", () => {
		const a = newRunId(new Date("2026-08-09T18:30:00Z"));
		const b = newRunId(new Date("2026-08-09T18:31:00Z"));
		expect(a).toMatch(/^\d{8}T\d{6}-[0-9a-f]{4}$/);
		expect(a < b).toBe(true);
	});

	it("finds the most recent run and ignores unrelated directories", () => {
		for (const id of ["20260101T000000-aaaa", "20260809T183000-bbbb", "not-a-run"]) {
			fs.mkdirSync(path.join(workspace, "runs", id), { recursive: true });
		}
		expect(findLatestRun(workspace)).toBe("20260809T183000-bbbb");
		expect(findLatestRun(path.join(workspace, "missing"))).toBeUndefined();
	});

	it("hashes a pipeline stably so resume can detect drift", () => {
		expect(hashPipeline("steps: []")).toBe(hashPipeline("steps: []"));
		expect(hashPipeline("steps: []")).not.toBe(hashPipeline("steps: [a]"));
		expect(hashPipeline("x")).toMatch(/^sha256:[0-9a-f]{16}$/);
	});

	it("keeps artifacts inside the run directory", () => {
		expect(layout.artifact("analysis/paper.md")).toBe(
			path.join(layout.runDir, "artifacts", "analysis", "paper.md"),
		);
		expect(layout.logFile("analyze", "paper-01")).toBe(
			path.join(layout.runDir, "logs", "analyze.paper-01.md"),
		);
	});
});

describe("usage arithmetic", () => {
	it("accumulates every token bucket and cost", () => {
		const total = addUsage(
			{ input: 10, output: 5, cacheRead: 1, cacheWrite: 2, total: 18, cost: 0.5 },
			{ input: 20, output: 7, cacheRead: 3, cacheWrite: 4, total: 34, cost: 1.25 },
		);
		expect(total).toEqual({
			input: 30,
			output: 12,
			cacheRead: 4,
			cacheWrite: 6,
			total: 52,
			cost: 1.75,
		});
	});
});
