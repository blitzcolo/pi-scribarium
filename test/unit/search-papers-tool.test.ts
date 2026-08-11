import { describe, expect, it } from "vitest";

import { normalizeTools } from "../../src/agents/parse.js";
import { buildCustomTools } from "../../src/runtime/custom-tools.js";
import { createSearchPapersTool } from "../../src/runtime/tools/search-papers.js";
import { scriptedFetcher, type ScriptedRoute } from "../helpers/scripted-fetch.js";

const EMPTY_ARXIV = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const EMPTY_OPENALEX = JSON.stringify({ results: [] });

function s2(papers: Array<Record<string, unknown>>): string {
	return JSON.stringify({ data: papers });
}

/** Run the tool and return the text the model would see. */
async function probe(
	params: Record<string, unknown>,
	routes: readonly ScriptedRoute[],
): Promise<{ text: string; requests: string[]; isError: boolean }> {
	const { fetch, requests } = scriptedFetcher(routes);
	const tool = createSearchPapersTool({ fetcher: fetch });
	const result = (await tool.execute(
		"call-1",
		params,
		undefined,
		undefined,
		undefined as never,
	)) as { content: Array<{ text?: string }>; isError?: boolean };

	return {
		text: result.content.map((part) => part.text ?? "").join("\n"),
		requests,
		isError: result.isError === true,
	};
}

const ALL_EMPTY: ScriptedRoute[] = [
	{ match: "export.arxiv.org", body: EMPTY_ARXIV },
	{ match: "api.semanticscholar.org", body: s2([]) },
	{ match: "api.openalex.org", body: EMPTY_OPENALEX },
];

describe("search_papers tool", () => {
	it("returns a compact ranked listing across the three indexes", async () => {
		const { text } = await probe({ query: "infrared visible fusion" }, [
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: s2([
					{
						paperId: "a",
						title: "Cross-Modal Fusion",
						year: 2023,
						venue: "CVPR",
						citationCount: 214,
						abstract: "We align infrared and visible features without paired annotations.",
						externalIds: { DOI: "10.1/a" },
						authors: [{ name: "Wei Zhang" }],
						openAccessPdf: { url: "https://example.org/a.pdf" },
					},
				]),
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		expect(text).toContain("1 result(s)");
		expect(text).toContain("Cross-Modal Fusion (2023, CVPR)");
		expect(text).toContain("doi:10.1/a");
		expect(text).toContain("cited 214");
		expect(text).toContain("open-access PDF: yes");
		expect(text).toContain("We align infrared and visible features");
	});

	// These indexes hold English literature. A Chinese query returns nothing,
	// which reads exactly like "no prior work exists" — the one wrong answer this
	// pipeline exists to prevent — so it is refused before it is ever sent.
	it("refuses a non-English query instead of returning a misleading blank", async () => {
		const { text, requests, isError } = await probe(
			{ query: "红外与可见光图像融合" },
			ALL_EMPTY,
		);

		expect(isError).toBe(true);
		expect(requests).toEqual([]);
		expect(text).toContain("not in English");
		expect(text).toContain("indistinguishable from a topic nobody has worked on");
	});

	it("accepts Latin text with punctuation, accents and digits", async () => {
		const { requests } = await probe(
			{ query: "Müller's 2021 method: fusion (multi-modal) — 3D" },
			ALL_EMPTY,
		);

		expect(requests.length).toBeGreaterThan(0);
	});

	// An empty result is far more often a bad query than an unstudied topic, and
	// the planner exists precisely to tell the difference.
	it("explains an empty result rather than reporting an absence of work", async () => {
		const { text } = await probe({ query: "some very narrow phrase" }, ALL_EMPTY);

		expect(text).toContain("No results");
		expect(text).toContain("the query is wrong rather than the topic unstudied");
	});

	// A short list from two live backends looks the same as a short literature.
	it("warns when a backend did not answer", async () => {
		const { text } = await probe({ query: "fusion" }, [
			{ match: "export.arxiv.org", status: 503, body: "down" },
			{ match: "api.semanticscholar.org", body: s2([{ paperId: "a", title: "One" }]) },
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		expect(text).toContain("arxiv did not answer");
		expect(text).toContain("Do not read it as an absence of work");
	});

	it("queries only the named backend", async () => {
		const { requests } = await probe({ query: "fusion", backend: "openalex" }, ALL_EMPTY);

		expect(requests).toHaveLength(1);
		expect(requests[0]).toContain("api.openalex.org");
	});

	it("filters by year but keeps undated preprints", async () => {
		const { text } = await probe({ query: "fusion", year_min: 2022 }, [
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: s2([
					{ paperId: "old", title: "Old Paper", year: 2015, externalIds: { DOI: "10.1/o" } },
					{ paperId: "new", title: "New Paper", year: 2023, externalIds: { DOI: "10.1/n" } },
					{ paperId: "undated", title: "Undated Preprint", externalIds: { DOI: "10.1/u" } },
				]),
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		expect(text).toContain("New Paper");
		expect(text).not.toContain("Old Paper");
		// Dropping undated entries would hide preprints, which are exactly the
		// recent work a year filter is reaching for.
		expect(text).toContain("Undated Preprint");
	});

	it("caps the number of results it will return", async () => {
		const many = Array.from({ length: 40 }, (_, index) => ({
			paperId: `p${index}`,
			title: `Paper ${index}`,
			citationCount: 100 - index,
			externalIds: { DOI: `10.1/${index}` },
		}));
		const { text } = await probe({ query: "fusion", limit: 999 }, [
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{ match: "api.semanticscholar.org", body: s2(many) },
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		expect(text).toContain("20 result(s)");
	});

	it("writes no files and is declared sequential", () => {
		const tool = createSearchPapersTool({ fetcher: scriptedFetcher([]).fetch });

		// Sequential so parallel tool calls cannot slip past the per-host rate
		// limits the polite fetcher enforces one request at a time.
		expect(tool.executionMode).toBe("sequential");
		expect(tool.name).toBe("search_papers");
		expect(tool.promptSnippet).toContain("English");
	});
});

describe("granting a custom tool", () => {
	it("accepts the name in agent frontmatter", () => {
		expect(normalizeTools("read, write, search_papers", "a.md")).toEqual([
			"read",
			"write",
			"search_papers",
		]);
	});

	it("still rejects an unknown name, and lists the custom tools as valid", () => {
		expect(() => normalizeTools("read, teleport", "a.md")).toThrow(/teleport/);
		expect(() => normalizeTools("read, teleport", "a.md")).toThrow(/search_papers/);
	});

	// Network capability must be an explicit grant, never something a shorthand
	// hands out on the agent's behalf.
	it("does not include custom tools in `tools: all`", () => {
		expect(normalizeTools("all", "a.md")).not.toContain("search_papers");
	});

	it("builds only the custom tools an agent was granted", () => {
		expect(buildCustomTools(["read", "write"])).toEqual([]);
		expect(buildCustomTools(["read", "search_papers"]).map((tool) => tool.name)).toEqual([
			"search_papers",
		]);
	});
});
