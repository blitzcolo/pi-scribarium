import { slug, uniqueSlug } from "../util/slug.js";
import type { PaperRecord } from "./types.js";

/**
 * Merge the same paper as three backends describe it.
 *
 * Three indexes over overlapping literature return the same work under a
 * preprint id, a DOI, and a slightly different title. Without a merge the corpus
 * holds it three times: three downloads, three model calls, and three cards that
 * the judge then reads as three independent pieces of evidence — which would
 * inflate exactly the "this has been done" signal the pipeline exists to measure.
 */

/**
 * Identity, most reliable first.
 *
 * A DOI is assigned by the publisher and is the same string everywhere. An arXiv
 * id is stable once versions are stripped. A normalized title is a guess: it
 * misses a paper retitled between preprint and proceedings, and would collide on
 * two genuinely different papers sharing a generic title — so it is the last
 * resort, and the cost of a miss is one duplicate card rather than a wrong merge.
 */
export function paperKey(paper: PaperRecord): string {
	if (paper.doi !== undefined && paper.doi !== "") return `doi:${paper.doi}`;
	if (paper.arxivId !== undefined && paper.arxivId !== "") return `arxiv:${paper.arxivId}`;
	return `title:${normalizeTitle(paper.title)}`;
}

export function normalizeTitle(title: string): string {
	return title
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "")
		.trim();
}

/**
 * Fold duplicates together, keeping the richest value for every field.
 *
 * Input order decides the base record, so callers pass backends in a fixed
 * order and the result is the same on every run.
 */
export function mergeRecords(papers: readonly PaperRecord[]): PaperRecord[] {
	const merged = new Map<string, PaperRecord>();

	for (const paper of papers) {
		const key = paperKey(paper);
		const existing = merged.get(key);
		if (existing === undefined) {
			merged.set(key, { ...paper, backends: [...paper.backends], queries: [...paper.queries], points: [...paper.points] });
			continue;
		}
		merged.set(key, mergeInto(existing, paper));
	}

	return [...merged.values()];
}

function mergeInto(base: PaperRecord, extra: PaperRecord): PaperRecord {
	const result: PaperRecord = {
		...base,
		backends: union(base.backends, extra.backends),
		queries: union(base.queries, extra.queries),
		points: union(base.points, extra.points),
		// A longer title is usually the un-truncated one; a longer abstract is
		// usually the full one rather than a teaser.
		title: extra.title.length > base.title.length ? extra.title : base.title,
		authors: extra.authors.length > base.authors.length ? extra.authors : base.authors,
	};

	if (result.abstract === undefined || (extra.abstract ?? "").length > result.abstract.length) {
		if (extra.abstract !== undefined) result.abstract = extra.abstract;
	}
	if (result.year === undefined && extra.year !== undefined) result.year = extra.year;
	if (result.venue === undefined && extra.venue !== undefined) result.venue = extra.venue;
	if (result.doi === undefined && extra.doi !== undefined) result.doi = extra.doi;
	if (result.arxivId === undefined && extra.arxivId !== undefined) result.arxivId = extra.arxivId;
	if (result.s2Id === undefined && extra.s2Id !== undefined) result.s2Id = extra.s2Id;
	if (result.openAlexId === undefined && extra.openAlexId !== undefined) {
		result.openAlexId = extra.openAlexId;
	}
	// Citation counts differ per index; the larger one is the better-connected
	// index rather than an error, and it is only ever used for ranking.
	if (extra.citationCount !== undefined) {
		result.citationCount = Math.max(result.citationCount ?? 0, extra.citationCount);
	}
	if (result.pdfUrl === undefined && extra.pdfUrl !== undefined) result.pdfUrl = extra.pdfUrl;

	return result;
}

function union<T>(left: readonly T[], right: readonly T[]): T[] {
	return [...new Set([...left, ...right])];
}

/**
 * Name every paper, stably.
 *
 * `surname-year-first-words-of-title` reads well in a directory listing and in a
 * card filename, which matters because a human greps these. Collisions get a
 * numeric suffix, so the input must already be in a deterministic order.
 */
export function assignIds(papers: readonly PaperRecord[]): PaperRecord[] {
	const used = new Set<string>();
	return papers.map((paper) => ({ ...paper, id: uniqueSlug(candidateId(paper), used) }));
}

function candidateId(paper: PaperRecord): string {
	const surname = lastName(paper.authors[0]);
	const year = paper.year === undefined ? "" : String(paper.year);
	const words = paper.title.split(/\s+/).filter((word) => word.length > 0).slice(0, 4).join(" ");
	const base = [surname, year, words].filter((part) => part !== "").join(" ");
	// `paper` rather than `item`: these all live in one directory, and a fallback
	// that reads as a filename is easier to spot when metadata was missing.
	return slug(base, "paper");
}

function lastName(author: string | undefined): string {
	if (author === undefined || author.trim() === "") return "";
	// "Jane Q. Doe" and "Doe, Jane" both yield "Doe".
	const commaForm = author.split(",", 1)[0]?.trim() ?? "";
	if (author.includes(",")) return commaForm;
	const parts = author.trim().split(/\s+/);
	return parts[parts.length - 1] ?? "";
}
