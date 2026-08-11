import { normalizeDoi } from "./arxiv.js";
import { readJson, type Fetcher } from "./http.js";
import type { BackendResult, PaperRecord, QuerySpec } from "./types.js";

/**
 * OpenAlex.
 *
 * Carries the widest coverage outside computer science, which is why it is here
 * alongside two CS-leaning indexes: a direction stated in materials science or
 * medicine would otherwise come back thin and read as "nobody has done this".
 *
 * Its abstracts arrive as an inverted index — a word-to-positions map — rather
 * than as text, so they have to be reconstructed before anything can read them.
 */

const OPENALEX_API = "https://api.openalex.org";

/** The API's own per-page ceiling. */
const MAX_PER_PAGE = 200;

interface OpenAlexWork {
	id?: unknown;
	doi?: unknown;
	display_name?: unknown;
	title?: unknown;
	publication_year?: unknown;
	cited_by_count?: unknown;
	authorships?: unknown;
	primary_location?: unknown;
	best_oa_location?: unknown;
	abstract_inverted_index?: unknown;
	ids?: unknown;
}

export interface OpenAlexOptions {
	fetcher: Fetcher;
	baseUrl?: string;
}

export async function searchOpenAlex(
	spec: QuerySpec,
	limit: number,
	options: OpenAlexOptions,
): Promise<BackendResult> {
	const base = options.baseUrl ?? OPENALEX_API;
	const url = buildUrl(spec, limit, base);
	if (url === undefined) return { backend: "openalex", papers: [] };

	try {
		const response = await options.fetcher(url);
		if (spec.kind === "id" && response.status === 404) {
			return { backend: "openalex", papers: [] };
		}

		const body = await readJson<{ results?: unknown } & OpenAlexWork>(response, "OpenAlex");
		const raw = spec.kind === "id" ? [body] : Array.isArray(body.results) ? body.results : [];

		const papers: PaperRecord[] = [];
		for (const entry of raw) {
			const paper = toPaper(entry as OpenAlexWork, spec);
			if (paper !== undefined) papers.push(paper);
		}
		return { backend: "openalex", papers };
	} catch (cause) {
		return { backend: "openalex", papers: [], error: String(cause) };
	}
}

function buildUrl(spec: QuerySpec, limit: number, base: string): string | undefined {
	const mailto = process.env["SCRIBARIUM_MAILTO"];
	// The polite pool is a documented courtesy: identified clients get the higher
	// rate limit, anonymous ones get throttled first when the service is busy.
	const contact = mailto !== undefined && mailto !== "" ? `&mailto=${encodeURIComponent(mailto)}` : "";

	if (spec.kind === "id") {
		if (spec.doi !== undefined && spec.doi !== "") {
			return `${base}/works/doi:${encodeURIComponent(spec.doi)}?${contact.slice(1)}`;
		}
		if (spec.title !== undefined && spec.title !== "") {
			return (
				`${base}/works?filter=${encodeURIComponent(`title.search:${spec.title}`)}` +
				`&per-page=5${contact}`
			);
		}
		return undefined;
	}

	if (spec.query === undefined || spec.query.trim() === "") return undefined;
	const capped = Math.min(Math.max(1, limit), MAX_PER_PAGE);
	return (
		`${base}/works?search=${encodeURIComponent(spec.query.trim())}` +
		`&per-page=${capped}${contact}`
	);
}

function toPaper(entry: OpenAlexWork, spec: QuerySpec): PaperRecord | undefined {
	const title = text(entry.display_name) || text(entry.title);
	if (title === "") return undefined;

	const paper: PaperRecord = {
		id: "",
		title,
		authors: Array.isArray(entry.authorships)
			? entry.authorships
					.map((authorship) =>
						text(
							(authorship as { author?: { display_name?: unknown } } | undefined)?.author
								?.display_name,
						),
					)
					.filter((name) => name !== "")
			: [],
		backends: ["openalex"],
		queries: spec.query === undefined ? [] : [spec.query],
		points: [spec.point],
	};

	const openAlexId = text(entry.id);
	if (openAlexId !== "") paper.openAlexId = openAlexId;

	const doi = normalizeDoi(text(entry.doi) || undefined);
	if (doi !== undefined) paper.doi = doi;

	if (typeof entry.publication_year === "number" && Number.isFinite(entry.publication_year)) {
		paper.year = entry.publication_year;
	}
	if (typeof entry.cited_by_count === "number" && Number.isFinite(entry.cited_by_count)) {
		paper.citationCount = entry.cited_by_count;
	}

	const venue = text(
		(entry.primary_location as { source?: { display_name?: unknown } } | undefined)?.source
			?.display_name,
	);
	if (venue !== "") paper.venue = venue;

	const abstract = reconstructAbstract(entry.abstract_inverted_index);
	if (abstract !== undefined) paper.abstract = abstract;

	const pdfUrl = text((entry.best_oa_location as { pdf_url?: unknown } | undefined)?.pdf_url);
	if (pdfUrl !== "") paper.pdfUrl = pdfUrl;

	return paper;
}

/**
 * Rebuild running text from OpenAlex's `{word: [positions]}` map.
 *
 * Gaps are possible — the index is built from what the publisher supplied — so
 * missing positions are dropped rather than filled, which keeps the sentence
 * readable instead of scattering it with placeholders.
 */
export function reconstructAbstract(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null) return undefined;

	const words: Array<{ position: number; word: string }> = [];
	for (const [word, positions] of Object.entries(value as Record<string, unknown>)) {
		if (!Array.isArray(positions)) continue;
		for (const position of positions) {
			if (typeof position === "number" && Number.isInteger(position) && position >= 0) {
				words.push({ position, word });
			}
		}
	}
	if (words.length === 0) return undefined;

	words.sort((a, b) => a.position - b.position);
	const text = words.map((entry) => entry.word).join(" ").replace(/\s+/g, " ").trim();
	return text === "" ? undefined : text;
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number") return String(value);
	return "";
}
