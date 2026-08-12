import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { searchArxiv } from "../../src/search/arxiv.js";
import { reconstructAbstract, searchOpenAlex } from "../../src/search/openalex.js";
import { searchSemanticScholar } from "../../src/search/semantic-scholar.js";
import type { QuerySpec } from "../../src/search/types.js";
import { scriptedFetcher } from "../helpers/scripted-fetch.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "search");
const read = (name: string) => fs.readFileSync(path.join(fixtures, name), "utf-8");

const QUERY: QuerySpec = { kind: "query", point: "ip-1", query: "infrared visible fusion" };

describe("arXiv adapter", () => {
	/**
	 * The terms go over bare and `sortBy=relevance` ranks the union.
	 *
	 * They were once phrase-quoted, on the correct observation that arXiv ORs bare
	 * terms — but a planner writes six-to-eight word descriptive queries, and no
	 * paper contains one of those as a literal phrase. Every query in a real run
	 * came back `totalResults=0`, so a corpus about infrared/visible fusion
	 * contained no arXiv papers at all and consisted instead of publisher-hosted
	 * articles whose PDFs mostly refuse to download. ANDing the terms fails
	 * identically. Do not put the quotes back.
	 */
	it("does not phrase-quote a multi-word query", async () => {
		const { fetch, requests } = scriptedFetcher([
			{ match: "export.arxiv.org", body: read("arxiv-query.atom") },
		]);

		await searchArxiv(
			{ kind: "query", point: "ip-1", query: "weakly aligned RGB thermal pedestrian detection" },
			10,
			{ fetcher: fetch },
		);

		const sent = decodeURIComponent(requests[0] ?? "");
		expect(sent).toContain("all:weakly aligned RGB thermal pedestrian detection");
		expect(sent).not.toContain('"');
		expect(sent).toContain("sortBy=relevance");
	});

	it("extracts entries, decodes entities, and strips the version from the id", async () => {
		const { fetch, requests } = scriptedFetcher([
			{ match: "export.arxiv.org", body: read("arxiv-query.atom") },
		]);

		const result = await searchArxiv(QUERY, 10, { fetcher: fetch });

		expect(result.error).toBeUndefined();
		expect(result.papers).toHaveLength(3);
		expect(requests[0]).toContain("search_query=");

		const first = result.papers[0];
		// The title wraps across two lines in the feed and carries an `&amp;`.
		expect(first?.title).toBe(
			"Cross-Modal Attention for Infrared & Visible Image Fusion under Weak Supervision",
		);
		// Versions are stripped so v2 here and v3 from another backend merge.
		expect(first?.arxivId).toBe("2301.04567");
		expect(first?.pdfUrl).toBe("https://arxiv.org/pdf/2301.04567");
		expect(first?.doi).toBe("10.1109/tpami.2023.1234567");
		expect(first?.year).toBe(2023);
		expect(first?.authors).toEqual(["Wei Zhang", "Maria González"]);
		expect(first?.points).toEqual(["ip-1"]);
	});

	it("keeps a numeric entity and a journal reference", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", body: read("arxiv-query.atom") },
		]);

		const papers = (await searchArxiv(QUERY, 10, { fetcher: fetch })).papers;

		expect(papers[1]?.title).toBe("A Survey of Multimodal Detection with <100 Labels");
		expect(papers[1]?.venue).toBe("ACM Computing Surveys 57(3)");
		// No journal_ref means the paper is only on arXiv, and saying so is more
		// useful to a reader than an empty venue field.
		expect(papers[2]?.venue).toBe("arXiv");
	});

	// arXiv answers a malformed query with HTTP 200 and one entry titled "Error".
	// Parsed naively that becomes a paper, which then costs a download and a model
	// call before anyone notices the corpus holds a fake record.
	it("drops arXiv's error entry rather than treating it as a paper", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", body: read("arxiv-error.atom") },
		]);

		const result = await searchArxiv(QUERY, 10, { fetcher: fetch });

		expect(result.papers).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("reports a dead backend as a value instead of throwing", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "export.arxiv.org", status: 503, body: "upstream unavailable" },
		]);

		const result = await searchArxiv(QUERY, 10, { fetcher: fetch });

		expect(result.papers).toEqual([]);
		expect(result.error).toContain("503");
	});

	it("looks an arXiv id up directly instead of searching for its digits", async () => {
		const { fetch, requests } = scriptedFetcher([
			{ match: "export.arxiv.org", body: read("arxiv-query.atom") },
		]);

		await searchArxiv({ kind: "id", point: "ip-2", arxivId: "2301.04567" }, 5, { fetcher: fetch });

		expect(requests[0]).toContain("id_list=2301.04567");
		expect(requests[0]).not.toContain("search_query");
	});

	// A DOI is not something arXiv indexes; searching for it would match on the
	// digits and bind an unrelated paper to a follow-up reference.
	it("makes no request for a DOI-only lookup", async () => {
		const { fetch, requests } = scriptedFetcher([{ match: "export.arxiv.org", body: "" }]);

		const result = await searchArxiv({ kind: "id", point: "ip-2", doi: "10.1/x" }, 5, {
			fetcher: fetch,
		});

		expect(requests).toEqual([]);
		expect(result.papers).toEqual([]);
	});
});

describe("Semantic Scholar adapter", () => {
	it("maps external ids, citation counts and the open-access link", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "api.semanticscholar.org", body: read("s2-search.json") },
		]);

		const papers = (await searchSemanticScholar(QUERY, 10, { fetcher: fetch })).papers;

		expect(papers).toHaveLength(2);
		expect(papers[0]?.doi).toBe("10.1109/tpami.2023.1234567");
		expect(papers[0]?.arxivId).toBe("2301.04567");
		expect(papers[0]?.citationCount).toBe(214);
		// An explicit open-access URL wins over the arXiv guess: it points at the
		// version of record.
		expect(papers[0]?.pdfUrl).toBe("https://example.org/oa/zhang2023.pdf");
		expect(papers[1]?.pdfUrl).toBeUndefined();
		expect(papers[1]?.venue).toBe("CVPR");
	});

	// A follow-up reference the index does not hold is an empty answer, not a
	// failure — treating it as one would count a dead backend on every miss.
	it("treats a 404 on a direct lookup as no result rather than an error", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "api.semanticscholar.org", status: 404, body: { error: "not found" } },
		]);

		const result = await searchSemanticScholar({ kind: "id", point: "ip-1", doi: "10.1/x" }, 1, {
			fetcher: fetch,
		});

		expect(result.papers).toEqual([]);
		expect(result.error).toBeUndefined();
	});

	it("explains an HTML error page instead of a JSON parse error", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "api.semanticscholar.org", body: "<html><body>Too Many Requests</body></html>" },
		]);

		const result = await searchSemanticScholar(QUERY, 10, { fetcher: fetch });

		expect(result.error).toContain("not JSON");
		expect(result.error).toContain("Too Many Requests");
	});
});

describe("OpenAlex adapter", () => {
	it("reconstructs the inverted abstract and reads the open-access link", async () => {
		const { fetch } = scriptedFetcher([
			{ match: "api.openalex.org", body: read("openalex-search.json") },
		]);

		const papers = (await searchOpenAlex(QUERY, 10, { fetcher: fetch })).papers;

		expect(papers).toHaveLength(2);
		expect(papers[0]?.abstract).toBe("We propose a cross-modal attention module for unpaired data.");
		expect(papers[0]?.doi).toBe("10.1109/tpami.2023.1234567");
		expect(papers[0]?.citationCount).toBe(231);
		expect(papers[0]?.pdfUrl).toBe("https://example.org/oa/zhang2023-openalex.pdf");
		expect(papers[1]?.abstract).toBeUndefined();
		expect(papers[1]?.venue).toBe("Sensors");
	});

	it("orders words by position and tolerates gaps", () => {
		expect(reconstructAbstract({ world: [1], hello: [0] })).toBe("hello world");
		// Position 2 is missing: the publisher's index simply lacks it. Filling the
		// hole with a placeholder would be worse than a slightly clipped sentence.
		expect(reconstructAbstract({ a: [0], b: [1], d: [3] })).toBe("a b d");
		expect(reconstructAbstract(null)).toBeUndefined();
		expect(reconstructAbstract({})).toBeUndefined();
	});
});
