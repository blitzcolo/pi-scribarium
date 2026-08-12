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
 * Every identity a record claims, not just its most reliable one.
 *
 * This used to return a single key by precedence — DOI, else arXiv id, else
 * title — and that is what put the same paper in a corpus three times:
 *
 *     doi: 10.24963/ijcai.2022/487       the IJCAI version, from OpenAlex
 *     arxivId: 2205.11876                the preprint, from arXiv
 *     doi: 10.48550/arxiv.2205.11876     the same preprint, from OpenAlex
 *
 * Two failures. The third record's DOI is DataCite's scheme for arXiv preprints
 * and *contains* the arXiv id, so it and the second are provably one file — but
 * precedence filed one under `doi:` and the other under `arxiv:` and they never
 * met. And a record carrying any DOI never reached the title fallback at all, so
 * a preprint could never be recognised as its own published version, which is
 * the most common duplication in this literature.
 *
 * Returning every key and merging on any overlap fixes both. The title key keeps
 * the first author's surname with it, because a bare normalized title would
 * collide on generic ones; it deliberately carries no year, since the whole
 * point is to join a preprint to a paper published the following year.
 */
export function paperKeys(paper: PaperRecord): string[] {
	const keys: string[] = [];

	const arxiv = arxivIdOf(paper);
	if (arxiv !== undefined) keys.push(`arxiv:${arxiv}`);

	const doi = normalizeDoi(paper.doi);
	// An arXiv DOI adds nothing once its id is keyed, and keeping it would make
	// the same preprint match under two spellings depending on the backend.
	if (doi !== undefined && arxivFromDoi(doi) === undefined) keys.push(`doi:${doi}`);

	const title = normalizeTitle(paper.title);
	if (title !== "") keys.push(`title:${title}|${surnameOf(paper.authors[0])}`);

	return keys;
}

/** DOIs are case-insensitive and arrive with and without a resolver prefix. */
function normalizeDoi(doi: string | undefined): string | undefined {
	const clean = doi
		?.trim()
		.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
		.toLowerCase();
	return clean === undefined || clean === "" ? undefined : clean;
}

/** `10.48550/arXiv.2205.11876` is DataCite's DOI for an arXiv preprint. */
function arxivFromDoi(normalizedDoi: string): string | undefined {
	return /^10\.48550\/arxiv\.(.+)$/.exec(normalizedDoi)?.[1];
}

function arxivIdOf(paper: PaperRecord): string | undefined {
	const direct = paper.arxivId?.trim().toLowerCase();
	if (direct !== undefined && direct !== "") return direct;
	const doi = normalizeDoi(paper.doi);
	return doi === undefined ? undefined : arxivFromDoi(doi);
}

function surnameOf(author: string | undefined): string {
	return normalizeTitle(lastName(author));
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
	// Union-find rather than a keyed map, because identity is now a relation
	// rather than a lookup: A and B may share an arXiv id while B and C share a
	// title, which makes all three one paper even though A and C have nothing in
	// common. The root is always the lowest index, so the survivor keeps the
	// position of its first occurrence — the ranking upstream depends on order.
	const parent = papers.map((_, index) => index);
	const find = (index: number): number => {
		let node = index;
		while (parent[node] !== node) {
			parent[node] = parent[parent[node] as number] as number;
			node = parent[node] as number;
		}
		return node;
	};
	const join = (left: number, right: number): void => {
		const a = find(left);
		const b = find(right);
		if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
	};

	const firstSeen = new Map<string, number>();
	papers.forEach((paper, index) => {
		for (const key of paperKeys(paper)) {
			const previous = firstSeen.get(key);
			if (previous === undefined) firstSeen.set(key, index);
			else join(previous, index);
		}
	});

	const out: PaperRecord[] = [];
	const slotOf = new Map<number, number>();
	papers.forEach((paper, index) => {
		const root = find(index);
		const slot = slotOf.get(root);
		if (slot === undefined) {
			slotOf.set(root, out.length);
			out.push({
				...paper,
				backends: [...paper.backends],
				queries: [...paper.queries],
				points: [...paper.points],
			});
			return;
		}
		out[slot] = mergeInto(out[slot] as PaperRecord, paper);
	});

	return out;
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
