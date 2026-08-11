import * as fs from "node:fs";
import * as path from "node:path";

import { parse as parseYaml } from "yaml";

import { normalizeTitle } from "../search/dedupe.js";
import type { PaperRecord, QuerySpec } from "../search/types.js";

/**
 * Collate the follow-up references the analysts flagged into a second search.
 *
 * Bibliographic snowballing: the papers that matter to a question are often
 * cited by the papers a keyword search finds, but do not themselves match the
 * keywords. One extra round catches most of them; the returns fall off sharply
 * after that, which is why the pipeline expresses two rounds structurally
 * instead of looping.
 *
 * Deterministic on purpose. The judgement — is this reference worth chasing —
 * already happened in the session that read the paper and wrote the reason.
 * Counting how many analysts independently named the same work is arithmetic,
 * and a model asked to do it would be paid to re-read every card.
 */

export interface FollowupCandidate {
	title: string;
	authors?: string;
	year?: number;
	doi?: string;
	arxivId?: string;
	/** Why it was flagged, quoted from the cards that named it. */
	reasons: string[];
	/** How many distinct cards named it. The ranking signal. */
	mentions: number;
	/** Cards that named it, for the human reviewing the round-2 list. */
	citedBy: string[];
	/** Innovation points the citing cards were relevant to. */
	points: string[];
}

export interface FollowupReport {
	kept: FollowupCandidate[];
	/** Ranked but cut by the cap, so the coverage report can say how many. */
	dropped: FollowupCandidate[];
	/** Already fetched in round one. */
	known: number;
	/** Cards whose frontmatter could not be read. */
	unreadable: string[];
	queries: QuerySpec[];
	markdown: string;
}

interface CardFrontmatter {
	title?: unknown;
	related_points?: unknown;
	followups?: unknown;
}

export interface CollateFollowupsOptions {
	workspace: string;
	/** Directory of analyst cards, relative to the workspace. */
	cards: string;
	/** Papers already fetched, so round two does not re-propose them. */
	known: readonly PaperRecord[];
	/** Ceiling across both rounds; the round-two budget is what is left of it. */
	maxTotal: number;
}

export function collateFollowups(options: CollateFollowupsOptions): FollowupReport {
	const root = path.resolve(options.workspace, options.cards);
	const unreadable: string[] = [];
	const byKey = new Map<string, FollowupCandidate>();

	for (const file of listCards(root)) {
		const relative = path.relative(options.workspace, file).replaceAll("\\", "/");
		let frontmatter: CardFrontmatter;
		try {
			frontmatter = readFrontmatter(fs.readFileSync(file, "utf-8"));
		} catch {
			// One malformed card must not cost the other ninety-nine their follow-ups.
			unreadable.push(relative);
			continue;
		}

		const points = stringList(frontmatter.related_points);
		const name = path.basename(file, ".md");

		for (const raw of Array.isArray(frontmatter.followups) ? frontmatter.followups : []) {
			const entry = toCandidate(raw, name, points);
			if (entry === undefined) continue;

			const key = candidateKey(entry);
			const existing = byKey.get(key);
			if (existing === undefined) {
				byKey.set(key, entry);
				continue;
			}
			// Two analysts naming the same work is the signal the ranking rests on,
			// so mentions count distinct cards rather than repeated lines.
			existing.mentions += 1;
			existing.citedBy = [...new Set([...existing.citedBy, ...entry.citedBy])];
			existing.reasons = [...new Set([...existing.reasons, ...entry.reasons])];
			existing.points = [...new Set([...existing.points, ...entry.points])];
			// One analyst may have recorded a DOI where another gave only a title;
			// keeping the first identifier seen upgrades the round-2 lookup from a
			// fuzzy title search to a direct one.
			if (existing.doi === undefined && entry.doi !== undefined) existing.doi = entry.doi;
			if (existing.arxivId === undefined && entry.arxivId !== undefined) {
				existing.arxivId = entry.arxivId;
			}
			if (existing.year === undefined && entry.year !== undefined) existing.year = entry.year;
			if (existing.authors === undefined && entry.authors !== undefined) {
				existing.authors = entry.authors;
			}
		}
	}

	const knownKeys = new Set(options.known.map((paper) => knownKey(paper)));
	const fresh = [...byKey.values()].filter((entry) => !knownKeys.has(candidateKey(entry)));

	// Most-cited first; ties fall back to the title so the order does not depend
	// on directory iteration.
	fresh.sort((a, b) => b.mentions - a.mentions || a.title.localeCompare(b.title));

	const budget = Math.max(0, options.maxTotal - options.known.length);
	const kept = fresh.slice(0, budget);
	const dropped = fresh.slice(budget);

	return {
		kept,
		dropped,
		known: options.known.length,
		unreadable,
		queries: kept.map(toQuery),
		markdown: render(kept, dropped, options.known.length, options.maxTotal, unreadable),
	};
}

/**
 * A direct identifier lookup where one is known, a title search otherwise.
 *
 * The point carried through is the first one that cited it, so a round-two paper
 * still lands in an evidence packet rather than floating unattached.
 */
function toQuery(entry: FollowupCandidate): QuerySpec {
	const point = entry.points[0] ?? "ip-1";
	if (entry.doi !== undefined) return { kind: "id", point, doi: entry.doi, title: entry.title };
	if (entry.arxivId !== undefined) {
		return { kind: "id", point, arxivId: entry.arxivId, title: entry.title };
	}
	return { kind: "id", point, title: entry.title };
}

function toCandidate(
	raw: unknown,
	card: string,
	points: readonly string[],
): FollowupCandidate | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const entry = raw as Record<string, unknown>;

	const title = text(entry["title"]);
	// A follow-up with no title cannot be searched for and cannot be shown to a
	// human deciding what to chase, so there is nothing to keep.
	if (title === "") return undefined;

	const candidate: FollowupCandidate = {
		title,
		reasons: [text(entry["reason"])].filter((reason) => reason !== ""),
		mentions: 1,
		citedBy: [card],
		points: [...points],
	};

	const authors = text(entry["authors"]);
	if (authors !== "") candidate.authors = authors;

	const year = Number.parseInt(text(entry["year"]), 10);
	if (Number.isFinite(year) && year > 1800) candidate.year = year;

	const doi = text(entry["doi"])
		.replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
		.toLowerCase();
	if (doi.startsWith("10.")) candidate.doi = doi;

	const arxiv = text(entry["arxiv"]) || text(entry["arxivId"]);
	if (arxiv !== "") candidate.arxivId = arxiv.replace(/v\d+$/i, "");

	return candidate;
}

/** Same precedence as the search layer, so the two agree on what is a duplicate. */
function candidateKey(entry: FollowupCandidate): string {
	if (entry.doi !== undefined) return `doi:${entry.doi}`;
	if (entry.arxivId !== undefined) return `arxiv:${entry.arxivId}`;
	return `title:${normalizeTitle(entry.title)}`;
}

function knownKey(paper: PaperRecord): string {
	if (paper.doi !== undefined && paper.doi !== "") return `doi:${paper.doi}`;
	if (paper.arxivId !== undefined && paper.arxivId !== "") return `arxiv:${paper.arxivId}`;
	return `title:${normalizeTitle(paper.title)}`;
}

/**
 * Read the leading `---` block.
 *
 * Parsed with the `yaml` package rather than the SDK's `parseFrontmatter`,
 * because this module is reachable from the CLI's cheap commands and pulling the
 * SDK in would cost every one of them the twenty-second import.
 */
function readFrontmatter(content: string): CardFrontmatter {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (match === null) return {};
	const parsed = parseYaml(match[1] ?? "") as unknown;
	return typeof parsed === "object" && parsed !== null ? (parsed as CardFrontmatter) : {};
}

function listCards(root: string): string[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
		.filter((entry) => !entry.name.startsWith(".") && !entry.name.startsWith("_"))
		.map((entry) => path.join(root, entry.name))
		.sort();
}

function stringList(value: unknown): string[] {
	const raw = Array.isArray(value) ? value.map((entry) => text(entry)) : text(value).split(",");
	return raw.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number") return String(value);
	return "";
}

function render(
	kept: readonly FollowupCandidate[],
	dropped: readonly FollowupCandidate[],
	known: number,
	maxTotal: number,
	unreadable: readonly string[],
): string {
	const lines: string[] = [
		"# Follow-up references for round 2",
		"",
		`${kept.length} reference(s) proposed, ranked by how many analyses named them.`,
		`Round 1 fetched ${known} paper(s); the cap across both rounds is ${maxTotal}.`,
		"",
		"**To prune:** delete entries from `followups.json`, then approve the gate.",
		"Approving with an empty list ends the search at round 1.",
		"",
	];

	if (kept.length > 0) {
		lines.push("| Named by | Title | Year | Identifier | Why |", "|---|---|---|---|---|");
		for (const entry of kept) {
			lines.push(
				`| ${entry.mentions} | ${cell(entry.title)} | ${entry.year ?? "?"} ` +
					`| ${cell(entry.doi ?? entry.arxivId ?? "—")} | ${cell(entry.reasons.join("; "))} |`,
			);
		}
		lines.push("");
	}

	// A silent cap reads as "this is everything the analyses asked for".
	if (dropped.length > 0) {
		lines.push(
			`## Not proposed (${dropped.length})`,
			"",
			`The cap of ${maxTotal} across both rounds left room for ${kept.length} more paper(s).`,
			"These were named but will not be fetched:",
			"",
			...dropped.map((entry) => `- ${entry.title} (named by ${entry.mentions})`),
			"",
		);
	}

	if (unreadable.length > 0) {
		lines.push(
			"## Cards that could not be read",
			"",
			...unreadable.map((file) => `- \`${file}\` — frontmatter could not be parsed`),
			"",
		);
	}

	return `${lines.join("\n").trimEnd()}\n`;
}

function cell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}
