/**
 * Literature search across arXiv, Semantic Scholar and OpenAlex.
 *
 * The rest of the project reads only what the author put in the workspace. This
 * module is the one place that talks to the open internet, and it is deliberately
 * small, deterministic in its output, and free of any SDK import: everything it
 * produces lands on disk as JSON so a resumed run never pays for the same query
 * or download twice.
 *
 * Google Scholar is absent on purpose. It has no API, scraping it violates its
 * terms, and the alternatives below index substantially the same English-language
 * literature while returning abstracts and open-access links we are allowed to use.
 */

export type SearchBackend = "arxiv" | "semanticscholar" | "openalex";

export const SEARCH_BACKENDS: readonly SearchBackend[] = ["arxiv", "semanticscholar", "openalex"];

/**
 * One paper, merged across every backend that returned it.
 *
 * `id` is assigned once, after dedupe, and then names everything downstream: the
 * downloaded `<id>.pdf`, the extracted `text/<id>.md`, and the analyst's
 * `cards/<id>.md`. It has to be stable across runs for the fan-out cache and
 * resume to match an output to its source.
 */
export interface PaperRecord {
	id: string;
	title: string;
	authors: string[];
	year?: number;
	venue?: string;
	abstract?: string;
	/** Normalized: lowercase, without the `https://doi.org/` prefix. */
	doi?: string;
	/** Normalized: without the version suffix, so `2401.01234v2` and `v3` merge. */
	arxivId?: string;
	s2Id?: string;
	openAlexId?: string;
	citationCount?: number;
	/** Best open-access PDF found. Absent means abstract-only from here on. */
	pdfUrl?: string;
	/** Which backends returned this paper; a merge unions them. */
	backends: SearchBackend[];
	/** Which queries surfaced it, for the audit trail in the results file. */
	queries: string[];
	/** Candidate innovation-point ids this paper was searched for. */
	points: string[];
}

/**
 * One thing to look up.
 *
 * `kind: "query"` is free-text search — the round-1 case. `kind: "id"` is a
 * direct lookup of a paper an analyst named in its follow-up references, where
 * we already know the DOI or arXiv id and a text search would only add noise.
 */
export interface QuerySpec {
	kind: "query" | "id";
	/** Candidate innovation-point id this lookup serves, e.g. `ip-1`. */
	point: string;
	/** `kind: "query"`: the search text. Must be English. */
	query?: string;
	doi?: string;
	arxivId?: string;
	/** `kind: "id"` fallback when no identifier is known: search by exact title. */
	title?: string;
	limit?: number;
}

export interface QueriesFile {
	version: 1;
	queries: QuerySpec[];
}

export interface ResultsFile {
	version: 1;
	round: number;
	executedAt: string;
	queries: QuerySpec[];
	papers: PaperRecord[];
	/**
	 * Backends that failed, caps that truncated, entries that were dropped.
	 *
	 * Surfaced rather than thrown: one dead backend out of three should narrow a
	 * search, not end a run that has already been paid for.
	 */
	warnings: string[];
}

/** A single backend's answer. Failure is a value here, never an exception. */
export interface BackendResult {
	backend: SearchBackend;
	papers: PaperRecord[];
	/** Set when the backend could not be reached or returned something unusable. */
	error?: string;
}
