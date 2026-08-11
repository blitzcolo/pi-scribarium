import { normalizeDoi } from "./arxiv.js";
import { readJson, type Fetcher } from "./http.js";
import type { BackendResult, PaperRecord, QuerySpec } from "./types.js";

/**
 * Semantic Scholar's Graph API.
 *
 * The broadest of the three by discipline, and the only one that reliably
 * carries a citation count, which is how the search ranks results under a cap.
 * Unauthenticated it is rate limited hard enough that a 429 storm is normal on a
 * busy day; `SEMANTIC_SCHOLAR_API_KEY` lifts that and the polite fetcher absorbs
 * the rest. A backend that stays down returns an error value and the search
 * continues with the other two.
 */

const S2_API = "https://api.semanticscholar.org/graph/v1";

const FIELDS = [
	"paperId",
	"title",
	"abstract",
	"year",
	"venue",
	"authors",
	"citationCount",
	"openAccessPdf",
	"externalIds",
].join(",");

/** The API rejects a larger page than this on the public pool. */
const MAX_LIMIT = 100;

interface S2Paper {
	paperId?: unknown;
	title?: unknown;
	abstract?: unknown;
	year?: unknown;
	venue?: unknown;
	authors?: unknown;
	citationCount?: unknown;
	openAccessPdf?: unknown;
	externalIds?: unknown;
}

export interface SemanticScholarOptions {
	fetcher: Fetcher;
	baseUrl?: string;
}

export async function searchSemanticScholar(
	spec: QuerySpec,
	limit: number,
	options: SemanticScholarOptions,
): Promise<BackendResult> {
	const base = options.baseUrl ?? S2_API;
	const url = buildUrl(spec, limit, base);
	if (url === undefined) return { backend: "semanticscholar", papers: [] };

	try {
		const response = await options.fetcher(url);
		// A direct lookup of a paper the index does not hold is a legitimate empty
		// answer, not a failure: the follow-up reference simply is not there.
		if (spec.kind === "id" && response.status === 404) {
			return { backend: "semanticscholar", papers: [] };
		}

		const body = await readJson<{ data?: unknown } & S2Paper>(response, "Semantic Scholar");
		const raw = spec.kind === "id" ? [body] : Array.isArray(body.data) ? body.data : [];

		const papers: PaperRecord[] = [];
		for (const entry of raw) {
			const paper = toPaper(entry as S2Paper, spec);
			if (paper !== undefined) papers.push(paper);
		}
		return { backend: "semanticscholar", papers };
	} catch (cause) {
		return { backend: "semanticscholar", papers: [], error: String(cause) };
	}
}

function buildUrl(spec: QuerySpec, limit: number, base: string): string | undefined {
	if (spec.kind === "id") {
		const key = idKey(spec);
		return key === undefined ? undefined : `${base}/paper/${key}?fields=${FIELDS}`;
	}
	if (spec.query === undefined || spec.query.trim() === "") return undefined;
	const capped = Math.min(Math.max(1, limit), MAX_LIMIT);
	return (
		`${base}/paper/search?query=${encodeURIComponent(spec.query.trim())}` +
		`&limit=${capped}&fields=${FIELDS}`
	);
}

function idKey(spec: QuerySpec): string | undefined {
	if (spec.doi !== undefined && spec.doi !== "") return `DOI:${encodeURIComponent(spec.doi)}`;
	if (spec.arxivId !== undefined && spec.arxivId !== "") {
		return `arXiv:${encodeURIComponent(spec.arxivId)}`;
	}
	// Title-only follow-ups go to the search endpoint of the other backends; a
	// fuzzy title match here would silently bind the wrong paper to an id lookup.
	return undefined;
}

function toPaper(entry: S2Paper, spec: QuerySpec): PaperRecord | undefined {
	const title = text(entry.title);
	if (title === "") return undefined;

	const external = (entry.externalIds ?? {}) as Record<string, unknown>;

	const paper: PaperRecord = {
		id: "",
		title,
		authors: Array.isArray(entry.authors)
			? entry.authors
					.map((author) => text((author as { name?: unknown } | undefined)?.name))
					.filter((name) => name !== "")
			: [],
		backends: ["semanticscholar"],
		queries: spec.query === undefined ? [] : [spec.query],
		points: [spec.point],
	};

	const s2Id = text(entry.paperId);
	if (s2Id !== "") paper.s2Id = s2Id;

	const abstract = text(entry.abstract);
	if (abstract !== "") paper.abstract = abstract;

	if (typeof entry.year === "number" && Number.isFinite(entry.year)) paper.year = entry.year;

	const venue = text(entry.venue);
	if (venue !== "") paper.venue = venue;

	if (typeof entry.citationCount === "number" && Number.isFinite(entry.citationCount)) {
		paper.citationCount = entry.citationCount;
	}

	const doi = normalizeDoi(text(external["DOI"]) || undefined);
	if (doi !== undefined) paper.doi = doi;

	const arxiv = text(external["ArXiv"]).replace(/v\d+$/i, "");
	if (arxiv !== "") {
		paper.arxivId = arxiv;
		paper.pdfUrl = `https://arxiv.org/pdf/${arxiv}`;
	}

	const oa = text((entry.openAccessPdf as { url?: unknown } | undefined)?.url);
	// An explicit open-access link beats the arXiv guess: it points at the version
	// of record when there is one.
	if (oa !== "") paper.pdfUrl = oa;

	return paper;
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number") return String(value);
	return "";
}
