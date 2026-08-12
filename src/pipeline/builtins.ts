import * as fs from "node:fs";
import * as path from "node:path";

import { checkCitations, formatCitationReport, type CitationReport } from "../checks/citations.js";
import { collateEvidence } from "../checks/evidence.js";
import { collateFollowups } from "../checks/followups.js";
import { buildReferenceIndex } from "../checks/reference-index.js";
import {
	collectCorpusInputs,
	formatPageRanges,
	ingestCorpus,
	parseExtensionFilter,
} from "../ingest/pdf.js";
import { fetchPapers } from "../search/fetch-papers.js";
import { createPoliteFetcher, type FetchNotice, type Fetcher } from "../search/http.js";
import { executeSearch } from "../search/run-search.js";
import type { PaperRecord, QueriesFile, QuerySpec, ResultsFile } from "../search/types.js";
import { formatDuration } from "../util/progress.js";
import type { BuiltinStepSpec } from "./schema.js";

export interface BuiltinContext {
	workspace: string;
	/** Absolute path the step's declared outputs resolve to. */
	resolveOutput: (relativePath: string) => string;
	onProgress?: (message: string) => void;
	/**
	 * HTTP transport for the searching builtins.
	 *
	 * Injected so tests serve fixtures instead of reaching the open internet, and
	 * so the offline builtins can be proven never to have used it. Unset means
	 * the real polite fetcher.
	 */
	fetcher?: Fetcher;
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
		case "search-papers":
			return await runSearchPapers(step, ctx);
		case "fetch-papers":
			return await runFetchPapers(step, ctx);
		case "collate-followups":
			return runCollateFollowups(step, ctx);
		case "collate-evidence":
			return runCollateEvidence(step, ctx);
	}
}

/**
 * Run the planned queries against the search backends.
 *
 * A builtin rather than an agent action: the caps are budget limits, and a
 * budget a model can talk itself past is not a budget. The judgement in this
 * stage — what to search for — already happened in the planner that wrote the
 * query file.
 */
async function runSearchPapers(
	step: BuiltinStepSpec,
	ctx: BuiltinContext,
): Promise<BuiltinResult> {
	const queriesPath = stringOption(step, "queries", "queries.json");
	const out = stringOption(step, "out", "results.json");
	const round = numberOption(step, "round", 1);
	const perQueryLimit = numberOption(step, "per_query_limit", 25);
	const maxTotal = numberOption(step, "max_total", 100);
	const excludePath = optionalString(step, "exclude");

	let queries: QuerySpec[];
	try {
		queries = readQueries(path.resolve(ctx.workspace, queriesPath));
	} catch (cause) {
		return { ok: false, summary: "could not read the query list", error: String(cause) };
	}

	let exclude: PaperRecord[] = [];
	if (excludePath !== undefined) {
		exclude = readResults(path.resolve(ctx.workspace, excludePath)).papers;
	}

	const result = await executeSearch({
		queries,
		fetcher: fetcherFor(ctx),
		perQueryLimit,
		maxTotal,
		exclude,
		...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
	});

	const file: ResultsFile = {
		version: 1,
		round,
		executedAt: new Date().toISOString(),
		queries,
		papers: result.papers,
		warnings: result.warnings,
	};
	writeJson(path.resolve(ctx.workspace, out), file);

	// An empty round is a legitimate outcome, not a failure: a second round whose
	// follow-ups were all pruned should leave the pipeline running.
	const summary = `${result.papers.length} paper(s) from ${queries.length} quer${
		queries.length === 1 ? "y" : "ies"
	} -> ${out}`;

	return result.warnings.length === 0
		? { ok: true, summary }
		: { ok: true, summary, error: result.warnings.join(" ") };
}

/**
 * Download what is open access and stub what is not.
 *
 * Never done by an agent. Downloading is mechanical, and keeping it out of a
 * session means no model can be talked into fetching something the pipeline did
 * not plan for.
 */
async function runFetchPapers(step: BuiltinStepSpec, ctx: BuiltinContext): Promise<BuiltinResult> {
	const resultsPath = stringOption(step, "results", "results.json");
	const dir = stringOption(step, "dir", "refs");
	const minPdfBytes = numberOption(step, "min_pdf_bytes", 10_000);
	// Optional: without it the step simply fetches, as it always did. With it the
	// list becomes the artifact a gate shows, which is why it is deleted rather
	// than emptied when nothing is missing — an optional gate keys off absence.
	const missing = stringOption(step, "missing", "");

	let results: ResultsFile;
	try {
		results = readResults(path.resolve(ctx.workspace, resultsPath));
	} catch (cause) {
		return { ok: false, summary: "could not read the search results", error: String(cause) };
	}

	const outcome = await fetchPapers({
		papers: results.papers,
		dir: path.resolve(ctx.workspace, dir),
		fetcher: fetcherFor(ctx),
		minPdfBytes,
		dirLabel: dir,
		...(missing === "" ? {} : { missingList: ctx.resolveOutput(missing) }),
		...(ctx.onProgress !== undefined ? { onProgress: ctx.onProgress } : {}),
	});

	const summary =
		`${outcome.downloaded} downloaded, ${outcome.abstractOnly} abstract-only, ` +
		`${outcome.failed} unavailable -> ${dir}/` +
		(outcome.adopted === 0 ? "" : `; adopted ${outcome.adopted} from ${dir}/inbox/`);

	// Papers that reached neither full text nor an abstract are surfaced as a
	// warning: they are gaps in the evidence, and a run that hides them lets a
	// verdict of "no precedent" rest on papers nobody read.
	if (outcome.failed > 0) {
		return {
			ok: true,
			summary,
			error: `${outcome.failed} paper(s) had no open-access PDF and no abstract`,
		};
	}
	return { ok: true, summary };
}

/** Collate the follow-up references the analysts named into a round-2 query list. */
function runCollateFollowups(step: BuiltinStepSpec, ctx: BuiltinContext): BuiltinResult {
	const cards = stringOption(step, "cards", "cards");
	const knownPath = stringOption(step, "known", "results-round1.json");
	const out = stringOption(step, "out", "followups.json");
	const summaryPath = stringOption(step, "summary", "followups.md");
	const maxTotal = numberOption(step, "max_total", 150);

	const known = readResults(path.resolve(ctx.workspace, knownPath)).papers;
	const report = collateFollowups({ workspace: ctx.workspace, cards, known, maxTotal });

	const queries: QueriesFile = { version: 1, queries: report.queries };
	writeJson(path.resolve(ctx.workspace, out), queries);
	writeText(path.resolve(ctx.workspace, summaryPath), report.markdown);

	const notes: string[] = [];
	if (report.dropped.length > 0) notes.push(`${report.dropped.length} over the cap`);
	if (report.unreadable.length > 0) notes.push(`${report.unreadable.length} unreadable card(s)`);

	return {
		ok: true,
		summary:
			`${report.kept.length} follow-up reference(s) proposed for round 2 -> ${out}` +
			(notes.length > 0 ? ` (${notes.join(", ")})` : ""),
	};
}

/** Group the cards into one evidence packet per candidate innovation point. */
function runCollateEvidence(step: BuiltinStepSpec, ctx: BuiltinContext): BuiltinResult {
	const outDir = stringOption(step, "out_dir", "evidence");

	let report: ReturnType<typeof collateEvidence>;
	try {
		report = collateEvidence({
			workspace: ctx.workspace,
			cards: stringOption(step, "cards", "cards"),
			candidates: stringOption(step, "candidates", "candidates.json"),
			...optional("manifest", optionalString(step, "manifest")),
			...optional("followups", optionalString(step, "followups")),
			...optional("results", optionalString(step, "results")),
		});
	} catch (cause) {
		return { ok: false, summary: "could not build the evidence packets", error: String(cause) };
	}

	const target = path.resolve(ctx.workspace, outDir);
	fs.mkdirSync(target, { recursive: true });
	for (const packet of report.packets) {
		fs.writeFileSync(path.join(target, `${packet.point}.md`), packet.markdown, "utf-8");
	}

	const empty = report.packets.filter((packet) => packet.cards.length === 0).length;
	const notes: string[] = [];
	if (empty > 0) notes.push(`${empty} with no evidence`);
	if (report.orphaned.length > 0) notes.push(`${report.orphaned.length} card link(s) unmatched`);
	if (report.unreadable.length > 0) notes.push(`${report.unreadable.length} unreadable card(s)`);

	return {
		ok: true,
		summary:
			`${report.packets.length} evidence packet(s) -> ${outDir}/` +
			(notes.length > 0 ? ` (${notes.join(", ")})` : ""),
		...(report.orphaned.length > 0
			? { error: `cards name unknown innovation points: ${report.orphaned.join(", ")}` }
			: {}),
	};
}

function readQueries(file: string): QuerySpec[] {
	const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as { queries?: unknown };
	if (!Array.isArray(parsed.queries)) throw new Error(`${file} must hold a "queries" array`);

	const out: QuerySpec[] = [];
	for (const entry of parsed.queries) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const point = typeof record["point"] === "string" ? record["point"] : "";
		if (point === "") continue;

		const spec: QuerySpec = { kind: record["kind"] === "id" ? "id" : "query", point };
		for (const key of ["query", "doi", "arxivId", "title"] as const) {
			const value = record[key];
			if (typeof value === "string" && value.trim() !== "") spec[key] = value.trim();
		}
		const limit = record["limit"];
		if (typeof limit === "number" && Number.isFinite(limit)) spec.limit = limit;
		out.push(spec);
	}
	return out;
}

/** A missing results file is an empty one: round two may run before round one wrote anything. */
function readResults(file: string): ResultsFile {
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<ResultsFile>;
		if (Array.isArray(parsed.papers)) return parsed as ResultsFile;
	} catch {
		// Fall through to the empty result below.
	}
	return { version: 1, round: 0, executedAt: "", queries: [], papers: [], warnings: [] };
}

function writeJson(target: string, value: unknown): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${JSON.stringify(value, null, "\t")}\n`, "utf-8");
}

function writeText(target: string, value: string): void {
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, value, "utf-8");
}

function stringOption(step: BuiltinStepSpec, key: string, fallback: string): string {
	const value = step.with[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function optionalString(step: BuiltinStepSpec, key: string): string | undefined {
	const value = step.with[key];
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Numeric options arrive as strings.
 *
 * The engine interpolates string values in `with:` but leaves everything else
 * alone, so pipelines write `max_total: "150"` and the parsing happens here.
 */
function numberOption(step: BuiltinStepSpec, key: string, fallback: number): number {
	const value = step.with[key];
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed)) return parsed;
	}
	return fallback;
}

/** `exactOptionalPropertyTypes` rejects an explicit undefined, so omit the key. */
function optional<K extends string>(key: K, value: string | undefined): Record<K, string> | Record<string, never> {
	return value === undefined ? {} : ({ [key]: value } as Record<K, string>);
}

/**
 * The fetcher a searching builtin should use.
 *
 * When one was injected — tests, or a caller with its own transport — it is
 * used as-is. Otherwise a polite one is built here rather than at module load,
 * so its retry notices can be routed into this step's progress output. Without
 * that, a rate-limited run spends up to a minute per attempt in silence, and
 * the operator's reasonable conclusion is that it has hung.
 */
function fetcherFor(ctx: BuiltinContext): Fetcher {
	if (ctx.fetcher !== undefined) return ctx.fetcher;
	return createPoliteFetcher({ onNotice: (notice) => ctx.onProgress?.(describeNotice(notice)) });
}

export function describeNotice(notice: FetchNotice): string {
	const wait = formatDuration(notice.waitMs);
	const host = hostOf(notice.url);
	return notice.kind === "rate-limited"
		? `  rate limited by ${host}; waiting ${wait} as asked ` +
				`(retry ${notice.attempt}/${notice.maxRetries})`
		: `  ${host} did not answer (${notice.reason}); retrying in ${wait} ` +
				`(${notice.attempt}/${notice.maxRetries})`;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
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

	// Which array in the file holds the parts. Defaults to `sections`, so every
	// existing pipeline keeps working; the explore pipeline points it at
	// `candidates` to merge one verdict per innovation point with the same
	// missing-part honesty.
	const listKey = stringOption(step, "path", "sections");

	let sections: Array<{ id?: unknown; title?: unknown }>;
	try {
		const parsed = JSON.parse(fs.readFileSync(sectionsFile, "utf-8")) as Record<
			string,
			Array<{ id?: unknown; title?: unknown }> | undefined
		>;
		sections = parsed[listKey] ?? [];
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
