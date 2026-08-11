import { describe, expect, it } from "vitest";

import { assignIds, mergeRecords, paperKey } from "../../src/search/dedupe.js";
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

describe("paperKey", () => {
	it("prefers a DOI, then an arXiv id, then the normalized title", () => {
		expect(paperKey(paper({ title: "T", doi: "10.1/a", arxivId: "2301.1" }))).toBe("doi:10.1/a");
		expect(paperKey(paper({ title: "T", arxivId: "2301.1" }))).toBe("arxiv:2301.1");
		expect(paperKey(paper({ title: "A Study: Of Things!" }))).toBe("title:astudyofthings");
	});

	// Punctuation and case differ between indexes for the same paper; the key has
	// to survive that or the title tier never merges anything.
	it("normalizes punctuation and case out of the title key", () => {
		const left = paper({ title: "Cross-Modal Attention, Revisited" });
		const right = paper({ title: "cross modal attention revisited" });
		expect(paperKey(left)).toBe(paperKey(right));
	});
});

describe("mergeRecords", () => {
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
