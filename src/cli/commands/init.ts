import * as fs from "node:fs";
import * as path from "node:path";

import { shippedAgentsDir } from "../../agents/discover.js";
import { UsageError } from "../../util/errors.js";

/**
 * Scaffold a workspace.
 *
 * A workspace is one paper. Everything the pipeline needs is a file you put
 * there yourself: the tool has no network access, and the citation-integrity
 * story depends on every reference tracing back to a document in `corpus/`.
 */
export function commandInit(target: string, force: boolean): number {
	const root = path.resolve(target);

	if (fs.existsSync(path.join(root, "pipeline.yaml")) && !force) {
		throw new UsageError(
			`${root} already looks like a workspace (pipeline.yaml exists). ` +
				"Pass --force to overwrite its pipeline.",
		);
	}

	for (const dir of ["corpus", "source"]) {
		fs.mkdirSync(path.join(root, dir), { recursive: true });
	}

	writeIfAbsent(path.join(root, "corpus", "_README.md"), CORPUS_README, force);
	writeIfAbsent(path.join(root, "source", "_README.md"), SOURCE_README, force);
	writeIfAbsent(path.join(root, "README.md"), workspaceReadme(path.basename(root)), force);

	const shippedPipeline = path.join(shippedAgentsDir(), "..", "pipelines", "paper.yaml");
	const pipeline = fs.existsSync(shippedPipeline)
		? fs.readFileSync(shippedPipeline, "utf-8")
		: FALLBACK_PIPELINE;
	fs.writeFileSync(path.join(root, "pipeline.yaml"), pipeline, "utf-8");

	process.stdout.write(
		`Created workspace ${root}\n\n` +
			"  corpus/    put the target journal's papers here (.pdf, .md, .txt, .tex)\n" +
			"  source/    put your own material here: notes, results, an existing draft\n" +
			"  pipeline.yaml\n\n" +
			"Next:\n" +
			`  1. copy 10-30 papers from your target journal into ${path.join(root, "corpus")}\n` +
			`  2. put your own notes and results into ${path.join(root, "source")}\n` +
			`  3. scholarly run --workspace ${root} --var topic="..."\n`,
	);
	return 0;
}

function writeIfAbsent(file: string, content: string, force: boolean): void {
	if (fs.existsSync(file) && !force) return;
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content, "utf-8");
}

const CORPUS_README = `# corpus/

Papers **from the journal you intend to submit to**. The pipeline reads these to
work out what that venue publishes and how it expects work to be written.

- Formats: \`.pdf\`, \`.md\`, \`.txt\`, \`.tex\`
- Aim for 10-30 recent papers. Two is enough to run; it is not enough to
  generalise from, and the profile will say so.
- Scanned PDFs with no text layer are reported as needing OCR rather than
  analysed as empty.

Nothing here is downloaded for you. The tool has no network access, and that is
deliberate: every citation it produces must trace back to a file you put here.
`;

const SOURCE_README = `# source/

**Your own material.** Notes, results, figures described in text, an existing
draft, a related manuscript — anything the outline should be built from.

- Formats: \`.pdf\`, \`.md\`, \`.txt\`, \`.tex\`
- If you have no results yet, that is fine: the outliner marks each place
  evidence is needed with \`EVIDENCE NEEDED\` rather than inventing findings.
  Those markers are the point — they tell you what is still missing.
`;

function workspaceReadme(name: string): string {
	return `# ${name}

A pi-scribarium workspace. One workspace is one paper.

## What you provide

| Directory | What goes in it |
|---|---|
| \`corpus/\` | Papers from your target journal, to learn its norms from |
| \`source/\` | Your own notes, results, and drafts |

## Run it

\`\`\`bash
scholarly run --workspace . --var topic="your topic in a sentence"
\`\`\`

The run stops at \`approve-outline\` for review. Then:

\`\`\`bash
scholarly reject  -m "what to change"   # regenerates the outline with your notes
scholarly approve
scholarly resume
\`\`\`

## What it produces

| Path | What it is |
|---|---|
| \`corpus/text/\` | Extracted text, cached between runs |
| \`analysis/papers/\` | One analysis per corpus paper |
| \`analysis/journal-profile.md\` | What this venue expects |
| \`outline/outline.md\` | The manuscript outline |
| \`outline/sections.json\` | Machine-readable section list |
| \`runs/<id>/\` | Per-run status, logs, transcripts, superseded drafts |

\`scholarly status\` shows where a run got to; \`scholarly report\` shows what it
cost.
`;
}

const FALLBACK_PIPELINE = `version: 1
name: paper
steps:
  - id: ingest
    builtin: ingest
`;
