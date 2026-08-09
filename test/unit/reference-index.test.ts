import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildReferenceIndex } from "../../src/checks/reference-index.js";

let workspace: string;
let cards: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-refindex-"));
	cards = path.join(workspace, "references", "cards");
	fs.mkdirSync(cards, { recursive: true });
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

function card(name: string, frontmatter: string, body = "## Work\n\nSomething.\n"): void {
	fs.writeFileSync(path.join(cards, `${name}.md`), `---\n${frontmatter}\n---\n\n${body}`);
}

const build = () => buildReferenceIndex({ workspace, from: "references/cards" });

describe("buildReferenceIndex", () => {
	it("lists every card as one row", () => {
		card("a", 'title: Thermal Fusion\nyear: 2024\nvenue: CVPR\ncite_for: RGB-T benchmarks');
		card("b", 'title: Radiative Transfer\nyear: 2023\nvenue: TIP\ncite_for: physical priors');

		const report = build();

		expect(report.cards).toHaveLength(2);
		expect(report.markdown).toContain("| 2024 | CVPR | Thermal Fusion | RGB-T benchmarks |");
		// The directory is named once, not repeated on every row.
		expect(report.markdown).toContain("Cards are in `references/cards/`.");
		expect(report.markdown).toContain("`b.md`");
	});

	// Recency is the ordering a writer nearly always wants.
	it("sorts newest first, with an unknown year last", () => {
		card("old", "title: Old\nyear: 2019");
		card("new", "title: New\nyear: 2025");
		card("undated", "title: Undated\nyear: unknown");

		expect(build().cards.map((c) => c.title)).toEqual(["New", "Old", "Undated"]);
	});

	it("groups by keyword, commonest first", () => {
		card("a", "title: A\ntags: [fusion, thermal]");
		card("b", "title: B\ntags: [fusion]");
		card("c", "title: C\ntags: [diffusion]");

		const report = build();

		expect(report.markdown).toContain("- **fusion** (2): A; B");
		expect(report.markdown.indexOf("**fusion**")).toBeLessThan(
			report.markdown.indexOf("**diffusion**"),
		);
	});

	// The whole point of the index is that one bad card must not cost the
	// writer the other several hundred.
	it("reports an unparseable card without losing the rest", () => {
		card("good", "title: Good\nyear: 2024");
		fs.writeFileSync(path.join(cards, "bad.md"), "---\ntitle: [unclosed\n---\n\nbody\n");

		const report = build();

		expect(report.cards.some((c) => c.title === "Good")).toBe(true);
		expect(report.unreadable).toEqual(["references/cards/bad.md"]);
		expect(report.markdown).toContain("frontmatter could not be parsed");
	});

	// The filename is derived from the source document, so it is usually the
	// title anyway. Dropping the row would hide the paper entirely.
	it("falls back to the filename when a card has no title", () => {
		card("kowalski-thermal-2019", "year: 2019");

		const report = build();

		expect(report.cards[0]?.title).toBe("kowalski-thermal-2019");
		expect(report.untitled).toEqual(["references/cards/kowalski-thermal-2019.md"]);
	});

	it("escapes a pipe in a title rather than splitting the row", () => {
		card("a", 'title: "Fast | Accurate"\nyear: 2024');

		const row = build()
			.markdown.split("\n")
			.find((line) => line.includes("Fast"));

		// Five columns means six unescaped delimiters; the title's own pipe is
		// escaped and must not add a seventh.
		expect(row).toContain("Fast \\| Accurate");
		expect(row?.match(/(?<!\\)\|/g)).toHaveLength(6);
	});

	it("defaults missing fields to unknown rather than leaving them blank", () => {
		card("a", "title: Bare");

		expect(build().cards[0]).toMatchObject({ year: "unknown", venue: "unknown", authors: "unknown" });
	});

	it("skips guidance files and non-Markdown", () => {
		card("real", "title: Real\nyear: 2024");
		fs.writeFileSync(path.join(cards, "_README.md"), "---\ntitle: Guidance\n---\n");
		fs.writeFileSync(path.join(cards, "notes.txt"), "not a card");

		expect(build().cards.map((c) => c.title)).toEqual(["Real"]);
	});

	it("produces a usable index when there are no cards at all", () => {
		const report = build();

		expect(report.cards).toEqual([]);
		expect(report.markdown).toContain("0 paper(s)");
	});

	// At several hundred papers the index is the only artifact a writer can hold
	// in context, so its size is a design constraint, not an accident.
	it("stays small enough to be read whole at several hundred papers", () => {
		// Title and cite_for lengths are taken from real CVPR papers rather than
		// short fixtures, or the bound would pass on data no user will ever have.
		const topics = ["thermal-fusion", "weak-supervision", "diffusion", "hyperspectral"];
		for (let i = 0; i < 400; i++) {
			card(
				`paper-${i}`,
				`title: "Physically Consistent Thermal Infrared Radiative Transfer Number ${i}: A Study"\n` +
					`authors: Surname, Surname, Surname et al.\n` +
					`year: ${2018 + (i % 9)}\nvenue: CVPR\n` +
					`tags: [${topics[i % 4]}, ${topics[(i + 1) % 4]}]\n` +
					`cite_for: Benchmark for RGB-thermal detection under low-light conditions`,
			);
		}

		const report = build();

		expect(report.cards).toHaveLength(400);
		// ~4 chars per token: 100 KB is roughly 25k tokens — a tenth of the
		// context we target, against ~90k tokens for the cards themselves and
		// ~2.4M for the papers they describe. Each level narrows by an order of
		// magnitude, which is what makes the three-tier lookup work.
		expect(Buffer.byteLength(report.markdown, "utf-8")).toBeLessThan(100 * 1024);
	});

	// A keyword shared by hundreds of papers is not a discriminator; listing
	// them all would duplicate the table and double the file for nothing.
	it("caps the examples under a keyword that covers most of the library", () => {
		for (let i = 0; i < 50; i++) card(`p-${i}`, `title: Paper ${i}\ntags: [fusion]`);

		const report = build();

		expect(report.markdown).toContain("**fusion** (50)");
		expect(report.markdown).toContain("…42 more — grep the table");
	});
});
