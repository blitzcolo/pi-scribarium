import { describe, expect, it } from "vitest";

import { formatDuration, progressLabel } from "../../src/util/progress.js";

describe("formatDuration", () => {
	it("keeps to two units", () => {
		expect(formatDuration(45_000)).toBe("45s");
		expect(formatDuration(90_000)).toBe("1m30s");
		expect(formatDuration(120_000)).toBe("2m");
		expect(formatDuration(3_600_000)).toBe("1h");
		expect(formatDuration(3_900_000)).toBe("1h05m");
	});

	it("does not render a negative or absurd value", () => {
		expect(formatDuration(-5)).toBe("0s");
		expect(formatDuration(0)).toBe("0s");
	});
});

describe("progressLabel", () => {
	it("always shows the counter", () => {
		expect(progressLabel(1, 100, 1000)).toBe("[1/100]");
		expect(progressLabel(50, 100, 60_000)).toContain("[50/100]");
	});

	// The first item carries one-off costs — a cold connection, a session being
	// built — so extrapolating from it overstates the remainder badly.
	it("withholds an estimate until it would be honest", () => {
		expect(progressLabel(1, 100, 10_000)).not.toContain("~");
		expect(progressLabel(2, 100, 20_000)).not.toContain("~");
		expect(progressLabel(3, 100, 30_000)).toContain("~");
	});

	it("extrapolates from the mean rate", () => {
		// 10 done in 100s is 10s each; 90 left is 900s.
		expect(progressLabel(10, 100, 100_000)).toBe("[10/100] ~15m left");
	});

	it("says nothing about time once everything is done", () => {
		expect(progressLabel(100, 100, 100_000)).toBe("[100/100]");
	});
});
