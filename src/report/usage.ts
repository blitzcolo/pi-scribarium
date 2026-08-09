import type { StageUsage } from "../runtime/run-stage.js";
import { addUsage, emptyUsage, type RunState } from "../workspace/run-state.js";

export interface UsageRow {
	stepId: string;
	status: string;
	model: string;
	turns: number;
	usage: StageUsage;
	durationMs?: number;
}

export interface UsageReport {
	runId: string;
	status: string;
	rows: UsageRow[];
	total: StageUsage;
	/** True when every model in the run priced at zero — a subscription plan. */
	allZeroCost: boolean;
}

export function buildUsageReport(state: RunState): UsageReport {
	const rows: UsageRow[] = [];
	let total = emptyUsage();

	for (const [stepId, step] of Object.entries(state.steps)) {
		const usage = step.usage ?? emptyUsage();
		total = addUsage(total, usage);
		rows.push({
			stepId,
			status: step.status,
			model: step.model ?? "—",
			turns: step.turns ?? 0,
			usage,
			...(step.startedAt !== undefined && step.endedAt !== undefined
				? { durationMs: Date.parse(step.endedAt) - Date.parse(step.startedAt) }
				: {}),
		});
	}

	return {
		runId: state.runId,
		status: state.status,
		rows,
		total,
		allZeroCost: total.total > 0 && total.cost === 0,
	};
}

export function formatUsageReport(report: UsageReport): string {
	const header = ["step", "status", "turns", "input", "output", "cacheR", "cacheW", "cost"];
	const body = report.rows.map((row) => [
		row.stepId,
		row.status,
		String(row.turns),
		String(row.usage.input),
		String(row.usage.output),
		String(row.usage.cacheRead),
		String(row.usage.cacheWrite),
		`$${row.usage.cost.toFixed(4)}`,
	]);
	const totals = [
		"TOTAL",
		report.status,
		String(report.rows.reduce((sum, row) => sum + row.turns, 0)),
		String(report.total.input),
		String(report.total.output),
		String(report.total.cacheRead),
		String(report.total.cacheWrite),
		`$${report.total.cost.toFixed(4)}`,
	];

	const widths = header.map((_, column) =>
		Math.max(header[column]?.length ?? 0, ...[...body, totals].map((r) => (r[column] ?? "").length)),
	);
	const render = (cells: string[]): string =>
		cells.map((cell, i) => (i === 0 ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0))).join("  ");

	const lines = [
		`run ${report.runId}`,
		"",
		render(header),
		widths.map((w) => "-".repeat(w)).join("  "),
		...body.map(render),
		widths.map((w) => "-".repeat(w)).join("  "),
		render(totals),
	];

	if (report.allZeroCost) {
		// Otherwise "$0.0000" reads as "this run was free" when it merely means the
		// provider prices a subscription model at zero in pi's catalog.
		lines.push(
			"",
			"Note: this provider reports zero per-token cost (subscription pricing).",
			"Token counts are real; the cost column is not a measure of spend here.",
		);
	}

	return `${lines.join("\n")}\n`;
}
