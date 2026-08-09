import { createFileGate } from "./file.js";
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
	if (options.mode === "interactive") return createInteractiveGate();
	return process.stdin.isTTY === true && process.stdout.isTTY === true
		? createInteractiveGate()
		: createFileGate(layout);
}
