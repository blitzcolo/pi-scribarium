import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { searchArxiv } from "../../search/arxiv.js";
import { mergeRecords } from "../../search/dedupe.js";
import { createPoliteFetcher, type Fetcher, type FetchNotice } from "../../search/http.js";
import { searchOpenAlex } from "../../search/openalex.js";
import { searchSemanticScholar } from "../../search/semantic-scholar.js";
import type { BackendResult, PaperRecord, QuerySpec } from "../../search/types.js";

/**
 * A read-only probe over the literature indexes.
 *
 * The one tool in this project that reaches the network, and it is granted to
 * exactly one agent: the query planner. Its job is to find out whether a search
 * term returns the right literature before a hundred downloads are paid for on
 * the strength of it — a term that returns nothing, or returns the wrong field
 * entirely, is far cheaper to discover here than in the report.
 *
 * It writes nothing. Downloading and result persistence stay in the builtins,
 * where the caps are enforced and every artifact lands on disk for resume.
 */

/** Enough to judge whether a query is on target; more would just fill context. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;

/** Words of abstract shown per hit. Enough to tell topic drift from a real match. */
const ABSTRACT_WORDS = 40;

const PARAMETERS = Type.Object({
	query: Type.String({
		description:
			"Search terms, in English. Translate from any other language before calling; " +
			"the indexes only cover English-language literature.",
	}),
	backend: Type.Optional(
		Type.Union(
			[
				Type.Literal("all"),
				Type.Literal("arxiv"),
				Type.Literal("semanticscholar"),
				Type.Literal("openalex"),
			],
			{
				description:
					"Which index to query. Defaults to all three. arxiv is preprint-heavy and " +
					"strongest in physics and computer science; openalex has the widest coverage " +
					"outside computer science; semanticscholar carries the most reliable citation counts.",
			},
		),
	),
	limit: Type.Optional(
		Type.Number({
			minimum: 1,
			maximum: MAX_LIMIT,
			description: `Results per index, 1-${MAX_LIMIT}. Defaults to ${DEFAULT_LIMIT}.`,
		}),
	),
	year_min: Type.Optional(
		Type.Number({ description: "Drop results published before this year." }),
	),
});

export interface SearchPapersToolOptions {
	fetcher?: Fetcher;
	/** Only consulted for a fetcher this factory builds; an injected one reports
	 * through whatever hook its own caller gave it. */
	onNotice?: (notice: FetchNotice) => void;
}

export function createSearchPapersTool(options: SearchPapersToolOptions = {}): ToolDefinition {
	const fetcher =
		options.fetcher ??
		createPoliteFetcher({
			...(options.onNotice !== undefined ? { onNotice: options.onNotice } : {}),
		});

	return defineTool({
		name: "search_papers",
		label: "Search papers",
		description:
			"Search arXiv, Semantic Scholar and OpenAlex for published work. Use this to test " +
			"whether a search term returns the literature you expect before it is used to build " +
			"a corpus: check that the hits are on topic, that the field's own vocabulary is being " +
			"used, and that the term is neither so broad it returns everything nor so narrow it " +
			"returns nothing. Queries must be English. Returns titles, venues, years, citation " +
			"counts and abstract openings; it does not download anything and writes no files.",
		promptSnippet: "search_papers — probe the literature indexes to test a search term (English only)",
		promptGuidelines: [
			"Search queries must be written in English, whatever language the task is stated in.",
			"Use search_papers to check a query's yield before committing to it, not to gather evidence: the pipeline's own search step builds the corpus.",
		],
		parameters: PARAMETERS,
		// Politeness is enforced by the fetcher, which serializes and spaces per
		// host — not by running one tool call at a time. The queues belong to the
		// single fetcher built above and closed over here, so every concurrent call
		// shares them and no host sees a shorter interval however many calls are in
		// flight. Serializing here as well protected nothing and tripled the wall
		// clock: the planner probes three or so queries per turn, and each waited
		// out the one before it.
		//
		// The premise is that one fetcher instance serves every call. Moving its
		// construction into `execute` would give each call private queues and
		// concurrency really would slip past the rate limits — which is what the
		// spacing test below pins down.
		executionMode: "parallel",
		execute: async (_toolCallId, params) => {
			const query = String(params.query ?? "").trim();
			if (query === "") {
				return text("Empty query. Give search terms in English.", true);
			}

			// A hard backstop under the prompt guidance: these indexes hold English
			// literature, and a Chinese query silently returns nothing, which reads
			// exactly like "no prior work exists" — the one wrong answer this whole
			// pipeline is built to avoid.
			if (hasNonLatinScript(query)) {
				return text(
					`The query "${query}" is not in English. These indexes only cover ` +
						"English-language literature, and a non-English query returns nothing, " +
						"which is indistinguishable from a topic nobody has worked on. " +
						"Translate the query into the field's English terminology and call again.",
					true,
				);
			}

			const limit = clamp(params.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
			const backend = params.backend ?? "all";
			const spec: QuerySpec = { kind: "query", point: "probe", query };

			// Three independent hosts with nothing to say to each other, so there is
			// nothing here to serialize. Awaiting them in turn cost the sum of the
			// three rather than the slowest, and with two of them spending their full
			// retry budget that was the difference between ~50s and ~70s for a single
			// probe — on top of which the SDK already runs these tool calls one at a
			// time, so the sum was paid three times per turn.
			//
			// Concurrency raises no host's request rate: the fetcher still queues per
			// host, which is where politeness is enforced. `executeSearch` on the
			// builtin path always did this; only the tool did not. `Promise.all`
			// resolves in input order regardless of who finishes first, so the
			// rendered output stays deterministic.
			const pending: Array<Promise<BackendResult>> = [];
			if (backend === "all" || backend === "arxiv") {
				pending.push(searchArxiv(spec, limit, { fetcher }));
			}
			if (backend === "all" || backend === "semanticscholar") {
				pending.push(searchSemanticScholar(spec, limit, { fetcher }));
			}
			if (backend === "all" || backend === "openalex") {
				pending.push(searchOpenAlex(spec, limit, { fetcher }));
			}
			const results = await Promise.all(pending);

			const failures = results.filter((result) => result.error !== undefined);
			const papers = mergeRecords(results.flatMap((result) => result.papers))
				.filter((paper) => keepYear(paper, params.year_min))
				.sort((a, b) => (b.citationCount ?? 0) - (a.citationCount ?? 0))
				.slice(0, limit);

			return text(render(query, papers, failures, params.year_min));
		},
	}) as ToolDefinition;
}

function render(
	query: string,
	papers: readonly PaperRecord[],
	failures: readonly BackendResult[],
	yearMin: number | undefined,
): string {
	const lines: string[] = [];
	const filter = yearMin === undefined ? "" : ` (from ${yearMin})`;

	if (papers.length === 0) {
		lines.push(
			`No results for "${query}"${filter}.`,
			"",
			"An empty result usually means the query is wrong rather than the topic unstudied:",
			"try the field's own terminology, drop a qualifier, or split a compound idea into",
			"its parts and search those separately.",
		);
	} else {
		lines.push(`${papers.length} result(s) for "${query}"${filter}:`, "");
		for (const [index, paper] of papers.entries()) {
			const meta = [
				paper.year === undefined ? undefined : String(paper.year),
				paper.venue,
			]
				.filter((part) => part !== undefined && part !== "")
				.join(", ");
			const ids = [
				paper.doi === undefined ? undefined : `doi:${paper.doi}`,
				paper.arxivId === undefined ? undefined : `arXiv:${paper.arxivId}`,
			]
				.filter((part) => part !== undefined)
				.join(" ");

			lines.push(
				`${index + 1}. ${paper.title}${meta === "" ? "" : ` (${meta})`}` +
					`${ids === "" ? "" : ` [${ids}]`}` +
					` — cited ${paper.citationCount ?? "?"}` +
					`, open-access PDF: ${paper.pdfUrl === undefined ? "no" : "yes"}`,
			);
			if (paper.abstract !== undefined) lines.push(`   ${head(paper.abstract)}`);
		}
	}

	// A backend that was down narrows the result set, and a planner reading a
	// short list as "little prior work" would draw exactly the wrong conclusion.
	if (failures.length > 0) {
		lines.push(
			"",
			`Warning: ${failures.map((f) => f.backend).join(", ")} did not answer, so this ` +
				"list is narrower than the literature. Do not read it as an absence of work.",
		);
	}

	return lines.join("\n");
}

function head(abstract: string): string {
	const words = abstract.split(/\s+/);
	return words.length <= ABSTRACT_WORDS
		? abstract
		: `${words.slice(0, ABSTRACT_WORDS).join(" ")}…`;
}

function keepYear(paper: PaperRecord, yearMin: number | undefined): boolean {
	// A paper with no year survives the filter: dropping it would hide preprints
	// and tech reports, which are exactly the recent work a year filter is after.
	if (yearMin === undefined || paper.year === undefined) return true;
	return paper.year >= yearMin;
}

/**
 * True when the string carries characters outside Latin script and common
 * punctuation — CJK, Cyrillic, Arabic, Devanagari and the rest.
 */
function hasNonLatinScript(value: string): boolean {
	return /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(value);
}

function clamp(value: number, low: number, high: number): number {
	return Math.min(high, Math.max(low, Math.round(value)));
}

function text(message: string, isError = false): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
	isError?: boolean;
} {
	return { content: [{ type: "text", text: message }], details: undefined, ...(isError ? { isError } : {}) };
}
