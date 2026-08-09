import { describe, expect, it } from "vitest";

import { TurnBudget } from "../../src/runtime/turn-budget.js";

/** Drive the budget for `n` turns and collect the action taken at each one. */
function actions(budget: TurnBudget, n: number): string[] {
	return Array.from({ length: n }, () => budget.onTurnEnd());
}

describe("TurnBudget", () => {
	it("steers once at the soft limit, then aborts at the hard limit", () => {
		const budget = new TurnBudget(6, 0.5); // soft limit 3

		expect(budget.softLimit).toBe(3);
		expect(actions(budget, 6)).toEqual([
			"continue",
			"continue",
			"steer",
			"continue",
			"continue",
			"abort",
		]);
		expect(budget.turns).toBe(6);
		expect(budget.softWarned).toBe(true);
		expect(budget.exceeded).toBe(true);
	});

	it("steers only once even if more turns elapse before the abort", () => {
		const budget = new TurnBudget(10, 0.2); // soft limit 2
		const taken = actions(budget, 9);

		expect(taken.filter((a) => a === "steer")).toHaveLength(1);
		expect(taken.indexOf("steer")).toBe(1); // zero-based: the 2nd turn
	});

	it("always leaves a turn between the warning and the abort", () => {
		// A ratio of 1.0 would otherwise put the warning on the same turn as the
		// abort, giving the agent nowhere to write its final answer.
		const budget = new TurnBudget(5, 1);
		expect(budget.softLimit).toBe(4);

		const taken = actions(budget, 5);
		expect(taken[3]).toBe("steer");
		expect(taken[4]).toBe("abort");
	});

	it("aborts immediately when only one turn is allowed", () => {
		const budget = new TurnBudget(1, 0.8);
		expect(budget.onTurnEnd()).toBe("abort");
		expect(budget.exceeded).toBe(true);
	});

	it("stays aborted without re-firing if events keep arriving", () => {
		const budget = new TurnBudget(2, 0.5);
		expect(actions(budget, 4)).toEqual(["steer", "abort", "continue", "continue"]);
	});

	it("names the remaining budget in the steer message", () => {
		const budget = new TurnBudget(6, 0.5);
		actions(budget, 3);
		expect(budget.steerMessage()).toContain("3 of 6");
	});

	it.each([
		[0, 0.8],
		[-1, 0.8],
		[2.5, 0.8],
	])("rejects the invalid maxTurns %s", (maxTurns, ratio) => {
		expect(() => new TurnBudget(maxTurns, ratio)).toThrow(RangeError);
	});

	it.each([0, -0.1, 1.5])("rejects the invalid softTurnRatio %s", (ratio) => {
		expect(() => new TurnBudget(10, ratio)).toThrow(RangeError);
	});
});
