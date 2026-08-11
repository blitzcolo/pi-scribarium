import { searchArxiv } from "./arxiv.js";
import { assignIds, mergeRecords, paperKey } from "./dedupe.js";
import type { Fetcher } from "./http.js";
import { searchOpenAlex } from "./openalex.js";
import { searchSemanticScholar } from "./semantic-scholar.js";
import type { BackendResult, PaperRecord, QuerySpec, SearchBackend } from "./types.js";

/**
 * Run every query against every backend, then merge, rank and cap.
 *
 * The cap is enforced here, in deterministic code, and never by a model: a
 * budget a model can talk itself past is not a budget. Round two passes the
 * round-one results as `exclude` and the same total cap, so the two rounds
 * together cannot exceed what the pipeline declared.
 */

export interface ExecuteSearchOptions {
	queries: readonly QuerySpec[];
	fetcher: Fetcher;
	/** Results requested per query per backend. */
	perQueryLimit: number;
	/** Ceiling on papers returned, after excluded ones are removed. */
	maxTotal: number;
	/** Papers already known — round one's results, when running round two. */
	exclude?: readonly PaperRecord[];
	/** Overridable per backend so tests can point at a fixture server. */
	baseUrls?: Partial<Record<SearchBackend, string>>;
	onProgress?: (message: string) => void;
}

export interface ExecuteSearchResult {
	papers: PaperRecord[];
	warnings: string[];
}

export async function executeSearch(options: ExecuteSearchOptions): Promise<ExecuteSearchResult> {
	const warnings: string[] = [];
	const excluded = new Set((options.exclude ?? []).map((paper) => paperKey(paper)));

	/** Query index -> its papers, so the cap can be spread across queries. */
	const perQuery: PaperRecord[][] = [];
	/** Backends that failed at least once, counted rather than listed per query. */
	const backendFailures = new Map<SearchBackend, number>();

	for (const [index, spec] of options.queries.entries()) {
		const label = describeQuery(spec);
		options.onProgress?.(`  search  ${label}`);

		// Backends run in parallel: the polite fetcher serializes per host, so
		// three hosts genuinely overlap and arXiv's three-second floor does not
		// set the pace for the other two.
		const results = await Promise.all([
			searchArxiv(spec, options.perQueryLimit, {
				fetcher: options.fetcher,
				...url(options, "arxiv"),
			}),
			searchSemanticScholar(spec, options.perQueryLimit, {
				fetcher: options.fetcher,
				...url(options, "semanticscholar"),
			}),
			searchOpenAlex(spec, options.perQueryLimit, {
				fetcher: options.fetcher,
				...url(options, "openalex"),
			}),
		]);

		const found: PaperRecord[] = [];
		for (const result of results) {
			if (result.error !== undefined) {
				backendFailures.set(result.backend, (backendFailures.get(result.backend) ?? 0) + 1);
				continue;
			}
			found.push(...result.papers);
		}

		if (found.length === 0 && every(results, (r) => r.error !== undefined)) {
			warnings.push(`No backend answered for ${label}.`);
		}
		perQuery[index] = found;
	}

	for (const [backend, count] of [...backendFailures].sort((a, b) => a[0].localeCompare(b[0]))) {
		warnings.push(
			`${backend} failed on ${count} of ${options.queries.length} quer${
				options.queries.length === 1 ? "y" : "ies"
			}; results are narrower than they look.`,
		);
	}

	// Merge within each query first so the round-robin below distributes distinct
	// papers, then merge globally so a paper found by two queries is one record
	// carrying both.
	const ranked = rankAcrossQueries(perQuery.map((papers) => rankOne(mergeRecords(papers))));

	const kept: PaperRecord[] = [];
	let dropped = 0;
	for (const paper of ranked) {
		if (excluded.has(paperKey(paper))) {
			dropped += 1;
			continue;
		}
		kept.push(paper);
	}

	const capped = kept.slice(0, Math.max(0, options.maxTotal));
	if (capped.length < kept.length) {
		// Stated rather than silent: a truncated search that reads as exhaustive is
		// how "no precedent found" becomes a false claim later in the report.
		warnings.push(
			`Cap of ${options.maxTotal} reached: ${kept.length - capped.length} further ` +
				`result(s) were dropped. Raise max_total or narrow the queries.`,
		);
	}
	if (dropped > 0) {
		options.onProgress?.(`  ${dropped} result(s) already known from an earlier round`);
	}

	return { papers: assignIds(mergeRecords(capped)), warnings };
}

function url(
	options: ExecuteSearchOptions,
	backend: SearchBackend,
): { baseUrl: string } | Record<string, never> {
	const base = options.baseUrls?.[backend];
	// Spread-friendly: `exactOptionalPropertyTypes` rejects an explicit undefined.
	return base === undefined ? {} : { baseUrl: base };
}

/** Most cited first within a query; ties keep backend order, which is fixed. */
function rankOne(papers: readonly PaperRecord[]): PaperRecord[] {
	return [...papers].sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0));
}

/**
 * Interleave queries so the cap is spread over the whole search.
 *
 * Concatenating instead would let one broad query fill a hundred slots and leave
 * the other innovation points with nothing — the report would then have plenty
 * of evidence about one candidate and none about the rest, which looks like a
 * finding rather than an artifact of ordering.
 */
function rankAcrossQueries(queries: readonly PaperRecord[][]): PaperRecord[] {
	const out: PaperRecord[] = [];
	const longest = queries.reduce((max, list) => Math.max(max, list.length), 0);
	for (let rank = 0; rank < longest; rank += 1) {
		for (const list of queries) {
			const paper = list[rank];
			if (paper !== undefined) out.push(paper);
		}
	}
	return out;
}

function every(results: readonly BackendResult[], test: (r: BackendResult) => boolean): boolean {
	return results.length > 0 && results.every(test);
}

export function describeQuery(spec: QuerySpec): string {
	if (spec.kind === "id") {
		return spec.doi ?? spec.arxivId ?? spec.title ?? "(no identifier)";
	}
	return spec.query ?? "(empty query)";
}
