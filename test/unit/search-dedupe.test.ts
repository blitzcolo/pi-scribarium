import { describe, expect, it } from "vitest";

import { assignIds, mergeRecords, paperKeys } from "../../src/search/dedupe.js";
import type { PaperRecord, SearchBackend } from "../../src/search/types.js";

function paper(overrides: Partial<PaperRecord> & { title: string }): PaperRecord {
	return {
		id: "",
		authors: [],
		backends: ["arxiv"] as SearchBackend[],
		queries: [],
		points: [],
		...overrides,
	};
}

describe("paperKeys", () => {
	// Precedence was the bug: a record with any DOI never reached the title key,
	// so a preprint could not be recognised as its own published version.
	it("claims every identity a record has, not just the best one", () => {
		expect(paperKeys(paper({ title: "T", doi: "10.1/a", arxivId: "2301.1" }))).toEqual([
			"arxiv:2301.1",
			"doi:10.1/a",
			"title:t|",
		]);
	});

	// Punctuation and case differ between indexes for the same paper; the key has
	// to survive that or the title tier never merges anything.
	it("normalizes punctuation and case out of the title key", () => {
		const left = paper({ title: "Cross-Modal Attention, Revisited", authors: ["Ada Lovelace"] });
		const right = paper({ title: "cross modal attention revisited", authors: ["A. Lovelace"] });
		expect(paperKeys(left)).toContain("title:crossmodalattentionrevisited|lovelace");
		expect(paperKeys(right)).toContain("title:crossmodalattentionrevisited|lovelace");
	});

	// DataCite's DOI for an arXiv preprint contains the arXiv id, so the same file
	// arrived under `arxiv:` from one backend and `doi:` from another and the two
	// never met.
	it("reads an arXiv DOI as the arXiv id it contains", () => {
		const fromArxiv = paper({ title: "Unsupervised Fusion", arxivId: "2205.11876" });
		const fromOpenAlex = paper({ title: "Unsupervised Fusion", doi: "10.48550/arXiv.2205.11876" });

		expect(paperKeys(fromArxiv)).toContain("arxiv:2205.11876");
		expect(paperKeys(fromOpenAlex)).toContain("arxiv:2205.11876");
		// And not also under the DOI spelling, or the same preprint would match
		// under two keys depending on which index found it.
		expect(paperKeys(fromOpenAlex).some((key) => key.startsWith("doi:"))).toBe(false);
	});

	it("treats a resolver prefix and casing as the same DOI", () => {
		expect(paperKeys(paper({ title: "T", doi: "https://doi.org/10.1/AbC" }))).toContain(
			"doi:10.1/abc",
		);
	});
});

describe("mergeRecords", () => {
	/**
	 * The three-way case, taken verbatim from a real corpus. All three are the
	 * same paper; none of them shares its most-reliable identifier with another.
	 * Under precedence keys they became three downloads, three cards, and three
	 * apparently independent pieces of evidence that the idea had been tried —
	 * inflating the exact signal this pipeline exists to measure. One of them was
	 * also a paywalled stub asking a human to fetch a PDF that another copy had
	 * already downloaded in full.
	 */
	it("folds a preprint, its arXiv DOI, and its published version into one", () => {
		const merged = mergeRecords([
			paper({
				title: "Unsupervised Misaligned Infrared and Visible Image Fusion",
				authors: ["Di Wang"],
				year: 2022,
				doi: "10.24963/ijcai.2022/487",
				backends: ["openalex"],
			}),
			paper({
				title: "Unsupervised Misaligned Infrared and Visible Image Fusion",
				authors: ["Di Wang"],
				year: 2022,
				arxivId: "2205.11876",
				pdfUrl: "https://arxiv.org/pdf/2205.11876",
				backends: ["arxiv"],
			}),
			paper({
				title: "Unsupervised Misaligned Infrared and Visible Image Fusion",
				authors: ["Di Wang"],
				year: 2022,
				doi: "10.48550/arxiv.2205.11876",
				backends: ["openalex"],
			}),
		]);

		expect(merged).toHaveLength(1);
		// The survivor keeps the downloadable copy, which is the difference between
		// a full text and a stub a human is asked to go and fetch by hand.
		expect(merged[0]?.pdfUrl).toBe("https://arxiv.org/pdf/2205.11876");
		expect(merged[0]?.doi).toBe("10.24963/ijcai.2022/487");
		expect(merged[0]?.arxivId).toBe("2205.11876");
		expect(merged[0]?.backends.sort()).toEqual(["arxiv", "openalex"]);
	});

	// Identity is a relation, not a lookup: the first and last share nothing
	// directly and are one paper only by way of the middle record.
	it("joins records that are linked only through a third", () => {
		const merged = mergeRecords([
			paper({ title: "Alpha", authors: ["Ada Lovelace"], doi: "10.1/published" }),
			paper({ title: "Alpha", authors: ["Ada Lovelace"], arxivId: "2301.00001" }),
			paper({ title: "Totally Different Title", authors: ["Ada Lovelace"], arxivId: "2301.00001" }),
		]);

		expect(merged).toHaveLength(1);
	});

	// Two genuinely different papers must survive as two.
	it("keeps distinct papers apart", () => {
		const merged = mergeRecords([
			paper({ title: "Alpha", authors: ["Ada Lovelace"], doi: "10.1/a" }),
			paper({ title: "Beta", authors: ["Ada Lovelace"], doi: "10.1/b" }),
			paper({ title: "Alpha", authors: ["Grace Hopper"], doi: "10.1/c" }),
		]);

		expect(merged).toHaveLength(3);
	});

	it("unions provenance and keeps the richest field values", () => {
		const merged = mergeRecords([
			paper({
				title: "Cross-Modal Attention",
				doi: "10.1/a",
				backends: ["arxiv"],
				queries: ["q1"],
				points: ["ip-1"],
				abstract: "Short.",
				citationCount: 100,
				arxivId: "2301.1",
			}),
			paper({
				title: "Cross-Modal Attention for Infrared Fusion",
				doi: "10.1/a",
				backends: ["openalex"],
				queries: ["q2"],
				points: ["ip-2"],
				abstract: "A considerably longer abstract with the full text of the summary.",
				citationCount: 231,
				year: 2023,
				pdfUrl: "https://example.org/a.pdf",
			}),
		]);

		expect(merged).toHaveLength(1);
		const only = merged[0];
		expect(only?.backends).toEqual(["arxiv", "openalex"]);
		expect(only?.queries).toEqual(["q1", "q2"]);
		expect(only?.points).toEqual(["ip-1", "ip-2"]);
		expect(only?.title).toBe("Cross-Modal Attention for Infrared Fusion");
		expect(only?.abstract).toContain("considerably longer");
		// Indexes disagree on citation counts because they see different graphs;
		// the larger is the better-connected index, and it only drives ranking.
		expect(only?.citationCount).toBe(231);
		expect(only?.year).toBe(2023);
		expect(only?.arxivId).toBe("2301.1");
		expect(only?.pdfUrl).toBe("https://example.org/a.pdf");
	});

	it("keeps genuinely different papers apart", () => {
		const merged = mergeRecords([
			paper({ title: "One", doi: "10.1/a" }),
			paper({ title: "Two", doi: "10.1/b" }),
			paper({ title: "Three" }),
		]);
		expect(merged).toHaveLength(3);
	});

	it("does not mutate its input", () => {
		const original = paper({ title: "T", doi: "10.1/a", backends: ["arxiv"] });
		mergeRecords([original, paper({ title: "T", doi: "10.1/a", backends: ["openalex"] })]);
		expect(original.backends).toEqual(["arxiv"]);
	});
});

describe("assignIds", () => {
	it("names papers surname-year-title and disambiguates collisions in order", () => {
		const ids = assignIds([
			paper({ title: "Cross-Modal Attention for Fusion", authors: ["Wei Zhang"], year: 2023 }),
			paper({ title: "Cross-Modal Attention for Fusion", authors: ["Wei Zhang"], year: 2023 }),
			paper({ title: "Thermal Pseudo Labels", authors: ["Nair, Priya"], year: 2022 }),
		]).map((entry) => entry.id);

		expect(ids).toEqual([
			"zhang-2023-cross-modal-attention-for-fusion",
			"zhang-2023-cross-modal-attention-for-fusion-2",
			"nair-2022-thermal-pseudo-labels",
		]);
	});

	// CJK strips to nothing under NFKD, so an id built only from it would collide
	// on the fallback for every such paper.
	it("falls back to a readable stem when metadata slugs to nothing", () => {
		const ids = assignIds([
			paper({ title: "深度学习", authors: [] }),
			paper({ title: "机器学习", authors: [] }),
		]).map((entry) => entry.id);

		expect(ids).toEqual(["paper", "paper-2"]);
	});
});
