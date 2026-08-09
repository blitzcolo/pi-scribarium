import * as fs from "node:fs";
import * as path from "node:path";

import { shippedPipelinesDir } from "../../agents/shipped.js";
import { UsageError } from "../../util/errors.js";

/**
 * Scaffold a workspace.
 *
 * A workspace is one paper. Everything the pipeline needs is a file you put
 * there yourself: the tool has no network access, and the citation-integrity
 * story depends on every reference tracing back to a document you supplied.
 *
 * Three input directories, because they are read for three different reasons.
 * `corpus/` alone defines the venue's norms; folding cited literature into it
 * would distort the structure and evidence bar every later stage is written
 * against, and folding it into `source/` would present other people's results
 * as the author's.
 */
export function commandInit(target: string, force: boolean): number {
	const root = path.resolve(target);

	if (fs.existsSync(path.join(root, "pipeline.yaml")) && !force) {
		throw new UsageError(
			`${root} already looks like a workspace (pipeline.yaml exists). ` +
				"Pass --force to overwrite its pipeline.",
		);
	}

	for (const dir of ["corpus", "references", "source"]) {
		fs.mkdirSync(path.join(root, dir), { recursive: true });
	}

	writeIfAbsent(path.join(root, "corpus", "_README.md"), CORPUS_README, force);
	writeIfAbsent(path.join(root, "references", "_README.md"), REFERENCES_README, force);
	writeIfAbsent(path.join(root, "source", "_README.md"), SOURCE_README, force);
	writeIfAbsent(path.join(root, "README.md"), workspaceReadme(path.basename(root)), force);

	const shippedPipeline = path.join(shippedPipelinesDir(), "paper.yaml");
	const pipeline = fs.existsSync(shippedPipeline)
		? fs.readFileSync(shippedPipeline, "utf-8")
		: FALLBACK_PIPELINE;
	fs.writeFileSync(path.join(root, "pipeline.yaml"), pipeline, "utf-8");

	process.stdout.write(
		`Created workspace ${root}\n\n` +
			"  corpus/      the target venue's papers — what its norms are learned from\n" +
			"  references/  other domain literature — citable, but never profiled\n" +
			"  source/      your own notes, results, an existing draft\n" +
			"  pipeline.yaml\n\n" +
			"Next:\n" +
			`  1. copy 10-30 papers from your target venue into ${path.join(root, "corpus")}\n` +
			`  2. put your own notes and results into ${path.join(root, "source")}\n` +
			`  3. scribarium run --workspace ${root} --var topic="..."\n\n` +
			"Keep corpus/ to one venue. It is where the expected structure, length, and\n" +
			"evidence bar are inferred from, and a paper from elsewhere skews all three.\n" +
			`Relevant work published elsewhere belongs in ${path.join(root, "references")}.\n`,
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
- Scanned PDFs are detected per page. One with no text layer, or with none on
  more than half its pages, is reported as needing OCR (\`ocrmypdf in.pdf
  out.pdf\`) rather than analysed as if it were readable. A few blank pages —
  a full-page figure, say — are noted and extraction continues.

Nothing here is downloaded for you. The tool has no network access, and that is
deliberate: every citation it produces must trace back to a file you put here.
`;

const REFERENCES_README = `# references/

**Domain literature published somewhere other than your target venue.** Work you
want to cite, build on, or argue against.

- Formats: \`.pdf\`, \`.md\`, \`.txt\`, \`.tex\`
- Extracted to \`references/text/\` and indexed by the citation checker, so
  anything here can be cited and will verify.
- **Not** read by the journal profiler. That is the whole point of this
  directory: a paper from the wrong venue would distort the expected structure,
  length, and evidence bar that every later stage is written against.

Each paper gets a short card in \`references/cards/\` — what it does, what its
authors claim is new, what limitations they state, and what it can be cited for
— collated into \`references/index.md\`. That index is how a writer finds
anything once there are more than a handful of papers here.

Cards are cached against the file's timestamp, so adding ten papers to a library
of four hundred analyses ten. \`touch\` a file to force it to be re-read.

Put a paper here when it is relevant to your topic but was not published where
you are submitting. Put it in \`corpus/\` only if it was.
`;

const SOURCE_README = `# source/

**Your own material.** Notes, results, figures described in text, an existing
draft, a related manuscript — anything the outline should be built from.

Only your own work belongs here. Its claims and results are written as yours;
other people's papers go in \`references/\`.

- Formats: \`.pdf\`, \`.md\`, \`.txt\`, \`.tex\`
- PDFs are extracted to \`source/text/\`, because the agents cannot read PDF
  bytes. Files that are already text are read where they are.
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
| \`corpus/\` | Papers from your target venue, to learn its norms from |
| \`references/\` | Domain literature published elsewhere — citable, not profiled |
| \`source/\` | Your own notes, results, and drafts |

Keep \`corpus/\` to a single venue. Relevant work from anywhere else goes in
\`references/\`, where it can be cited without skewing the profile.

## Run it

\`\`\`bash
scribarium run --workspace . --var topic="your topic in a sentence"
\`\`\`

The run stops at \`approve-outline\` for review. Then:

\`\`\`bash
scribarium reject  -m "what to change"   # regenerates the outline with your notes
scribarium approve
scribarium resume
\`\`\`

## What it produces

| Path | What it is |
|---|---|
| \`corpus/text/\` | Extracted text, cached between runs |
| \`references/text/\` | The same, for cited literature |
| \`source/text/\` | The same, for your own PDFs |
| \`references/cards/\` | One short summary card per reference paper |
| \`references/index.md\` | Every reference on one line — grep this first |
| \`analysis/papers/\` | One analysis per corpus paper |
| \`analysis/journal-profile.md\` | What this venue expects |
| \`outline/outline.md\` | The manuscript outline |
| \`outline/sections.json\` | Machine-readable section list |
| \`runs/<id>/\` | Per-run status, logs, transcripts, superseded drafts |

\`scribarium status\` shows where a run got to; \`scribarium report\` shows what it
cost.
`;
}

const FALLBACK_PIPELINE = `version: 1
name: paper
steps:
  - id: ingest
    builtin: ingest
`;
