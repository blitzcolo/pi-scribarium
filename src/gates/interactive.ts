import * as fs from "node:fs";
import * as readline from "node:readline/promises";

import type { SelectableItem } from "./keep.js";
import type { GateDecision, GateHandler, GateRequest } from "./types.js";

const PREVIEW_LINES = 30;

/**
 * Terminal gate.
 *
 * Uses `node:readline/promises` and plain text — no alternate screen, no cursor
 * addressing — so it behaves the same over SSH in a bare terminal as it does
 * locally. The preview is deliberately short: enough to recognise whether the
 * artifact is roughly right, not a substitute for opening it.
 */
export function createInteractiveGate(): GateHandler {
	return async (request: GateRequest): Promise<GateDecision> => {
		const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
		try {
			printSummary(request);

			const selectable = request.selectable;
			const canKeep = selectable !== undefined && selectable.items.length > 0;
			const prompt = canKeep
				? "\n[a]pprove all  [k]eep some  [r]eject  [s]kip  [q]uit  [v]iew again > "
				: "\n[a]pprove  [r]eject  [s]kip  [q]uit  [v]iew again > ";

			for (;;) {
				const answer = (await rl.question(prompt)).trim().toLowerCase();

				switch (answer) {
					case "a":
					case "approve":
						return { kind: "approve" };

					case "k":
					case "keep": {
						if (!canKeep) {
							process.stdout.write("This gate has no list to prune.\n");
							break;
						}
						const keep = await readKeep(rl, selectable.items);
						if (keep === undefined) break;
						return { kind: "approve", keep };
					}

					case "s":
					case "skip":
						return { kind: "skip" };

					case "q":
					case "quit":
					case "abort":
						return { kind: "abort" };

					case "v":
					case "view":
						printSummary(request);
						break;

					case "r":
					case "reject": {
						const feedback = await readFeedback(rl);
						if (feedback.length === 0) {
							process.stdout.write("Rejection needs a reason; nothing recorded.\n");
							break;
						}
						return {
							kind: "reject",
							feedback,
							...(request.step.onReject !== undefined ? { target: request.step.onReject } : {}),
						};
					}

					default:
						process.stdout.write(`Please answer a, ${canKeep ? "k, " : ""}r, s, q, or v.\n`);
				}
			}
		} finally {
			rl.close();
		}
	};
}

function printSummary(request: GateRequest): void {
	const rule = "─".repeat(60);
	process.stdout.write(`\n${rule}\n${request.step.title}\n${rule}\n`);

	if (request.artifacts.length === 0) {
		process.stdout.write("\n(no artifacts declared for review)\n");
	}

	for (const artifact of request.artifacts) {
		if (!artifact.exists) {
			process.stdout.write(`\n${artifact.path}  — MISSING\n`);
			continue;
		}
		process.stdout.write(`\n${artifact.path}  (${formatBytes(artifact.bytes)})\n`);
		process.stdout.write(`${artifact.absolutePath}\n\n`);

		const lines = fs.readFileSync(artifact.absolutePath, "utf-8").split("\n");
		for (const line of lines.slice(0, PREVIEW_LINES)) process.stdout.write(`  │ ${line}\n`);
		if (lines.length > PREVIEW_LINES) {
			process.stdout.write(`  │ … ${lines.length - PREVIEW_LINES} more lines\n`);
		}
	}

	// Cost so far is shown because the decision that follows — regenerate or
	// accept — is partly an economic one.
	const { total, cost } = request.usageSoFar;
	process.stdout.write(`\nSpent so far: ${total} tokens, $${cost.toFixed(4)}\n`);
}

/**
 * Read the ids to keep, checked against the list before the run moves on.
 *
 * Validated here as well as in the engine because a typo caught at the prompt
 * costs one retyped line, and the same typo caught later costs the run: the
 * decision has been consumed by then and the reviewer has to start the whole
 * approve-and-resume cycle again.
 *
 * Returns undefined when the reviewer changes their mind, which returns them to
 * the menu rather than approving something they did not choose.
 */
async function readKeep(
	rl: readline.Interface,
	items: readonly SelectableItem[],
): Promise<string[] | undefined> {
	process.stdout.write("\nEntries in this list:\n\n");
	for (const item of items) {
		const label = item.label === undefined ? "" : `  ${truncate(item.label, 68)}`;
		process.stdout.write(`  ${item.id}${label}\n`);
	}
	process.stdout.write("\nKeep which? Comma-separated ids; blank to cancel.\n");

	for (;;) {
		const answer = (await rl.question("keep > ")).trim();
		if (answer === "") return undefined;

		const requested = answer
			.split(",")
			.map((id) => id.trim())
			.filter((id) => id.length > 0);

		const known = new Set(items.map((item) => normalizeId(item.id)));
		const unknown = requested.filter((id) => !known.has(normalizeId(id)));
		if (unknown.length > 0) {
			process.stdout.write(`Not in the list: ${unknown.join(", ")}. Try again.\n`);
			continue;
		}
		if (requested.length === 0) return undefined;

		const dropped = items.length - new Set(requested.map(normalizeId)).size;
		if (dropped > 0) {
			const confirm = (
				await rl.question(`Delete ${dropped} of ${items.length} and continue? [y/N] `)
			)
				.trim()
				.toLowerCase();
			if (confirm !== "y" && confirm !== "yes") continue;
		}
		return requested;
	}
}

/** Matches `slug()` closely enough to catch a typo; the engine does it properly. */
function normalizeId(id: string): string {
	return id.trim().toLowerCase();
}

function truncate(value: string, limit: number): string {
	return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

/** Multi-line feedback, terminated by a lone "." so paragraphs are possible. */
async function readFeedback(rl: readline.Interface): Promise<string> {
	process.stdout.write("\nWhat should change? End with a single '.' on its own line.\n");
	const lines: string[] = [];
	for (;;) {
		const line = await rl.question("| ");
		if (line.trim() === ".") break;
		lines.push(line);
	}
	return lines.join("\n").trim();
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(1)} KB`;
}
