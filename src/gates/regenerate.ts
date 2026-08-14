import * as fs from "node:fs";
import * as path from "node:path";

import { contain, type RunLayout } from "../workspace/layout.js";

export interface ArchivedAttempt {
	path: string;
	content: string;
	archivedTo: string;
}

/**
 * Move a step's current artifacts aside before it is re-run.
 *
 * Regeneration overwrites the same paths — a workspace holds one live draft, not
 * a numbered series — so the previous version has to be kept somewhere or a
 * rejected-then-worse second attempt would destroy the better first one with no
 * way back.
 */
export function archiveAttempt(
	layout: RunLayout,
	stepId: string,
	outputs: readonly string[],
	attempt: number,
): ArchivedAttempt[] {
	const archived: ArchivedAttempt[] = [];

	for (const relative of outputs) {
		const source = layout.artifact(relative);
		let content: string;
		try {
			content = fs.readFileSync(source, "utf-8");
		} catch {
			continue; // nothing written last time
		}

		const extension = path.extname(relative);
		const base = path.join(stepId, relative.slice(0, relative.length - extension.length));
		const target = contain(
			layout.attemptsDir,
			`${base}.attempt${attempt}${extension}`,
			"archive",
		);

		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, content, "utf-8");
		archived.push({ path: relative, content, archivedTo: target });
	}

	return archived;
}

/**
 * Build the prompt for a regenerated step.
 *
 * The gate has already disposed the step's session — and in file-gate mode the
 * process has exited — so there is nothing left to steer. Regeneration is a
 * fresh session with the previous attempt and the reviewer's words supplied as
 * context, which is also more reproducible: the same inputs give the same run,
 * and the feedback is in the transcript rather than in a vanished conversation.
 */
export function buildRegeneratePrompt(
	basePrompt: string,
	attempts: readonly ArchivedAttempt[],
	feedback: string,
): string {
	const parts = [basePrompt, "", "## Previous attempt, returned by the reviewer for revision"];

	if (attempts.length === 0) {
		parts.push("", "(The previous attempt produced no output.)");
	} else {
		for (const attempt of attempts) {
			parts.push(
				"",
				`<previous_attempt path="${attempt.path}">`,
				attempt.content.trimEnd(),
				"</previous_attempt>",
			);
		}
	}

	parts.push(
		"",
		"## Reviewer feedback",
		"",
		"<reviewer_feedback>",
		feedback.trim(),
		"</reviewer_feedback>",
		"",
		"Revise your work to address every point of the feedback. Keep everything " +
			"that was not criticised — this is a revision, not a rewrite from scratch. " +
			"Overwrite the same output file(s).",
	);

	return parts.join("\n");
}
