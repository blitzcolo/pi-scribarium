import { readText, type Fetcher } from "./http.js";
import type { BackendResult, PaperRecord, QuerySpec } from "./types.js";

/**
 * arXiv's Atom API.
 *
 * The feed is parsed by hand rather than with an XML library. It is machine
 * generated with a flat, stable shape, and we read seven fields out of it; a
 * parser dependency would be carried into every install to discard most of what
 * it produces. The extractor below is tolerant — an entry it cannot make sense
 * of is dropped with a warning rather than failing the search — and the fixtures
 * in `test/fixtures/search/` are real responses, so a feed change breaks a test
 * either way.
 */

const ARXIV_API = "http://export.arxiv.org/api/query";

/** arXiv caps a single response well below this; ask for less than it will give. */
const MAX_RESULTS = 100;

export interface ArxivOptions {
	fetcher: Fetcher;
	baseUrl?: string;
}

export async function searchArxiv(
	spec: QuerySpec,
	limit: number,
	options: ArxivOptions,
): Promise<BackendResult> {
	const url = buildUrl(spec, limit, options.baseUrl ?? ARXIV_API);
	if (url === undefined) return { backend: "arxiv", papers: [] };

	let body: string;
	try {
		body = await readText(await options.fetcher(url), "arXiv");
	} catch (cause) {
		return { backend: "arxiv", papers: [], error: String(cause) };
	}

	const papers: PaperRecord[] = [];
	for (const entry of entries(body)) {
		const paper = toPaper(entry, spec);
		if (paper !== undefined) papers.push(paper);
	}
	return { backend: "arxiv", papers };
}

function buildUrl(spec: QuerySpec, limit: number, baseUrl: string): string | undefined {
	const capped = Math.min(Math.max(1, limit), MAX_RESULTS);

	if (spec.kind === "id") {
		// A known arXiv id is a direct lookup. A DOI is not something arXiv indexes
		// by, so those go to the other backends instead of becoming a text search
		// that would match on the digits.
		if (spec.arxivId !== undefined && spec.arxivId !== "") {
			return `${baseUrl}?id_list=${encodeURIComponent(spec.arxivId)}&max_results=1`;
		}
		if (spec.title !== undefined && spec.title !== "") {
			return `${baseUrl}?search_query=${encodeURIComponent(`ti:"${spec.title}"`)}&max_results=${capped}`;
		}
		return undefined;
	}

	if (spec.query === undefined || spec.query.trim() === "") return undefined;
	const search = `all:${quote(spec.query)}`;
	return (
		`${baseUrl}?search_query=${encodeURIComponent(search)}` +
		`&start=0&max_results=${capped}&sortBy=relevance`
	);
}

/** Multi-word queries are phrase-quoted; arXiv otherwise ORs the terms. */
function quote(query: string): string {
	const cleaned = query.replaceAll('"', " ").trim();
	return cleaned.includes(" ") ? `"${cleaned}"` : cleaned;
}

function entries(xml: string): string[] {
	return [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((match) => match[1] ?? "");
}

function toPaper(entry: string, spec: QuerySpec): PaperRecord | undefined {
	const title = collapse(tagText(entry, "title"));
	const rawId = tagText(entry, "id");
	if (title === "" || rawId === "") return undefined;

	// arXiv answers a malformed query with a single entry titled "Error" whose id
	// points at the API docs. Treating that as a paper would put a fake record
	// into the corpus and cost a download and a model call to discover.
	if (title.toLowerCase() === "error" || rawId.includes("api/errors")) return undefined;

	const arxivId = arxivIdFrom(rawId);
	if (arxivId === undefined) return undefined;

	const authors = [...entry.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/g)]
		.map((match) => collapse(tagText(match[1] ?? "", "name")))
		.filter((name) => name !== "");

	const paper: PaperRecord = {
		id: "",
		title,
		authors,
		backends: ["arxiv"],
		queries: spec.query === undefined ? [] : [spec.query],
		points: [spec.point],
		arxivId,
		// The listing page is always available even when the PDF is not yet built,
		// but the PDF path is the one that matters and arXiv guarantees both.
		pdfUrl: `https://arxiv.org/pdf/${arxivId}`,
	};

	const abstract = collapse(tagText(entry, "summary"));
	if (abstract !== "") paper.abstract = abstract;

	const year = yearFrom(tagText(entry, "published"));
	if (year !== undefined) paper.year = year;

	const doi = normalizeDoi(collapse(tagText(entry, "arxiv:doi")));
	if (doi !== undefined) paper.doi = doi;

	const journal = collapse(tagText(entry, "arxiv:journal_ref"));
	paper.venue = journal === "" ? "arXiv" : journal;

	return paper;
}

/** `http://arxiv.org/abs/2401.01234v2` -> `2401.01234`, versions dropped so they merge. */
function arxivIdFrom(rawId: string): string | undefined {
	const match = /arxiv\.org\/abs\/(.+?)(?:v\d+)?$/i.exec(rawId.trim());
	const id = match?.[1];
	return id === undefined || id === "" ? undefined : id;
}

function yearFrom(published: string): number | undefined {
	const year = Number.parseInt(published.trim().slice(0, 4), 10);
	return Number.isFinite(year) && year > 1800 ? year : undefined;
}

export function normalizeDoi(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
	const cleaned = value
		.trim()
		.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
		.replace(/^doi:/i, "")
		.toLowerCase();
	return cleaned.startsWith("10.") ? cleaned : undefined;
}

/**
 * Text of the first `<name>` element, attributes and namespaces tolerated.
 *
 * Deliberately non-recursive: every field we read is a leaf, and a nested match
 * would mean the feed changed shape enough to warrant looking at it by hand.
 */
function tagText(xml: string, name: string): string {
	const pattern = new RegExp(`<${escapeRegExp(name)}\\b[^>]*>([\\s\\S]*?)</${escapeRegExp(name)}>`);
	return decodeEntities(pattern.exec(xml)?.[1] ?? "");
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decodeEntities(value: string): string {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => codePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec: string) => codePoint(Number.parseInt(dec, 10)))
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		// Ampersand last, or `&amp;lt;` would decode twice into a tag.
		.replaceAll("&amp;", "&");
}

function codePoint(value: number): string {
	return Number.isFinite(value) && value >= 0 && value <= 0x10ffff ? String.fromCodePoint(value) : "";
}

/** Titles and abstracts arrive wrapped across lines; downstream wants one line. */
function collapse(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}
