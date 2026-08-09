import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { collectCorpusInputs, ingestCorpus, slugify } from "../../src/ingest/pdf.js";
import { minimalPdf } from "../helpers/minimal-pdf.js";

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

function writePdf(name: string, pages: string[]): string {
	const target = path.join(corpus, name);
	fs.writeFileSync(target, minimalPdf(pages));
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
		const source = writePdf("long.pdf", [sentences.join(" ")]);

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
		const source = writePdf("scan.pdf", [""]);

		const result = await ingestCorpus({ inputs: [source], outDir });

		expect(result.files[0]?.status).toBe("failed");
		expect(result.files[0]?.error).toMatch(/OCR/);
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
		fs.writeFileSync(path.join(a, "paper.pdf"), minimalPdf(["FROM_A"]));
		fs.writeFileSync(path.join(b, "paper.pdf"), minimalPdf(["FROM_B"]));

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
		fs.writeFileSync(path.join(corpus, "b.pdf"), minimalPdf(["B"]));
		fs.writeFileSync(path.join(corpus, "a.md"), "a");
		fs.writeFileSync(path.join(corpus, "ignore.csv"), "x,y");

		expect(collectCorpusInputs([corpus]).map((p) => path.basename(p))).toEqual(["a.md", "b.pdf"]);
	});

	it("ignores paths that do not exist", () => {
		expect(collectCorpusInputs([path.join(root, "nope")])).toEqual([]);
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
