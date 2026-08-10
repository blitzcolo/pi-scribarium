import * as fs from "node:fs";
import * as path from "node:path";

import { checkCitations, formatCitationReport, type CitationReport } from "../checks/citations.js";
import { buildReferenceIndex } from "../checks/reference-index.js";
import {
	collectCorpusInputs,
	formatPageRanges,
	ingestCorpus,
	parseExtensionFilter,
} from "../ingest/pdf.js";
import type { BuiltinStepSpec } from "./schema.js";

export interface BuiltinContext {
	workspace: string;
	/** Absolute path the step's declared outputs resolve to. */
	resolveOutput: (relativePath: string) => string;
	onProgress?: (message: string) => void;
}

export interface BuiltinResult {
	ok: boolean;
	summary: string;
	error?: string;
}

/**
 * Deterministic, non-LLM pipeline steps.
 *
 * These exist so the parts of the pipeline that do not need judgement are not
 * paid for per token, and produce identical output every run. Corpus ingest is
 * the M1 case; the M4 citation checker joins it, deliberately as a builtin so
 * verification cannot be talked out of a finding by a model.
 */
export async function runBuiltin(
	step: BuiltinStepSpec,
	ctx: BuiltinContext,
): Promise<BuiltinResult> {
	switch (step.run) {
		case "ingest":
			return await runIngest(step, ctx);
		case "assemble":
			return assembleSections(step, ctx);
		case "check-citations":
			return runCitationCheck(step, ctx);
		case "build-index":
			return runBuildIndex(step, ctx);
	}
}

/**
 * Collate the reference cards into one scannable index.
 *
 * Deterministic: distilling a paper is judgement work and costs a model call
 * per card, but collating what those calls already produced is not, and paying
 * to re-read several hundred cards every run would cost more than writing them.
 */
function runBuildIndex(step: BuiltinStepSpec, ctx: BuiltinContext): BuiltinResult {
	const from = typeof step.with["from"] === "string" ? step.with["from"] : "references/cards";
	const out = typeof step.with["out"] === "string" ? step.with["out"] : "references/index.md";

	const report = buildReferenceIndex({ workspace: ctx.workspace, from });

	const target = path.resolve(ctx.workspace, out);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, report.markdown, "utf-8");

	// An unreadable card is reported but does not fail the step: the paper is
	// still in the library and still citable, and losing the index over one
	// malformed file would be a worse trade than listing it as needing attention.
	const notes: string[] = [];
	if (report.unreadable.length > 0) notes.push(`${report.unreadable.length} unparseable`);
	if (report.untitled.length > 0) notes.push(`${report.untitled.length} untitled`);

	return {
		ok: true,
		summary:
			`indexed ${report.cards.length} card(s) into ${out}` +
			(notes.length > 0 ? ` (${notes.join(", ")})` : ""),
	};
}

/**
 * Verify that every citation traces to a document in the workspace.
 *
 * A mandatory pipeline stage rather than an optional script: a fabricated
 * reference is the failure that costs the author their credibility rather than
 * their time, so it should be impossible to finish a run without the check
 * having run.
 */
function runCitationCheck(step: BuiltinStepSpec, ctx: BuiltinContext): BuiltinResult {
	const manuscript =
		typeof step.with["manuscript"] === "string" ? step.with["manuscript"] : "final/paper.md";
	const sources = Array.isArray(step.with["sources"])
		? (step.with["sources"] as unknown[]).map(String)
		: ["corpus/text", "analysis/papers", "references/text", "references/cards", "source"];
	const out = typeof step.with["out"] === "string" ? step.with["out"] : "review/citations.md";

	let report: CitationReport;
	try {
		report = checkCitations({ workspace: ctx.workspace, manuscript, sources });
	} catch (cause) {
		return {
			ok: false,
			summary: "could not read the manuscript",
			error: `${manuscript}: ${String(cause)}`,
		};
	}

	const target = path.resolve(ctx.workspace, out);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, formatCitationReport(report), "utf-8");

	const gaps = report.markers.length;
	const summary =
		`${report.citations.length} citation(s) checked, ` +
		`${report.unsupported.length} unsupported, ${gaps} outstanding marker(s) -> ${out}`;

	// Unsupported citations fail the step. Markers do not: they are the author's
	// declared to-do list, and failing on them would punish the honesty the rest
	// of the pipeline is built to encourage.
	if (report.unsupported.length > 0) {
		return {
			ok: false,
			summary,
			error:
				`${report.unsupported.length} citation(s) trace to nothing in the workspace: ` +
				report.unsupported.map((c) => c.raw).join(", ") +
				`. See ${out}.`,
		};
	}
	return { ok: true, summary };
}

/**
 * Concatenate independently drafted sections into one document, in the order the
 * outline declared.
 *
 * Deterministic on purpose. Ordering and concatenation need no judgement, and
 * paying a model to do it would also let it quietly drop or reword a section on
 * the way through.
 */
function assembleSections(step: BuiltinStepSpec, ctx: BuiltinContext): BuiltinResult {
	const sectionsFile = path.resolve(
		ctx.workspace,
		typeof step.with["sections"] === "string" ? step.with["sections"] : "outline/sections.json",
	);
	const fromDir = path.resolve(
		ctx.workspace,
		typeof step.with["from"] === "string" ? step.with["from"] : "draft",
	);
	const target = path.resolve(
		ctx.workspace,
		typeof step.with["out"] === "string" ? step.with["out"] : "draft/paper.md",
	);

	let sections: Array<{ id?: unknown; title?: unknown }>;
	try {
		const parsed = JSON.parse(fs.readFileSync(sectionsFile, "utf-8")) as {
			sections?: Array<{ id?: unknown; title?: unknown }>;
		};
		sections = parsed.sections ?? [];
	} catch (cause) {
		return {
			ok: false,
			summary: "could not read the section list",
			error: `${sectionsFile}: ${String(cause)}`,
		};
	}
	if (sections.length === 0) {
		return { ok: false, summary: "no sections", error: `${sectionsFile} lists no sections` };
	}

	const parts: string[] = [];
	const missing: string[] = [];

	for (const section of sections) {
		const id = typeof section.id === "string" ? section.id : undefined;
		if (id === undefined) {
			// Counted, not skipped silently: dropping it made the summary report
			// "assembled 3/3" for a file that held two, with none of the SECTION
			// MISSING markers the rest of this function relies on to keep gaps visible.
			missing.push(`(entry ${sections.indexOf(section) + 1} has no id)`);
			continue;
		}
		const file = path.join(fromDir, `${id}.md`);
		try {
			parts.push(fs.readFileSync(file, "utf-8").trim());
		} catch {
			// A missing section is recorded in the document rather than skipped:
			// a silent gap would read as a deliberate omission to whoever reviews it.
			missing.push(id);
			const title = typeof section.title === "string" ? section.title : id;
			parts.push(`## ${title}

SECTION MISSING: ${id} was not drafted.`);
		}
	}

	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${parts.join("\n\n")}\n`, "utf-8");

	return {
		ok: true,
		summary:
			`assembled ${sections.length - missing.length}/${sections.length} section(s) into ` +
			path.relative(ctx.workspace, target) +
			(missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""),
	};
}

async function runIngest(step: BuiltinStepSpec, ctx: BuiltinContext): Promise<BuiltinResult> {
	const from = typeof step.with["from"] === "string" ? step.with["from"] : "corpus";
	const force = step.with["force"] === true;
	// `optional` is for directories the author may legitimately leave empty —
	// references/ when they have none, source/ when their material is all
	// Markdown. An empty corpus/ is still a hard failure: there is nothing to
	// profile a venue from.
	const optional = step.with["optional"] === true;
	const only = parseExtensionFilter(step.with["only"]);

	const sourceDir = path.resolve(ctx.workspace, from);
	// Ingest writes into the workspace rather than the run's artifact directory:
	// extracted text is an expensive, reusable property of the corpus, not of a
	// single run, and re-extracting it per run would be pure waste.
	const outDir = path.resolve(
		ctx.workspace,
		typeof step.with["out"] === "string" ? step.with["out"] : path.join(from, "text"),
	);

	const inputs = collectCorpusInputs([sourceDir], only);
	if (inputs.length === 0) {
		const wanted = only === undefined ? ".pdf, .md, .txt, or .tex" : [...only].join(", ");
		if (optional) {
			return { ok: true, summary: `no ${wanted} files under ${from}/ — nothing to extract` };
		}
		return {
			ok: false,
			summary: "no source documents found",
			error: `No ${wanted} files found under ${sourceDir}`,
		};
	}

	const result = await ingestCorpus({
		inputs,
		outDir,
		force,
		onProgress: (file) => {
			const label = path.basename(file.sourcePath);
			if (file.status === "failed") {
				ctx.onProgress?.(`  fail  ${label}: ${file.error}`);
				return;
			}
			// A few pages without a text layer are ordinary — a full-page figure
			// looks exactly like this — but the reader deserves to know which
			// pages the analysis will be blind to.
			const gaps =
				file.textlessPages !== undefined && file.textlessPages.length > 0
					? ` (no text on page ${formatPageRanges(file.textlessPages)})`
					: "";
			ctx.onProgress?.(`  ${file.status.padEnd(9)} ${label}${gaps}`);
		},
	});

	const failures = result.files.filter((file) => file.status === "failed");
	if (failures.length === 0) {
		return {
			ok: true,
			summary: `${result.succeeded} document(s) ready in ${path.relative(ctx.workspace, outDir)}`,
		};
	}

	const detail = `${failures.length} document(s) failed: ${failures
		.map((f) => `${path.basename(f.sourcePath)} (${f.error})`)
		.join("; ")}`;

	// An optional directory isolates per-file failures, matching how a fan-out
	// treats one unreadable paper: at several hundred references, a single scan
	// must not cost the other 399. Losing every file is still fatal — that is a
	// systematic problem, not one bad document. corpus/ stays strict, because it
	// is small, hand-picked, and the profile every later stage rests on.
	if (optional && result.succeeded > 0) {
		return {
			ok: true,
			summary:
				`${result.succeeded} document(s) ready in ${path.relative(ctx.workspace, outDir)}, ` +
				`${failures.length} skipped`,
			error: detail,
		};
	}

	return {
		ok: false,
		summary: `${failures.length} of ${result.files.length} document(s) failed to extract`,
		error: detail,
	};
}
