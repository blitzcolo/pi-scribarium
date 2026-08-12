import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuiltin, type BuiltinContext } from "../../src/pipeline/builtins.js";
import type { BuiltinName, BuiltinStepSpec } from "../../src/pipeline/schema.js";
import type { PaperRecord } from "../../src/search/types.js";
import { bodyPage, minimalPdf } from "../helpers/minimal-pdf.js";
import { offlineFetcher, scriptedFetcher, type ScriptedRoute } from "../helpers/scripted-fetch.js";

let workspace: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-searchbuiltin-"));
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

function step(run: BuiltinName, options: Record<string, unknown>): BuiltinStepSpec {
	return { kind: "builtin", id: run, run, with: options, outputs: [] };
}

function context(routes: readonly ScriptedRoute[] = []): BuiltinContext & { requests: string[] } {
	const { fetch, requests } = routes.length === 0 ? offlineFetcher() : scriptedFetcher(routes);
	return {
		workspace,
		resolveOutput: (relative) => path.resolve(workspace, relative),
		fetcher: fetch,
		requests,
	};
}

function write(relative: string, content: string): void {
	const target = path.join(workspace, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, content, "utf-8");
}

function read(relative: string): string {
	return fs.readFileSync(path.join(workspace, relative), "utf-8");
}

function readJson<T>(relative: string): T {
	return JSON.parse(read(relative)) as T;
}

function paper(overrides: Partial<PaperRecord> & { id: string; title: string }): PaperRecord {
	return { authors: [], backends: ["arxiv"], queries: [], points: [], ...overrides };
}

function results(papers: PaperRecord[]): string {
	return JSON.stringify({ version: 1, round: 1, executedAt: "", queries: [], papers, warnings: [] });
}

const EMPTY_ARXIV = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const EMPTY_OPENALEX = JSON.stringify({ results: [] });

/** A byte string that passes the PDF magic check and the size floor. */
function pdfBytes(size = 20_000): Uint8Array {
	const bytes = new Uint8Array(size);
	for (const [index, char] of [..."%PDF-1.7"].entries()) bytes[index] = char.charCodeAt(0);
	return bytes;
}

describe("search-papers builtin", () => {
	it("runs the query file and writes a results file", async () => {
		write(
			"queries.json",
			JSON.stringify({
				version: 1,
				queries: [{ kind: "query", point: "ip-1", query: "infrared fusion" }],
			}),
		);

		const ctx = context([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: {
					data: [
						{
							paperId: "s2-1",
							title: "Infrared Fusion Networks",
							year: 2023,
							citationCount: 12,
							authors: [{ name: "Ada Lovelace" }],
							externalIds: { DOI: "10.1/a" },
						},
					],
				},
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		const result = await runBuiltin(
			step("search-papers", { queries: "queries.json", out: "results.json", max_total: "50" }),
			ctx,
		);

		expect(result.ok).toBe(true);
		const file = readJson<{ papers: PaperRecord[]; round: number }>("results.json");
		expect(file.papers).toHaveLength(1);
		expect(file.papers[0]?.id).toBe("lovelace-2023-infrared-fusion-networks");
	});

	// Numeric options arrive as strings because the engine interpolates string
	// values in `with:` and leaves everything else alone.
	it("parses a string cap and records the truncation as a warning", async () => {
		write(
			"queries.json",
			JSON.stringify({ version: 1, queries: [{ kind: "query", point: "ip-1", query: "x" }] }),
		);
		const ctx = context([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: {
					data: [
						{ paperId: "a", title: "A", citationCount: 9, externalIds: { DOI: "10.1/a" } },
						{ paperId: "b", title: "B", citationCount: 8, externalIds: { DOI: "10.1/b" } },
					],
				},
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		const result = await runBuiltin(
			step("search-papers", { queries: "queries.json", out: "results.json", max_total: "1" }),
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(result.error).toContain("Cap of 1 reached");
		expect(readJson<{ papers: unknown[] }>("results.json").papers).toHaveLength(1);
	});

	it("subtracts an earlier round from the cap via exclude", async () => {
		write("queries.json", JSON.stringify({ version: 1, queries: [{ kind: "query", point: "ip-1", query: "x" }] }));
		write("round1.json", results([paper({ id: "known", title: "A", doi: "10.1/a" })]));

		const ctx = context([
			{ match: "export.arxiv.org", body: EMPTY_ARXIV },
			{
				match: "api.semanticscholar.org",
				body: {
					data: [
						{ paperId: "a", title: "A", externalIds: { DOI: "10.1/a" } },
						{ paperId: "b", title: "B", externalIds: { DOI: "10.1/b" } },
					],
				},
			},
			{ match: "api.openalex.org", body: EMPTY_OPENALEX },
		]);

		await runBuiltin(
			step("search-papers", {
				queries: "queries.json",
				out: "round2.json",
				exclude: "round1.json",
				max_total: "50",
			}),
			ctx,
		);

		expect(readJson<{ papers: PaperRecord[] }>("round2.json").papers.map((p) => p.title)).toEqual([
			"B",
		]);
	});

	// Round two whose follow-ups were all pruned must leave the pipeline running.
	it("treats an empty query list as success without touching the network", async () => {
		write("queries.json", JSON.stringify({ version: 1, queries: [] }));
		const ctx = context();

		const result = await runBuiltin(
			step("search-papers", { queries: "queries.json", out: "results.json" }),
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(ctx.requests).toEqual([]);
		expect(readJson<{ papers: unknown[] }>("results.json").papers).toEqual([]);
	});

	// The fetcher only reports retries if the builtin builds it with a notice
	// hook; an injected one has none. This asserts the wiring, not the fetcher —
	// without it a rate-limited run is silent for up to a minute per attempt.
	it("routes rate-limit waits into the step's progress output", async () => {
		write(
			"queries.json",
			JSON.stringify({ version: 1, queries: [{ kind: "query", point: "ip-1", query: "x" }] }),
		);

		const messages: string[] = [];
		let attempt = 0;
		// No `fetcher` in the context, so the builtin constructs its own — which is
		// the code path a real run takes.
		const ctx: BuiltinContext = {
			workspace,
			resolveOutput: (relative) => path.resolve(workspace, relative),
			onProgress: (message) => messages.push(message),
		};
		const original = globalThis.fetch;
		globalThis.fetch = (async () => {
			attempt += 1;
			return attempt === 1
				? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
				: new Response(JSON.stringify({ data: [] }));
		}) as typeof globalThis.fetch;

		try {
			await runBuiltin(
				step("search-papers", { queries: "queries.json", out: "results.json" }),
				ctx,
			);
		} finally {
			globalThis.fetch = original;
		}

		expect(messages.join("\n")).toContain("rate limited by");
	});

	it("fails with the path when the query file is unreadable", async () => {
		const result = await runBuiltin(
			step("search-papers", { queries: "missing.json", out: "results.json" }),
			context(),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("missing.json");
	});
});

describe("fetch-papers builtin", () => {
	it("downloads a PDF, stubs a paywalled paper, and records both", async () => {
		write(
			"results.json",
			results([
				paper({
					id: "open-2023-a",
					title: "An Open Paper",
					pdfUrl: "https://example.org/a.pdf",
					points: ["ip-1"],
				}),
				paper({
					id: "closed-2022-b",
					title: "A Closed Paper",
					abstract: "We show that the thing works under conditions.",
					doi: "10.1/closed",
					points: ["ip-1"],
				}),
			]),
		);

		const result = await runBuiltin(
			step("fetch-papers", { results: "results.json", dir: "refs" }),
			context([{ match: "example.org/a.pdf", body: pdfBytes() }]),
		);

		expect(result.ok).toBe(true);
		expect(fs.existsSync(path.join(workspace, "refs", "open-2023-a.pdf"))).toBe(true);

		const stub = read("refs/closed-2022-b.md");
		// The banner travels with the document: a card written from an abstract
		// otherwise reads exactly like one written from a paper.
		expect(stub).toContain("ABSTRACT ONLY");
		expect(stub).toContain("abstract_only: true");
		expect(stub).toContain("We show that the thing works");

		const manifest = readJson<{ papers: Array<{ id: string; status: string }> }>(
			"refs/manifest.json",
		);
		expect(manifest.papers.map((p) => p.status).sort()).toEqual(["abstract-only", "downloaded"]);
	});

	// Publishers answer a PDF request with a consent page and HTTP 200. Saved
	// blindly it would reach ingest as a paper and fail there instead of here.
	it("rejects an HTML interstitial served as a PDF", async () => {
		write(
			"results.json",
			results([
				paper({
					id: "wall-2021",
					title: "Behind a Wall",
					pdfUrl: "https://example.org/wall.pdf",
					abstract: "An abstract that survives the failed download.",
				}),
			]),
		);

		await runBuiltin(
			step("fetch-papers", { results: "results.json", dir: "refs" }),
			context([{ match: "example.org/wall.pdf", body: "<html>Choose your institution</html>" }]),
		);

		expect(fs.existsSync(path.join(workspace, "refs", "wall-2021.pdf"))).toBe(false);
		// The abstract still supports a degraded card, which beats a gap the judge
		// would read as "nothing published on this".
		expect(read("refs/wall-2021.md")).toContain("ABSTRACT ONLY");
	});

	it("rejects a PDF too small to be a paper", async () => {
		write(
			"results.json",
			results([paper({ id: "tiny", title: "Tiny", pdfUrl: "https://example.org/t.pdf" })]),
		);

		const result = await runBuiltin(
			step("fetch-papers", { results: "results.json", dir: "refs", min_pdf_bytes: "10000" }),
			context([{ match: "example.org/t.pdf", body: pdfBytes(200) }]),
		);

		// No abstract either, so there is nothing to degrade to and the gap is honest.
		expect(result.error).toContain("1 paper(s) had no open-access PDF and no abstract");
		expect(
			readJson<{ papers: Array<{ status: string }> }>("refs/manifest.json").papers[0]?.status,
		).toBe("failed");
	});

	// A run killed halfway through a hundred papers must resume having paid only
	// for what it had not yet fetched.
	it("never re-downloads a paper it already has", async () => {
		write(
			"results.json",
			results([
				paper({ id: "have-it", title: "Already Here", pdfUrl: "https://example.org/a.pdf" }),
			]),
		);
		fs.mkdirSync(path.join(workspace, "refs"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "refs", "have-it.pdf"), pdfBytes());

		const ctx = context();
		const result = await runBuiltin(
			step("fetch-papers", { results: "results.json", dir: "refs" }),
			ctx,
		);

		expect(result.ok).toBe(true);
		expect(ctx.requests).toEqual([]);
	});

	it("writes a metadata sidecar the analyst can read instead of guessing", async () => {
		write(
			"results.json",
			results([
				paper({
					id: "cited-2020",
					title: "Much Cited",
					abstract: "Abstract.",
					doi: "10.1/cited",
					citationCount: 412,
					points: ["ip-2"],
				}),
			]),
		);

		await runBuiltin(step("fetch-papers", { results: "results.json", dir: "refs" }), context());

		const sidecar = readJson<PaperRecord>("refs/meta/cited-2020.json");
		expect(sidecar.citationCount).toBe(412);
		expect(sidecar.doi).toBe("10.1/cited");
		expect(sidecar.points).toEqual(["ip-2"]);
	});
});

describe("collate-followups builtin", () => {
	function card(name: string, frontmatter: string): void {
		write(`cards/${name}.md`, `---\n${frontmatter}\n---\n\n## Contributions\n\nSomething.\n`);
	}

	it("ranks by how many analyses named the same work and drops known papers", async () => {
		write("round1.json", results([paper({ id: "known", title: "Known Paper", doi: "10.1/known" })]));
		card(
			"a",
			[
				"title: Paper A",
				"related_points: [ip-1]",
				"followups:",
				'  - { title: "Shared Reference", doi: "10.5/shared", reason: "defines the baseline" }',
				'  - { title: "Known Paper", doi: "10.1/known", reason: "already have it" }',
			].join("\n"),
		);
		card(
			"b",
			[
				"title: Paper B",
				"related_points: [ip-2]",
				"followups:",
				'  - { title: "Shared Reference", doi: "10.5/shared", reason: "cited as prior art" }',
				'  - { title: "Lonely Reference", reason: "one mention only" }',
			].join("\n"),
		);

		const result = await runBuiltin(
			step("collate-followups", {
				cards: "cards",
				known: "round1.json",
				out: "followups.json",
				summary: "followups.md",
				max_total: "150",
			}),
			context(),
		);

		expect(result.ok).toBe(true);
		const queries = readJson<{ queries: Array<{ doi?: string; title?: string }> }>(
			"followups.json",
		).queries;
		// Two analysts naming the same work is the ranking signal; the paper
		// round 1 already fetched is gone.
		expect(queries.map((q) => q.title)).toEqual(["Shared Reference", "Lonely Reference"]);
		expect(queries[0]?.doi).toBe("10.5/shared");
		expect(read("followups.md")).toContain("Shared Reference");
	});

	// The cap spans both rounds, so what round one spent is not available again.
	it("leaves only the remaining budget for round two", async () => {
		write(
			"round1.json",
			results([
				paper({ id: "p1", title: "P1", doi: "10.1/1" }),
				paper({ id: "p2", title: "P2", doi: "10.1/2" }),
			]),
		);
		card(
			"a",
			[
				"title: Paper A",
				"related_points: [ip-1]",
				"followups:",
				'  - { title: "First", doi: "10.5/1", reason: "r" }',
				'  - { title: "Second", doi: "10.5/2", reason: "r" }',
			].join("\n"),
		);

		await runBuiltin(
			step("collate-followups", {
				cards: "cards",
				known: "round1.json",
				out: "followups.json",
				summary: "followups.md",
				max_total: "3",
			}),
			context(),
		);

		expect(readJson<{ queries: unknown[] }>("followups.json").queries).toHaveLength(1);
		// A silent cap reads as "this is everything the analyses asked for".
		expect(read("followups.md")).toContain("Not proposed (1)");
	});

	it("isolates a malformed card instead of losing every follow-up", async () => {
		write("round1.json", results([]));
		write("cards/broken.md", "---\ntitle: [unclosed\n---\n\nbody\n");
		card("good", ['title: Good', "related_points: [ip-1]", "followups:", '  - { title: "Wanted", reason: "r" }'].join("\n"));

		const result = await runBuiltin(
			step("collate-followups", {
				cards: "cards",
				known: "round1.json",
				out: "followups.json",
				summary: "followups.md",
			}),
			context(),
		);

		expect(result.ok).toBe(true);
		expect(readJson<{ queries: Array<{ title?: string }> }>("followups.json").queries).toHaveLength(
			1,
		);
		expect(read("followups.md")).toContain("could not be read");
	});
});

describe("collate-evidence builtin", () => {
	function card(name: string, frontmatter: string): void {
		write(`cards/${name}.md`, `---\n${frontmatter}\n---\n\n## Contributions\n\nSomething.\n`);
	}

	beforeEach(() => {
		write(
			"candidates.json",
			JSON.stringify({
				candidates: [
					{ id: "ip-1", title: "Cross-modal alignment without pairs" },
					{ id: "ip-2", title: "Nighttime detection under fog" },
				],
			}),
		);
	});

	it("groups cards per point and states the evidence composition", async () => {
		card("a", "title: Full Text Paper\nyear: 2023\nvenue: CVPR\ncitation_count: 40\nevidence_level: full_text\nrelated_points: [ip-1]");
		card("b", "title: Abstract Paper\nyear: 2022\nvenue: arXiv\nevidence_level: abstract_only\nrelated_points: [ip-1, ip-2]");

		const result = await runBuiltin(
			step("collate-evidence", {
				cards: "cards",
				candidates: "candidates.json",
				out_dir: "evidence",
			}),
			context(),
		);

		expect(result.ok).toBe(true);
		const packet = read("evidence/ip-1.md");
		expect(packet).toContain("**2 analysed paper(s)**");
		expect(packet).toContain("1 read in full text, 1 from the abstract only");
		expect(packet).toContain("Full Text Paper");
		// The judge must not re-read the corpus: the cards are the contract.
		expect(packet).toContain("Do not open the full papers");
	});

	// A missing file looks like "the packet was never built"; the judge has to be
	// able to tell that from "the search found nothing".
	it("writes a packet for a point with no evidence at all", async () => {
		card("a", "title: Only Paper\nevidence_level: full_text\nrelated_points: [ip-1]");

		await runBuiltin(
			step("collate-evidence", { cards: "cards", candidates: "candidates.json", out_dir: "evidence" }),
			context(),
		);

		const packet = read("evidence/ip-2.md");
		expect(packet).toContain("No evidence");
		expect(packet).toContain("weak evidence of novelty, not strong evidence");
	});

	it("counts unfetchable papers and unchased follow-ups into the packet", async () => {
		card("a", "title: A\nevidence_level: full_text\nrelated_points: [ip-1]");
		write(
			"refs/manifest.json",
			JSON.stringify({
				version: 1,
				papers: [
					{ id: "gone", status: "failed", title: "Unfetchable", points: ["ip-1"] },
					{ id: "fine", status: "downloaded", title: "Fine", points: ["ip-1"] },
				],
			}),
		);
		write(
			"followups.json",
			JSON.stringify({ version: 1, queries: [{ kind: "id", point: "ip-1", title: "X" }, { kind: "id", point: "ip-1", title: "Y" }] }),
		);
		write("round2.json", results([paper({ id: "y", title: "Y" })]));

		await runBuiltin(
			step("collate-evidence", {
				cards: "cards",
				candidates: "candidates.json",
				manifest: "refs/manifest.json",
				followups: "followups.json",
				results: "round2.json",
				out_dir: "evidence",
			}),
			context(),
		);

		const packet = read("evidence/ip-1.md");
		expect(packet).toContain("1 related paper(s) could not be fetched");
		expect(packet).toContain("1 follow-up reference(s) were proposed but never fetched");
	});

	it("reports a card naming an unknown innovation point", async () => {
		card("a", "title: A\nevidence_level: full_text\nrelated_points: [ip-9]");

		const result = await runBuiltin(
			step("collate-evidence", { cards: "cards", candidates: "candidates.json", out_dir: "evidence" }),
			context(),
		);

		expect(result.ok).toBe(true);
		expect(result.error).toContain("ip-9");
	});

	it("fails with the path when the candidate list is unreadable", async () => {
		const result = await runBuiltin(
			step("collate-evidence", { cards: "cards", candidates: "nope.json", out_dir: "evidence" }),
			context(),
		);

		expect(result.ok).toBe(false);
		expect(result.error).toContain("nope.json");
	});
});

/**
 * Full text a human fetched by hand.
 *
 * A paywalled paper enters the corpus as an abstract-only stub, and that
 * weakness is disclosed all the way into the verdict's evidence counts. Supplying
 * the PDF has to actually undo it — otherwise the run keeps reporting the paper
 * as unread while an analyst reads it in full.
 */
describe("fetch-papers: supplying a missing full text", () => {
	const PAYWALLED = () =>
		results([
			paper({
				id: "closed-2022-b",
				title: "A Closed Paper",
				abstract: "We show that the thing works under conditions.",
				doi: "10.1/closed",
				year: 2022,
				points: ["ip-1"],
			}),
		]);

	function fetchStep(): BuiltinStepSpec {
		return step("fetch-papers", { results: "results.json", dir: "refs", missing: "missing.md" });
	}

	function statusOf(id: string): string | undefined {
		return readJson<{ papers: Array<{ id: string; status: string }> }>(
			"refs/manifest.json",
		).papers.find((entry) => entry.id === id)?.status;
	}

	it("lists what is missing, and deletes the list once nothing is", async () => {
		write("results.json", PAYWALLED());
		await runBuiltin(fetchStep(), context());

		const list = read("missing.md");
		expect(list).toContain("A Closed Paper");
		expect(list).toContain("https://doi.org/10.1/closed");
		// The exact filename, because the id is a slug nobody would guess, and a
		// near-miss fails silently: the paper simply stays missing.
		expect(list).toContain("refs/closed-2022-b.pdf");
		expect(list).toContain("refs/inbox/");

		fs.writeFileSync(
			path.join(workspace, "refs", "closed-2022-b.pdf"),
			minimalPdf([bodyPage("supplied by hand")]),
		);
		await runBuiltin(fetchStep(), context());

		// Deleted rather than emptied: an optional gate keys off the artifact being
		// absent, and a stale list would reopen it forever.
		expect(fs.existsSync(path.join(workspace, "missing.md"))).toBe(false);
	});

	it("re-reads the status from disk and retires the superseded stub", async () => {
		write("results.json", PAYWALLED());
		await runBuiltin(fetchStep(), context());
		expect(statusOf("closed-2022-b")).toBe("abstract-only");

		fs.writeFileSync(
			path.join(workspace, "refs", "closed-2022-b.pdf"),
			minimalPdf([bodyPage("supplied by hand")]),
		);
		await runBuiltin(fetchStep(), context());

		// Carrying the recorded verdict forward instead would tell the analyst that
		// the paper it is about to read in full was never read.
		expect(statusOf("closed-2022-b")).toBe("downloaded");
		// Left in place, ingest reads both: one paper twice in one corpus, one copy
		// stamped as weaker evidence.
		expect(fs.existsSync(path.join(workspace, "refs", "closed-2022-b.md"))).toBe(false);
	});

	it("adopts an inbox PDF by the DOI on its first page, whatever it is named", async () => {
		write("results.json", PAYWALLED());
		await runBuiltin(fetchStep(), context());

		const inbox = path.join(workspace, "refs", "inbox");
		fs.mkdirSync(inbox, { recursive: true });
		fs.writeFileSync(
			path.join(inbox, "1-s2.0-S0924271618300741-main.pdf"),
			minimalPdf([bodyPage("10.1/closed")]),
		);
		await runBuiltin(fetchStep(), context());

		expect(fs.existsSync(path.join(workspace, "refs", "closed-2022-b.pdf"))).toBe(true);
		expect(fs.readdirSync(inbox)).toEqual([]);
		expect(statusOf("closed-2022-b")).toBe("downloaded");
		expect(fs.existsSync(path.join(workspace, "missing.md"))).toBe(false);
	});

	it("leaves a PDF it cannot identify in the inbox rather than guessing", async () => {
		write("results.json", PAYWALLED());
		await runBuiltin(fetchStep(), context());

		const inbox = path.join(workspace, "refs", "inbox");
		fs.mkdirSync(inbox, { recursive: true });
		fs.writeFileSync(path.join(inbox, "something-else.pdf"), minimalPdf([bodyPage("10.9/other")]));
		await runBuiltin(fetchStep(), context());

		// Filing it under the wrong id would put someone else's paper in the corpus
		// under a name nobody re-checks.
		expect(fs.readdirSync(inbox)).toEqual(["something-else.pdf"]);
		expect(statusOf("closed-2022-b")).toBe("abstract-only");
		expect(fs.existsSync(path.join(workspace, "missing.md"))).toBe(true);
	});
});
