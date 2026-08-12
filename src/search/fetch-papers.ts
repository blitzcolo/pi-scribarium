import * as fs from "node:fs";
import * as path from "node:path";

import { progressLabel } from "../util/progress.js";
import type { Fetcher } from "./http.js";
import type { PaperRecord } from "./types.js";

/**
 * Turn search results into files an agent can read.
 *
 * Open-access PDFs are downloaded; everything else becomes an abstract-only
 * Markdown stub built from the search metadata. Both land in one directory so
 * the ingest builtin and the analysis fan-out see a single uniform corpus and
 * need no special case — the difference survives as an `abstract_only` flag the
 * analyst must record and the judge must weigh.
 *
 * Nothing here is ever re-downloaded: a file that exists is left alone. A run
 * killed halfway through a hundred papers resumes having paid only for what it
 * had not yet fetched.
 */

export type FetchStatus = "downloaded" | "abstract-only" | "failed" | "skipped";

export interface FetchedPaper {
	id: string;
	status: FetchStatus;
	/** Path relative to the fetch directory, for downloaded and stubbed papers. */
	file?: string;
	bytes?: number;
	error?: string;
	points: string[];
	title: string;
}

export interface FetchManifest {
	version: 1;
	updatedAt: string;
	papers: FetchedPaper[];
}

/**
 * Publishers answer a PDF request with an HTML interstitial and HTTP 200 —
 * a cookie wall, a "choose your institution" page. Both the magic bytes and a
 * plausible size have to check out, or ingest would later fail on a file that
 * looks like a paper in the manifest.
 */
const PDF_MAGIC = "%PDF-";

export interface FetchPapersOptions {
	papers: readonly PaperRecord[];
	/** Absolute directory to write into. */
	dir: string;
	fetcher: Fetcher;
	minPdfBytes: number;
	/** Absolute path for the list of papers still without full text. */
	missingList?: string;
	/** How to spell `dir` in that list, which a human reads. */
	dirLabel?: string;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface FetchPapersResult {
	manifest: FetchManifest;
	downloaded: number;
	abstractOnly: number;
	failed: number;
	skipped: number;
	/** Hand-supplied PDFs taken in from `inbox/` this run. */
	adopted: number;
	/** Papers that still have no full text. */
	missing: number;
}

/** Where a human drops PDFs they fetched themselves. */
const INBOX = "inbox";

export async function fetchPapers(options: FetchPapersOptions): Promise<FetchPapersResult> {
	const metaDir = path.join(options.dir, "meta");
	fs.mkdirSync(metaDir, { recursive: true });

	const existing = readManifest(options.dir);
	const entries = new Map(existing.papers.map((entry) => [entry.id, entry]));

	// Before anything is fetched, so a hand-supplied PDF is simply a paper that is
	// already present by the time the loop reaches it.
	const adopted = await adoptInbox(options);

	const total = options.papers.length;
	const startedAt = Date.now();
	let done = 0;

	for (const paper of options.papers) {
		if (options.signal?.aborted === true) break;
		done += 1;
		// Downloads are sequential and rate-limited, so at a hundred papers this
		// runs for minutes with no other sign of life. The counter distinguishes
		// slow from stuck; the estimate says whether to wait for it.
		const where = progressLabel(done, total, Date.now() - startedAt);

		// The sidecar is rewritten every run: it is cheap, and metadata improves as
		// backends update. The PDF beside it is not touched.
		writeSidecar(metaDir, paper);

		const already = findExisting(options.dir, paper.id);
		if (already !== undefined) {
			// The status is derived from what is on disk, never carried forward from
			// the manifest. It used to be carried forward, which was defensible while
			// files only ever appeared by download — but a human can now drop a PDF in
			// for a paper an earlier run recorded as abstract-only, and the stale
			// verdict would have followed it all the way into the evidence packets and
			// the verdict's disclosed counts. The analyst would then be told the paper
			// it is reading in full was never read.
			const previous = entries.get(paper.id);
			const isPdf = already.endsWith(".pdf");
			const bytes = isPdf ? sizeOf(options.dir, already) : undefined;
			// The stub is superseded, and left in place ingest would extract both: the
			// same paper twice in one corpus, one copy stamped as weaker evidence.
			if (isPdf) retireStub(options.dir, paper.id);
			entries.set(paper.id, {
				id: paper.id,
				title: paper.title,
				status: isPdf ? "downloaded" : "abstract-only",
				points: [...new Set([...(previous?.points ?? []), ...paper.points])],
				file: already,
				...(bytes === undefined ? {} : { bytes }),
			});
			options.onProgress?.(`  ${where} skipped   ${paper.id} (already fetched)`);
			continue;
		}

		const entry = await fetchOne(paper, options);
		entries.set(paper.id, entry);
		options.onProgress?.(
			`  ${where} ${entry.status.padEnd(9)} ${paper.id}` +
				(entry.error === undefined ? "" : `: ${entry.error}`),
		);

		// Written after every paper rather than at the end: a kill costs the paper
		// in flight, not the record of the ninety before it.
		writeManifest(options.dir, [...entries.values()]);
	}

	const manifest = writeManifest(options.dir, [...entries.values()]);
	return {
		manifest,
		downloaded: count(manifest, "downloaded"),
		abstractOnly: count(manifest, "abstract-only"),
		failed: count(manifest, "failed"),
		skipped: count(manifest, "skipped"),
		adopted,
		missing: writeMissingList(options, entries),
	};
}

/**
 * Take in PDFs a human fetched by hand.
 *
 * Matching is on the DOI printed on the paper's own first page, so the file can
 * keep whatever name the publisher gave it — `1-s2.0-S0924271618300741-main.pdf`
 * and the like. Requiring the exact `<id>.pdf` instead would mean renaming
 * dozens of files to sixty-character slugs, and a typo there fails silently: the
 * paper simply stays missing.
 *
 * Only the first page is searched. A DOI in a bibliography is a reference to
 * someone else's work, and matching on it would file the wrong paper under an
 * id nobody will re-check. For the same reason a file matching more than one
 * missing paper is left alone and reported rather than guessed at — the rule the
 * gate's own `--keep` follows for an unrecognised id.
 */
async function adoptInbox(options: FetchPapersOptions): Promise<number> {
	const inbox = path.join(options.dir, INBOX);
	let names: string[];
	try {
		names = fs.readdirSync(inbox).filter((name) => name.toLowerCase().endsWith(".pdf"));
	} catch {
		// No inbox at all is the ordinary case, not an error.
		return 0;
	}
	if (names.length === 0) return 0;

	// Lazy, like ingest's own use of it: unpdf carries a pdf.js build, and a run
	// with an empty inbox must not pay for it.
	const { extractPdfPages } = await import("../ingest/pdf.js");

	const claimable = new Map<string, PaperRecord>();
	for (const paper of options.papers) {
		if (fs.existsSync(path.join(options.dir, `${paper.id}.pdf`))) continue;
		if (identifiers(paper).length > 0) claimable.set(paper.id, paper);
	}

	let adopted = 0;
	for (const name of names.sort()) {
		const from = path.join(inbox, name);
		let firstPage: string;
		try {
			firstPage = squash((await extractPdfPages(from))[0] ?? "");
		} catch (cause) {
			options.onProgress?.(`  inbox     ${name}: not a readable PDF (${String(cause)})`);
			continue;
		}

		const hits = [...claimable.values()].filter((paper) =>
			identifiers(paper).some((identifier) => firstPage.includes(identifier)),
		);
		if (hits.length !== 1) {
			const why =
				hits.length === 0
					? "no DOI from the missing list on its first page"
					: `first page carries ${hits.length} of the missing DOIs`;
			options.onProgress?.(`  inbox     ${name}: ${why} — left in ${INBOX}/`);
			continue;
		}

		const paper = hits[0] as PaperRecord;
		fs.renameSync(from, path.join(options.dir, `${paper.id}.pdf`));
		claimable.delete(paper.id);
		adopted += 1;
		options.onProgress?.(`  inbox     ${name} -> ${paper.id}.pdf`);
	}
	return adopted;
}

/** Whitespace and case carry nothing in a DOI, and PDF extraction mangles both. */
function squash(text: string): string {
	return text.replace(/\s+/g, "").toLowerCase();
}

/** Identifiers distinctive enough that finding one on a page identifies the paper. */
function identifiers(paper: PaperRecord): string[] {
	const out: string[] = [];
	const doi = paper.doi?.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "").trim();
	if (doi !== undefined && doi !== "") out.push(squash(doi));
	const arxiv = paper.arxivId?.trim();
	if (arxiv !== undefined && arxiv !== "") out.push(squash(`arXiv:${arxiv}`));
	// A short string would collide with running text; a real DOI is far longer.
	return out.filter((value) => value.length >= 10);
}

/**
 * List what is still missing, for a human to fill in — or to ignore.
 *
 * Deleted when nothing is missing. A list left over from an earlier attempt
 * would reopen the gate on every later run, asking for papers already on disk.
 */
function writeMissingList(
	options: FetchPapersOptions,
	entries: ReadonlyMap<string, FetchedPaper>,
): number {
	const missing = options.papers.filter((paper) => {
		const entry = entries.get(paper.id);
		return entry !== undefined && entry.status !== "downloaded";
	});

	const target = options.missingList;
	if (target === undefined) return missing.length;
	if (missing.length === 0) {
		fs.rmSync(target, { force: true });
		return 0;
	}

	const dir = options.dirLabel ?? path.basename(options.dir);
	const lines = [
		`# Full text missing for ${missing.length} of ${options.papers.length} papers`,
		"",
		"These reached the corpus as abstract-only stubs, or not at all. The analysis",
		"will run without their full text, and the verdict discloses how much of its",
		"evidence was abstract-only.",
		"",
		"**Supplying one is optional.** Approving without doing anything continues the",
		"run with the evidence as it stands.",
		"",
		"To supply a paper, download the PDF and drop it into:",
		"",
		`    ${dir}/${INBOX}/`,
		"",
		"Keep whatever filename the publisher gave it. Each file is matched to its",
		"paper by the DOI printed on its own first page and moved into place. Anything",
		"that cannot be matched is left in the inbox and reported, and can be placed by",
		`hand as \`${dir}/<id>.pdf\` — that path always works.`,
		"",
		"---",
		"",
	];

	for (const [index, paper] of missing.entries()) {
		const entry = entries.get(paper.id) as FetchedPaper;
		const facts = [
			paper.year === undefined ? undefined : String(paper.year),
			paper.venue,
			entry.status === "failed" ? "no abstract either" : "abstract only",
		]
			.filter((part) => part !== undefined && part !== "")
			.join(" · ");

		lines.push(
			`## ${index + 1}. ${paper.title}`,
			"",
			`- ${facts}`,
			...(entry.error === undefined ? [] : [`- why: ${entry.error}`]),
			...(paper.doi === undefined ? [] : [`- https://doi.org/${paper.doi}`]),
			...(paper.arxivId === undefined ? [] : [`- https://arxiv.org/abs/${paper.arxivId}`]),
			`- by hand: \`${dir}/${paper.id}.pdf\``,
			"",
		);
	}

	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${lines.join("\n")}\n`, "utf-8");
	return missing.length;
}

/** Remove an abstract-only stub that a real PDF has replaced. */
function retireStub(dir: string, id: string): void {
	fs.rmSync(path.join(dir, `${id}.md`), { force: true });
}

function sizeOf(dir: string, file: string): number | undefined {
	try {
		return fs.statSync(path.join(dir, file)).size;
	} catch {
		return undefined;
	}
}

async function fetchOne(paper: PaperRecord, options: FetchPapersOptions): Promise<FetchedPaper> {
	const base: FetchedPaper = {
		id: paper.id,
		status: "failed",
		title: paper.title,
		points: paper.points,
	};

	if (paper.pdfUrl !== undefined && paper.pdfUrl !== "") {
		try {
			const bytes = await download(paper.pdfUrl, options);
			const file = `${paper.id}.pdf`;
			fs.writeFileSync(path.join(options.dir, file), bytes);
			return { ...base, status: "downloaded", file, bytes: bytes.byteLength };
		} catch (cause) {
			// A failed download is not the end for this paper: the abstract we already
			// hold still supports a degraded card, which is far better than a gap the
			// judge would read as "nothing published on this".
			const stub = writeStub(paper, options.dir);
			if (stub !== undefined) {
				return { ...base, status: "abstract-only", file: stub, error: String(cause) };
			}
			return { ...base, status: "failed", error: String(cause) };
		}
	}

	const stub = writeStub(paper, options.dir);
	if (stub !== undefined) return { ...base, status: "abstract-only", file: stub };

	// No full text and no abstract. An empty stub would cost a model call to
	// produce a card that says nothing; an honest gap in the coverage count is
	// more useful to whoever reads the verdict.
	return { ...base, status: "failed", error: "no open-access PDF and no abstract" };
}

async function download(url: string, options: FetchPapersOptions): Promise<Uint8Array> {
	const response = await options.fetcher(url);
	if (!response.ok) throw new Error(`HTTP ${response.status}`);

	const bytes = new Uint8Array(await response.arrayBuffer());
	const head = new TextDecoder("latin1").decode(bytes.slice(0, PDF_MAGIC.length));
	if (head !== PDF_MAGIC) {
		throw new Error("response was not a PDF (probably a login or consent page)");
	}
	if (bytes.byteLength < options.minPdfBytes) {
		throw new Error(`PDF was only ${bytes.byteLength} bytes`);
	}
	return bytes;
}

/**
 * Write what we know about a paper we could not download.
 *
 * The banner is not decoration. A card written from an abstract reads exactly
 * like one written from a paper unless the source says otherwise, and the judge
 * weighs the two differently — so the limitation travels with the document.
 */
function writeStub(paper: PaperRecord, dir: string): string | undefined {
	if (paper.abstract === undefined || paper.abstract.trim() === "") return undefined;

	const file = `${paper.id}.md`;
	const meta = [
		paper.authors.length > 0 ? paper.authors.join(", ") : "unknown authors",
		paper.year === undefined ? undefined : String(paper.year),
		paper.venue,
	]
		.filter((part) => part !== undefined && part !== "")
		.join(". ");

	const identifiers = [
		paper.doi === undefined ? undefined : `DOI: ${paper.doi}`,
		paper.arxivId === undefined ? undefined : `arXiv: ${paper.arxivId}`,
	]
		.filter((part) => part !== undefined)
		.join(" — ");

	const body = [
		"---",
		`source: ${file}`,
		`title: ${yamlString(paper.title)}`,
		"abstract_only: true",
		"---",
		"",
		"> **ABSTRACT ONLY** — no open-access full text was available for this paper.",
		"> Everything below comes from search-API metadata. Do not cite page numbers,",
		"> do not describe the method beyond what the abstract states, and do not",
		"> record stated limitations or future work: the paper was not read.",
		"",
		`# ${paper.title}`,
		"",
		meta,
		...(identifiers === "" ? [] : ["", identifiers]),
		"",
		"## Abstract",
		"",
		paper.abstract.trim(),
		"",
	].join("\n");

	fs.writeFileSync(path.join(dir, file), body, "utf-8");
	return file;
}

/** Quote only when the value would otherwise break the frontmatter. */
function yamlString(value: string): string {
	const clean = value.replace(/\s+/g, " ").trim();
	return /^[A-Za-z0-9][^:#\n]*$/.test(clean) ? clean : JSON.stringify(clean);
}

function findExisting(dir: string, id: string): string | undefined {
	for (const extension of [".pdf", ".md"]) {
		if (fs.existsSync(path.join(dir, `${id}${extension}`))) return `${id}${extension}`;
	}
	return undefined;
}

function writeSidecar(metaDir: string, paper: PaperRecord): void {
	// The analyst reads this instead of guessing a citation count or a DOI from
	// memory — the one place those numbers are allowed to come from.
	fs.writeFileSync(
		path.join(metaDir, `${paper.id}.json`),
		`${JSON.stringify(paper, null, "\t")}\n`,
		"utf-8",
	);
}

export function readManifest(dir: string): FetchManifest {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8")) as
			| FetchManifest
			| undefined;
		if (parsed !== undefined && Array.isArray(parsed.papers)) return parsed;
	} catch {
		// A missing or corrupt manifest is not fatal: the files on disk are the
		// real record, and the manifest is rebuilt from them on the next run.
	}
	return { version: 1, updatedAt: new Date().toISOString(), papers: [] };
}

function writeManifest(dir: string, papers: FetchedPaper[]): FetchManifest {
	// Sorted so a second round produces a reviewable diff rather than a reshuffle.
	const sorted = [...papers].sort((a, b) => a.id.localeCompare(b.id));
	const manifest: FetchManifest = {
		version: 1,
		updatedAt: new Date().toISOString(),
		papers: sorted,
	};
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, "manifest.json"),
		`${JSON.stringify(manifest, null, "\t")}\n`,
		"utf-8",
	);
	return manifest;
}

function count(manifest: FetchManifest, status: FetchStatus): number {
	return manifest.papers.filter((paper) => paper.status === status).length;
}
