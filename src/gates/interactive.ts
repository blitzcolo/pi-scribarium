import * as fs from "node:fs";
import * as readline from "node:readline/promises";

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

			for (;;) {
				const answer = (
					await rl.question("\n[a]pprove  [r]eject  [s]kip  [q]uit  [v]iew again > ")
				)
					.trim()
					.toLowerCase();

				switch (answer) {
					case "a":
					case "approve":
						return { kind: "approve" };

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
						process.stdout.write("Please answer a, r, s, q, or v.\n");
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
