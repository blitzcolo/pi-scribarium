import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	collectCorpusInputs,
	formatPageRanges,
	ingestCorpus,
	parseExtensionFilter,
	slugify,
} from "../../src/ingest/pdf.js";
import { bodyPage, minimalPdf } from "../helpers/minimal-pdf.js";

let root: string;
let corpus: string;
let outDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-ingest-"));
	corpus = path.join(root, "corpus");
	outDir = path.join(root, "corpus", "text");
	fs.mkdirSync(corpus, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

/**
 * Pages are padded to a realistic density by default. Ingest treats a page
 * below `MIN_PAGE_CHARACTERS` as having no text layer, so a fixture built from
 * a bare marker would be a scan as far as the code is concerned — pass `raw`
 * when that is what the test is about.
 */
function writePdf(name: string, pages: string[], raw = false): string {
	const target = path.join(corpus, name);
	fs.writeFileSync(target, minimalPdf(raw ? pages : pages.map((page) => bodyPage(page))));
	return target;
}

describe("ingestCorpus", () => {
	it("extracts text from a real PDF through pdf.js", async () => {
		const source = writePdf("Smith et al. 2021.pdf", ["FIRST_PAGE_MARKER"]);

		const result = await ingestCorpus({ inputs: [source], outDir });

		expect(result.failed).toBe(0);
		const file = result.files[0];
		expect(file?.status).toBe("extracted");
		expect(file?.totalPages).toBe(1);

		// The slug is derived from the file name, so downstream stages get stable
		// ids regardless of how the paper was named.
		expect(path.basename(file?.outputPath ?? "")).toBe("smith-et-al-2021.md");

		const written = fs.readFileSync(file?.outputPath ?? "", "utf-8");
		expect(written).toContain("FIRST_PAGE_MARKER");
		expect(written).toContain(`source: ${JSON.stringify(source)}`);
		expect(written).toContain("pages: 1");
	});

	it("keeps page boundaries so later stages can cite a page", async () => {
		const source = writePdf("multi.pdf", ["ALPHA_PAGE", "BETA_PAGE", "GAMMA_PAGE"]);

		const result = await ingestCorpus({ inputs: [source], outDir });
		const written = fs.readFileSync(result.files[0]?.outputPath ?? "", "utf-8");

		expect(result.files[0]?.totalPages).toBe(3);
		expect(written).toContain("<!-- page 1 -->");
		expect(written).toContain("<!-- page 3 -->");
		expect(written.indexOf("ALPHA_PAGE")).toBeLessThan(written.indexOf("BETA_PAGE"));
		expect(written.indexOf("BETA_PAGE")).toBeLessThan(written.indexOf("GAMMA_PAGE"));
	});

	// Guards a fixture flaw that made extraction look lossy: a single over-wide
	// Tj line runs past the MediaBox and pdf.js drops the overflowing glyphs.
	// Real PDFs wrap their text, and so must the fixture — otherwise this suite
	// would happily pass while every page silently lost most of its content.
	it("round-trips a full page of prose without dropping text", async () => {
		const sentences = Array.from(
			{ length: 40 },
			(_, i) => `Sentence ${i} states a distinct and clearly identifiable fact about the study.`,
		);
		const source = writePdf("long.pdf", [sentences.join(" ")], true);

		const result = await ingestCorpus({ inputs: [source], outDir });
		const written = fs.readFileSync(result.files[0]?.outputPath ?? "", "utf-8");
		// Line breaks fall wherever the page wrapped them; the claim under test is
		// that no content was lost, not that layout was preserved.
		const flattened = written.replace(/\s+/g, " ");

		// Every sentence must survive, not merely the first screenful.
		for (const index of [0, 13, 27, 39]) {
			expect(flattened).toContain(`Sentence ${index} states`);
		}
		expect(result.files[0]?.characters ?? 0).toBeGreaterThan(2500);
	});

	it("passes existing text documents through unchanged", async () => {
		const source = path.join(corpus, "notes.md");
		fs.writeFileSync(source, "# Already text\n\nBODY_MARKER\n");

		const result = await ingestCorpus({ inputs: [source], outDir });

		expect(result.files[0]?.status).toBe("copied");
		expect(fs.readFileSync(result.files[0]?.outputPath ?? "", "utf-8")).toContain("BODY_MARKER");
	});

	it("isolates a corrupt file instead of failing the batch", async () => {
		const good = writePdf("good.pdf", ["GOOD_TEXT"]);
		const broken = path.join(corpus, "broken.pdf");
		fs.writeFileSync(broken, "this is definitely not a pdf");

		const result = await ingestCorpus({ inputs: [good, broken], outDir });

		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(1);
		expect(result.files.find((f) => f.sourcePath === broken)?.status).toBe("failed");
		expect(result.files.find((f) => f.sourcePath === good)?.status).toBe("extracted");
	});

	// A scanned paper yields zero characters. Left undetected it would reach the
	// analyst as an empty document and burn a model call producing nothing.
	it("flags a PDF with no extractable text as needing OCR", async () => {
		const source = writePdf("scan.pdf", ["", "", ""], true);

		const result = await ingestCorpus({ inputs: [source], outDir });

		expect(result.files[0]?.status).toBe("failed");
		expect(result.files[0]?.error).toMatch(/OCR/);
		expect(result.files[0]?.error).toContain("any of 3 page(s)");
	});

	/**
	 * A total-character check passes all of these, which is how they used to
	 * reach an analysis agent looking like ordinary papers. The agent is told to
	 * read the document start to finish and has no way to know it was handed a
	 * tenth of one, so it reports confidently on a paper it never saw.
	 */
	describe("partly scanned PDFs", () => {
		it("refuses a paper whose text survives on only one page in ten", async () => {
			const pages = [bodyPage("ONLY_REAL_PAGE"), ...Array<string>(9).fill("")];
			const source = writePdf("partial.pdf", pages, true);

			const result = await ingestCorpus({ inputs: [source], outDir });

			expect(result.files[0]?.status).toBe("failed");
			expect(result.files[0]?.error).toContain("9 of 10 page(s)");
			// The specific pages, so the reader knows what to OCR.
			expect(result.files[0]?.error).toContain("2-10");
		});

		// The thin layer a scanner leaves behind: page numbers and a header
		// stamp, extracting to a few characters per page.
		it("refuses a scan whose only extractable text is page numbers", async () => {
			const source = writePdf("thin.pdf", ["1", "2", "3", "4", "5", "6"], true);

			const result = await ingestCorpus({ inputs: [source], outDir });

			expect(result.files[0]?.status).toBe("failed");
			expect(result.files[0]?.error).toMatch(/OCR/);
		});

		// A full-page figure is ordinary — 1 page in 237 of the measured corpus
		// is legitimately near-empty — so a few gaps must not reject the paper.
		it("extracts a paper with a couple of figure pages, recording which", async () => {
			const pages = [bodyPage("P1"), "", bodyPage("P3"), bodyPage("P4"), bodyPage("P5")];
			const source = writePdf("figures.pdf", pages, true);

			const result = await ingestCorpus({ inputs: [source], outDir });

			expect(result.files[0]?.status).toBe("extracted");
			expect(result.files[0]?.textlessPages).toEqual([2]);
			// Recorded in the document, so the agent reading it knows the gap is
			// in the original rather than in its own reading.
			const written = fs.readFileSync(result.files[0]?.outputPath ?? "", "utf-8");
			expect(written).toContain("textless_pages: [2]");
		});

		it("says nothing about textless pages when there are none", async () => {
			const source = writePdf("clean.pdf", ["A", "B"]);

			const result = await ingestCorpus({ inputs: [source], outDir });

			expect(result.files[0]?.textlessPages).toBeUndefined();
			expect(fs.readFileSync(result.files[0]?.outputPath ?? "", "utf-8")).not.toContain(
				"textless_pages",
			);
		});
	});

	it("skips work when the output is already current, unless forced", async () => {
		const source = writePdf("cached.pdf", ["CACHED"]);

		expect((await ingestCorpus({ inputs: [source], outDir })).files[0]?.status).toBe("extracted");
		expect((await ingestCorpus({ inputs: [source], outDir })).files[0]?.status).toBe("skipped");
		expect(
			(await ingestCorpus({ inputs: [source], outDir, force: true })).files[0]?.status,
		).toBe("extracted");
	});

	it("disambiguates identical file names from different directories", async () => {
		const a = path.join(corpus, "a");
		const b = path.join(corpus, "b");
		fs.mkdirSync(a);
		fs.mkdirSync(b);
		fs.writeFileSync(path.join(a, "paper.pdf"), minimalPdf([bodyPage("FROM_A")]));
		fs.writeFileSync(path.join(b, "paper.pdf"), minimalPdf([bodyPage("FROM_B")]));

		const result = await ingestCorpus({
			inputs: [path.join(a, "paper.pdf"), path.join(b, "paper.pdf")],
			outDir,
		});

		const names = result.files.map((f) => path.basename(f.outputPath));
		expect(new Set(names).size).toBe(2);
		expect(names).toEqual(["paper.md", "paper-2.md"]);
	});
});

describe("collectCorpusInputs", () => {
	it("expands a directory to its supported documents, sorted", () => {
		fs.writeFileSync(path.join(corpus, "b.pdf"), minimalPdf([bodyPage("B")]));
		fs.writeFileSync(path.join(corpus, "a.md"), "a");
		fs.writeFileSync(path.join(corpus, "ignore.csv"), "x,y");

		expect(collectCorpusInputs([corpus]).map((p) => path.basename(p))).toEqual(["a.md", "b.pdf"]);
	});

	it("ignores paths that do not exist", () => {
		expect(collectCorpusInputs([path.join(root, "nope")])).toEqual([]);
	});

	// source/ extracts PDFs only. Copying the author's Markdown into
	// source/text/ as well would put the same material in front of a writing
	// agent twice, once at each path.
	it("narrows a directory scan to the requested extensions", () => {
		fs.writeFileSync(path.join(corpus, "results.pdf"), minimalPdf([bodyPage("R")]));
		fs.writeFileSync(path.join(corpus, "notes.md"), "notes");
		fs.writeFileSync(path.join(corpus, "draft.tex"), "draft");

		expect(
			collectCorpusInputs([corpus], new Set([".pdf"])).map((p) => path.basename(p)),
		).toEqual(["results.pdf"]);
	});

	it("still passes an explicitly named file through unfiltered", () => {
		// So an unsupported extension fails with a per-file reason rather than
		// vanishing into "no documents found".
		const odd = path.join(corpus, "notes.docx");
		fs.writeFileSync(odd, "x");

		expect(collectCorpusInputs([odd])).toEqual([odd]);
	});
});

describe("formatPageRanges", () => {
	it.each([
		[[3], "3"],
		[[3, 4, 5], "3-5"],
		[[2, 4, 5, 6, 9], "2, 4-6, 9"],
		[[], ""],
	])("renders %j as %j", (pages, expected) => {
		expect(formatPageRanges(pages)).toBe(expected);
	});
});

describe("parseExtensionFilter", () => {
	it.each([
		["pdf", [".pdf"]],
		[".pdf", [".pdf"]],
		["pdf, md", [".pdf", ".md"]],
		[["pdf", ".tex"], [".pdf", ".tex"]],
	])("parses %j", (input, expected) => {
		expect([...(parseExtensionFilter(input) ?? [])]).toEqual(expected);
	});

	it.each([undefined, "", "  ,  ", 7])("treats %j as no filter", (input) => {
		expect(parseExtensionFilter(input)).toBeUndefined();
	});
});

describe("slugify", () => {
	it.each([
		["Smith et al. 2021.pdf", "smith-et-al-2021"],
		["  spaced  name .md", "spaced-name"],
		["ALLCAPS.PDF", "allcaps"],
		["....pdf", "document"],
	])("turns %j into %j", (input, expected) => {
		expect(slugify(input)).toBe(expected);
	});
});

describe("LaTeX sources", () => {
	// A journal corpus is usually PDFs, but an author's own material is often
	// .tex. It is already text, and the markup carries structure worth keeping.
	it("passes a .tex file through with its markup intact", async () => {
		const source = path.join(corpus, "manuscript.tex");
		fs.writeFileSync(
			source,
			"\\section{Method}\nWe train on \\cite{hersbach2020} profiles.\n",
		);

		const result = await ingestCorpus({ inputs: [source], outDir });

		expect(result.files[0]?.status).toBe("copied");
		const written = fs.readFileSync(result.files[0]?.outputPath ?? "", "utf-8");
		expect(written).toContain("\\section{Method}");
		expect(written).toContain("\\cite{hersbach2020}");
	});

	it("picks .tex up when scanning a directory", () => {
		fs.writeFileSync(path.join(corpus, "a.tex"), "x");
		expect(collectCorpusInputs([corpus]).map((p) => path.basename(p))).toContain("a.tex");
	});
});

describe("non-document files", () => {
	// `scribarium init` drops guidance into corpus/, and ingesting it silently
	// contaminated the journal profile with the tool's own documentation.
	it.each(["README.md", "readme.md", "_README.md", ".notes.md"])(
		"does not treat %s as a corpus document",
		(name) => {
			fs.writeFileSync(path.join(corpus, name), "guidance, not a paper");
			fs.writeFileSync(path.join(corpus, "real-paper.md"), "an actual paper");

			expect(collectCorpusInputs([corpus]).map((p) => path.basename(p))).toEqual([
				"real-paper.md",
			]);
		},
	);
});
