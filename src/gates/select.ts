import { clearDecision, createFileGate, readDecision } from "./file.js";
import { createInteractiveGate } from "./interactive.js";
import type { GateHandler } from "./types.js";
import type { RunLayout } from "../workspace/layout.js";

/**
 * Choose how gates are answered.
 *
 * Defaults to the terminal when there is one and to the file protocol when
 * there is not, so the same command works interactively and in CI without a
 * flag. A run piped to a log must never block on a prompt nobody can see.
 */
export function selectGate(
	layout: RunLayout,
	options: { autoApprove: boolean; mode?: string },
): GateHandler {
	if (options.autoApprove) return async () => ({ kind: "approve" });
	if (options.mode === "file") return createFileGate(layout);

	const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
	if (options.mode === "interactive" || (options.mode === undefined && interactive)) {
		return withRecordedDecision(layout, createInteractiveGate());
	}
	return createFileGate(layout);
}

/**
 * Honour a decision recorded by `scribarium approve` / `reject` even on a TTY.
 *
 * The decision file was only ever read by the file gate — but the workflow that
 * both `reject` and `run` print, "record a decision, then resume", is normally
 * typed at a terminal, where a TTY selects the interactive gate. The reviewer's
 * `-m "..."` feedback was silently discarded, they were prompted again as though
 * they had said nothing, and the stale decision was left on disk for whichever
 * later run happened to use file mode.
 */
function withRecordedDecision(layout: RunLayout, gate: GateHandler): GateHandler {
	return async (request) => {
		const decision = readDecision(layout, request.step.id);
		if (decision === undefined) return await gate(request);
		// Consumed, so regenerated work is reviewed afresh rather than re-rejected
		// forever by a decision nobody withdrew.
		clearDecision(layout, request.step.id);
		return decision;
	};
}
