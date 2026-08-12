import { describe, expect, it } from "vitest";

import { executeSearch } from "../../src/search/run-search.js";
import type { PaperRecord, QuerySpec } from "../../src/search/types.js";
import { scriptedFetcher } from "../helpers/scripted-fetch.js";

/** One S2 result per title, so a test can shape a result set by name. */
function s2(titles: Array<[string, number]>): string {
	return JSON.stringify({
		data: titles.map(([title, citationCount], index) => ({
			paperId: `s2-${index}`,
			title,
			year: 2020,
			venue: "Venue",
			citationCount,
			externalIds: { DOI: `10.1/${title.toLowerCase().replaceAll(" ", "-")}` },
			authors: [{ name: "Ada Lovelace" }],
		})),
	});
}

const EMPTY_ARXIV = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const EMPTY_OPENALEX = JSON.stringify({ results: [] });

function query(point: string, text: string): QuerySpec {
	return { kind: "query", point, query: text };
}

describe("executeSearch", () => {
	/**
	 * A backend returns its hits in its own relevance order, and that order is the
	 * only relevance signal this system has. It used to be discarded and replaced
	 * with a citation-count sort, which is a fame signal: in a real run the query
	 * "noise robust visible infrared image fusion fixed pattern noise" put the
	 * seven-year WMAP cosmology survey — 8874 citations, matched loosely — ahead of
	 * every paper about infrared fusion, and the corpus came back led by WMAP,
	 * acute stroke guidelines and attosecond physics.
	 */
	it("keeps the backend's relevance order instead of promoting the famous", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: s2([
					["On Topic But Obscure", 3],
					["Famous And Barely Related", 9999],
				]),
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		const result = await executeSearch({
			queries: [query("ip-1", "infrared fusion")],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 50,
		});

		expect(result.papers.map((paper: PaperRecord) => paper.title)).toEqual([
			"On Topic But Obscure",
			"Famous And Barely Related",
		]);
	});

	it("merges across backends and assigns ids once, after dedupe", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{ match: "api.semanticscholar.org", body: s2([["Alpha Paper", 10]]) },
			{
				match: "api.openalex.org",
				body: {
					results: [
						{
							id: "https://openalex.org/W1",
							doi: "https://doi.org/10.1/alpha-paper",
							display_name: "Alpha Paper",
							publication_year: 2020,
							cited_by_count: 12,
							authorships: [{ author: { display_name: "Ada Lovelace" } }],
						},
					],
				},
			},
		]);

		const result = await executeSearch({
			queries: [query("ip-1", "alpha")],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 50,
		});

		// The same DOI from two backends is one paper, one download, one card.
		expect(result.papers).toHaveLength(1);
		// Sorted: `backends` records which indexes found the paper, and nothing
		// reads an order into it. It used to fall out of the order the backends
		// were concatenated in; now that equally-ranked hits are ordered between
		// themselves, whichever of the two merges first is an artifact.
		expect([...(result.papers[0]?.backends ?? [])].sort()).toEqual([
			"openalex",
			"semanticscholar",
		]);
		expect(result.papers[0]?.id).toBe("lovelace-2020-alpha-paper");
	});

	// A truncated search that reads as exhaustive is how "no precedent found"
	// becomes a false claim in the report.
	it("caps the result set and says so in a warning", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: s2([
					["Paper A", 5],
					["Paper B", 4],
					["Paper C", 3],
				]),
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		const result = await executeSearch({
			queries: [query("ip-1", "alpha")],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 2,
		});

		expect(result.papers).toHaveLength(2);
		expect(result.warnings.join(" ")).toContain("Cap of 2 reached");
		expect(result.warnings.join(" ")).toContain("1 further");
	});

	// Concatenating instead would let one broad query fill the cap and leave the
	// other innovation points with no evidence at all — which reads as a finding
	// rather than as an artifact of ordering.
	it("spreads a tight cap across queries instead of letting one fill it", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: (url) => url.includes("api.semanticscholar.org") && url.includes("broad"),
				body: s2([
					["Broad One", 100],
					["Broad Two", 90],
					["Broad Three", 80],
				]),
			},
			{
				match: (url) => url.includes("api.semanticscholar.org") && url.includes("narrow"),
				body: s2([["Narrow One", 1]]),
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		const result = await executeSearch({
			queries: [query("ip-1", "broad"), query("ip-2", "narrow")],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 2,
		});

		expect(result.papers.map((p) => p.title)).toEqual(["Broad One", "Narrow One"]);
	});

	it("drops papers already known from an earlier round", async () => {
		const known: PaperRecord[] = [
			{
				id: "known",
				title: "Paper A",
				authors: [],
				doi: "10.1/paper-a",
				backends: ["arxiv"],
				queries: [],
				points: [],
			},
		];
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: s2([
					["Paper A", 5],
					["Paper B", 4],
				]),
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		const result = await executeSearch({
			queries: [query("ip-1", "alpha")],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 50,
			exclude: known,
		});

		expect(result.papers.map((p) => p.title)).toEqual(["Paper B"]);
	});

	// One dead backend out of three should narrow a search, not end a run that has
	// already been paid for.
	it("continues with the surviving backends and warns about the dead one", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", status: 503, body: "down" },
			{ match: "api.semanticscholar.org", body: s2([["Paper A", 5]]) },
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		const result = await executeSearch({
			queries: [query("ip-1", "alpha")],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 50,
		});

		expect(result.papers).toHaveLength(1);
		expect(result.warnings.join(" ")).toContain("arxiv failed on 1 of 1");
	});

	it("warns when no backend answered at all", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", networkError: "ECONNREFUSED" },
			{ match: "api.semanticscholar.org", networkError: "ECONNREFUSED" },
			{ match: "api.openalex.org", networkError: "ECONNREFUSED" },
		]);

		const result = await executeSearch({
			queries: [query("ip-1", "alpha")],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 50,
		});

		expect(result.papers).toEqual([]);
		expect(result.warnings.join(" ")).toContain("No backend answered");
	});

	it("makes no request for an empty query list", async () => {
		const { fetch, requests } = scriptedFetcher([]);

		const result = await executeSearch({
			queries: [],
			fetcher: fetch,
			perQueryLimit: 10,
			maxTotal: 50,
		});

		expect(requests).toEqual([]);
		expect(result.papers).toEqual([]);
	});
});
