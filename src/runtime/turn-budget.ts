/**
 * Userland turn budget.
 *
 * The SDK has no `maxTurns` concept (CLAUDE.md gotcha #4), so the orchestrator
 * enforces one by counting `turn_end` events. The policy is two-stage:
 *
 *   1. at `softLimit` turns, *steer* the agent to stop exploring and write its
 *      output — a cooperative wrap-up that usually still produces a usable
 *      artifact;
 *   2. at `maxTurns`, *abort* the session outright.
 *
 * Extracted as a pure state machine so the policy can be tested without
 * standing up an agent session.
 */

export type BudgetAction = "continue" | "steer" | "abort";

export class TurnBudget {
	readonly maxTurns: number;
	readonly softLimit: number;

	private count = 0;
	private steered = false;
	private aborted = false;

	constructor(maxTurns: number, softTurnRatio: number) {
		if (!Number.isInteger(maxTurns) || maxTurns < 1) {
			throw new RangeError(`maxTurns must be a positive integer, got ${maxTurns}`);
		}
		if (!(softTurnRatio > 0) || softTurnRatio > 1) {
			throw new RangeError(`softTurnRatio must be in (0, 1], got ${softTurnRatio}`);
		}
		this.maxTurns = maxTurns;
		// Always leave at least one turn between the warning and the abort, so a
		// steered agent has somewhere to put its final answer.
		this.softLimit = Math.min(Math.max(1, Math.floor(maxTurns * softTurnRatio)), maxTurns - 1 || 1);
	}

	get turns(): number {
		return this.count;
	}

	get softWarned(): boolean {
		return this.steered;
	}

	get exceeded(): boolean {
		return this.aborted;
	}

	/** Record one completed turn and decide what the runner should do next. */
	onTurnEnd(): BudgetAction {
		this.count++;

		if (this.count >= this.maxTurns) {
			if (this.aborted) return "continue";
			this.aborted = true;
			return "abort";
		}

		if (this.count >= this.softLimit && !this.steered) {
			this.steered = true;
			return "steer";
		}

		return "continue";
	}

	/** The wrap-up instruction delivered when the soft limit is reached. */
	steerMessage(): string {
		return (
			`Budget notice: you have used ${this.count} of ${this.maxTurns} allowed turns. ` +
			"Stop exploring now. Write your final output file(s), then reply with a short " +
			"summary of what you wrote and where."
		);
	}
}
