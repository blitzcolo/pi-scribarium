import { describe, expect, it } from "vitest";

import { buildUsageReport, formatUsageReport } from "../../src/report/usage.js";
import { emptyUsage, type RunState, type StepState } from "../../src/workspace/run-state.js";

function state(steps: Record<string, Partial<StepState>>): RunState {
	return {
		schemaVersion: 1,
		runId: "20260809T110441-adf4",
		workspace: "/ws",
		pipelinePath: "pipeline.yaml",
		pipelineHash: "sha256:abc",
		createdAt: "2026-08-09T11:00:00.000Z",
		updatedAt: "2026-08-09T11:10:00.000Z",
		status: "completed",
		vars: {},
		cursor: { stepIndex: 3 },
		usageTotal: emptyUsage(),
		steps: Object.fromEntries(
			Object.entries(steps).map(([id, partial]) => [
				id,
				{ type: "agent", status: "completed", attempts: 1, outputs: [], ...partial } as StepState,
			]),
		),
	};
}

const usage = (input: number, output: number, cost: number) => ({
	input,
	output,
	cacheRead: 0,
	cacheWrite: 0,
	total: input + output,
	cost,
});

describe("buildUsageReport", () => {
	it("totals every step and keeps per-step detail", () => {
		const report = buildUsageReport(
			state({
				profile: { usage: usage(100, 20, 0.5), turns: 3, model: "p/m" },
				outline: { usage: usage(200, 40, 1.25), turns: 5, model: "p/m" },
			}),
		);

		expect(report.rows).toHaveLength(2);
		expect(report.total.input).toBe(300);
		expect(report.total.cost).toBeCloseTo(1.75);
		expect(report.rows[0]?.stepId).toBe("profile");
	});

	it("counts a builtin step with no usage as zero rather than omitting it", () => {
		const report = buildUsageReport(
			state({ ingest: { type: "builtin" }, profile: { usage: usage(10, 5, 0.1) } }),
		);

		expect(report.rows.map((r) => r.stepId)).toEqual(["ingest", "profile"]);
		expect(report.rows[0]?.usage.total).toBe(0);
	});

	// A subscription model prices at zero in pi's catalog, so "$0.0000" would
	// otherwise read as "this run was free" rather than "cost is not measured
	// here". Real tokens with zero cost is the signal.
	it("flags a run whose provider reports no per-token cost", () => {
		const zeroCost = buildUsageReport(state({ a: { usage: usage(1000, 500, 0) } }));
		expect(zeroCost.allZeroCost).toBe(true);
		expect(formatUsageReport(zeroCost)).toMatch(/subscription pricing/);

		const priced = buildUsageReport(state({ a: { usage: usage(1000, 500, 2.5) } }));
		expect(priced.allZeroCost).toBe(false);
		expect(formatUsageReport(priced)).not.toMatch(/subscription pricing/);
	});

	it("does not flag a run that simply used no tokens", () => {
		expect(buildUsageReport(state({ ingest: { type: "builtin" } })).allZeroCost).toBe(false);
	});
});

describe("formatUsageReport", () => {
	it("renders aligned rows with a total line", () => {
		const text = formatUsageReport(
			buildUsageReport(
				state({
					ingest: { type: "builtin" },
					profile: { usage: usage(6335, 2953, 0.5), turns: 5 },
				}),
			),
		);

		expect(text).toContain("run 20260809T110441-adf4");
		expect(text).toMatch(/step\s+status\s+turns\s+input/);
		expect(text).toMatch(/TOTAL\s+completed\s+5\s+6335/);
	});
});
