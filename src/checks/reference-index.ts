import * as fs from "node:fs";
import * as path from "node:path";

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * A scannable index over the reference cards.
 *
 * Deterministic on purpose. The cards themselves are worth a model call each —
 * distilling a paper's claims and stated limits is judgement work. Collating
 * them is not, and paying a model to re-read several hundred cards every run
 * would cost more than producing them did.
 *
 * The index exists because of a budget: several hundred cards at ~200 words is
 * roughly 70k tokens, which fits in a large context but wastes most of it. One
 * line per paper is nearer 25 tokens, so a writer can hold the whole library at
 * once, then open the three cards that matter, then the one paper. Each level
 * narrows by roughly an order of magnitude.
 */

/** Titles listed per keyword before the group falls back to a count. */
const TAG_EXAMPLES = 8;

export interface ReferenceCard {
	file: string;
	title: string;
	authors: string;
	year: string;
	venue: string;
	kind: string;
	tags: string[];
	citeFor: string;
}

export interface IndexReport {
	cards: ReferenceCard[];
	/** Cards whose frontmatter could not be read at all. */
	unreadable: string[];
	/** Cards missing a title, which is the one field the index cannot fake. */
	untitled: string[];
	markdown: string;
}

interface CardFrontmatter {
	title?: unknown;
	authors?: unknown;
	year?: unknown;
	venue?: unknown;
	kind?: unknown;
	tags?: unknown;
	cite_for?: unknown;
	[key: string]: unknown;
}

export interface BuildIndexOptions {
	workspace: string;
	/** Directory of cards, relative to the workspace. */
	from: string;
}

export function buildReferenceIndex(options: BuildIndexOptions): IndexReport {
	const root = path.resolve(options.workspace, options.from);
	const cards: ReferenceCard[] = [];
	const unreadable: string[] = [];
	const untitled: string[] = [];

	for (const file of listCards(root)) {
		const relative = path.relative(options.workspace, file).replaceAll("\\", "/");
		let frontmatter: CardFrontmatter;
		try {
			({ frontmatter } = parseFrontmatter<CardFrontmatter>(fs.readFileSync(file, "utf-8")));
		} catch {
			unreadable.push(relative);
			continue;
		}

		const title = text(frontmatter.title);
		// A card with no title is still listed — under its filename, which is
		// derived from the source document and is usually the title anyway.
		// Dropping it would hide the paper from the only index that exists.
		if (title === "") untitled.push(relative);

		cards.push({
			file: relative,
			title: title === "" ? path.basename(file, ".md") : title,
			authors: text(frontmatter.authors) || "unknown",
			year: text(frontmatter.year) || "unknown",
			venue: text(frontmatter.venue) || "unknown",
			kind: text(frontmatter.kind) || "unknown",
			tags: tagList(frontmatter.tags),
			citeFor: text(frontmatter.cite_for),
		});
	}

	// Newest first: recency is the one ordering a writer nearly always wants,
	// and an unknown year sorts last rather than pretending to be year zero.
	cards.sort((a, b) => {
		const byYear = yearKey(b.year) - yearKey(a.year);
		return byYear !== 0 ? byYear : a.title.localeCompare(b.title);
	});

	return { cards, unreadable, untitled, markdown: render(cards, unreadable, untitled) };
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

function text(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (typeof value === "number") return String(value);
	return "";
}

function tagList(value: unknown): string[] {
	const raw = Array.isArray(value)
		? value.map((entry) => text(entry))
		: text(value).split(",");
	return raw.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
}

function yearKey(year: string): number {
	const parsed = Number.parseInt(year, 10);
	return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

/** Pipes inside a title would otherwise split the row into extra columns. */
function cell(value: string): string {
	return value.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function render(
	cards: readonly ReferenceCard[],
	unreadable: readonly string[],
	untitled: readonly string[],
): string {
	// The directory is stated once rather than repeated on every row: at several
	// hundred papers that prefix alone is kilobytes of an artifact whose whole
	// purpose is to stay small enough to read in one go.
	const directory = cards.length > 0 ? path.posix.dirname(cards[0]?.file ?? "") : "";

	const lines: string[] = [
		"# Reference index",
		"",
		`${cards.length} paper(s). One line each, newest first.`,
		"",
		"Grep this file for a topic before reading any card, and read a card before",
		"opening the paper it describes. `Cite for` is what each paper can support.",
		...(directory === "" ? [] : ["", `Cards are in \`${directory}/\`.`]),
		"",
	];

	if (cards.length > 0) {
		lines.push("| Year | Venue | Title | Cite for | Card |", "|---|---|---|---|---|");
		for (const card of cards) {
			lines.push(
				`| ${cell(card.year)} | ${cell(card.venue)} | ${cell(card.title)} ` +
					`| ${cell(card.citeFor)} | \`${path.posix.basename(card.file)}\` |`,
			);
		}
		lines.push("");
	}

	const byTag = new Map<string, string[]>();
	for (const card of cards) {
		for (const tag of card.tags) {
			byTag.set(tag, [...(byTag.get(tag) ?? []), card.title]);
		}
	}

	if (byTag.size > 0) {
		lines.push(
			"## By keyword",
			"",
			"Keywords come from each card independently, so they are a search aid rather",
			"than a taxonomy: the same idea may appear under more than one key.",
			"",
		);
		// Commonest first, so the groups that actually cluster the library lead.
		// Examples are capped: a keyword covering two hundred papers is not a
		// discriminator, and listing all of them would duplicate the table above
		// and double the size of the file for no extra information.
		for (const [tag, titles] of [...byTag].sort(
			(a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]),
		)) {
			const shown = titles.slice(0, TAG_EXAMPLES);
			const rest = titles.length - shown.length;
			lines.push(
				`- **${tag}** (${titles.length}): ${shown.join("; ")}` +
					(rest > 0 ? `; …${rest} more — grep the table` : ""),
			);
		}
		lines.push("");
	}

	if (untitled.length > 0 || unreadable.length > 0) {
		lines.push("## Cards needing attention", "");
		for (const file of unreadable) lines.push(`- \`${file}\` — frontmatter could not be parsed`);
		for (const file of untitled) lines.push(`- \`${file}\` — no title; listed under its filename`);
		lines.push("");
	}

	return `${lines.join("\n").trimEnd()}\n`;
}
