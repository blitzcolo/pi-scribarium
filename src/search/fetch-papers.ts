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
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface FetchPapersResult {
	manifest: FetchManifest;
	downloaded: number;
	abstractOnly: number;
	failed: number;
	skipped: number;
}

export async function fetchPapers(options: FetchPapersOptions): Promise<FetchPapersResult> {
	const metaDir = path.join(options.dir, "meta");
	fs.mkdirSync(metaDir, { recursive: true });

	const existing = readManifest(options.dir);
	const entries = new Map(existing.papers.map((entry) => [entry.id, entry]));

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
			// Carry the earlier verdict forward rather than recomputing it: the file
			// on disk is the evidence, and re-deriving `abstract-only` from a stub
			// would need to parse it back.
			const previous = entries.get(paper.id);
			entries.set(paper.id, {
				...(previous ?? {
					id: paper.id,
					status: already.endsWith(".pdf") ? "downloaded" : "abstract-only",
					title: paper.title,
					points: paper.points,
				}),
				points: [...new Set([...(previous?.points ?? []), ...paper.points])],
				file: already,
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
	};
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
