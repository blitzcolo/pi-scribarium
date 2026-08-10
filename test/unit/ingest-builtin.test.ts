import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuiltin } from "../../src/pipeline/builtins.js";
import type { BuiltinStepSpec } from "../../src/pipeline/schema.js";
import { bodyPage, minimalPdf } from "../helpers/minimal-pdf.js";

let workspace: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-ingest-builtin-"));
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

function step(options: Record<string, unknown>): BuiltinStepSpec {
	return { kind: "builtin", id: "ingest", run: "ingest", with: options, outputs: [] };
}

const ctx = () => ({
	workspace,
	resolveOutput: (p: string) => path.join(workspace, p),
});

function seed(dir: string, files: Record<string, string | Uint8Array>): void {
	fs.mkdirSync(path.join(workspace, dir), { recursive: true });
	for (const [name, body] of Object.entries(files)) {
		fs.writeFileSync(path.join(workspace, dir, name), body);
	}
}

describe("ingest builtin", () => {
	it("extracts a named directory into its own text/ subdirectory", async () => {
		seed("references", { "kowalski.pdf": minimalPdf([bodyPage("REFERENCE_BODY")]) });

		const result = await runBuiltin(step({ from: "references" }), ctx());

		expect(result.ok).toBe(true);
		const out = path.join(workspace, "references", "text", "kowalski.md");
		expect(fs.readFileSync(out, "utf-8")).toContain("REFERENCE_BODY");
	});

	// references/ and source/ may legitimately be empty: not every author has
	// literature from outside the target venue, and plenty keep their own notes
	// entirely in Markdown. Failing the run there would be wrong.
	it("treats an empty optional directory as success", async () => {
		seed("references", {});

		const result = await runBuiltin(step({ from: "references", optional: true }), ctx());

		expect(result.ok).toBe(true);
		expect(result.summary).toContain("nothing to extract");
	});

	it("treats a missing optional directory as success", async () => {
		const result = await runBuiltin(step({ from: "references", optional: true }), ctx());
		expect(result.ok).toBe(true);
	});

	// An empty corpus/ is different in kind: there is nothing to profile a venue
	// from, and every later stage depends on that profile.
	it("still fails on an empty corpus", async () => {
		seed("corpus", {});

		const result = await runBuiltin(step({ from: "corpus" }), ctx());

		expect(result.ok).toBe(false);
		expect(result.error).toContain("No .pdf, .md, .txt, or .tex files");
	});

	it("extracts only the requested extensions", async () => {
		seed("source", {
			"results.pdf": minimalPdf([bodyPage("MEASURED_RESULTS")]),
			"notes.md": "the author's own notes",
		});

		const result = await runBuiltin(step({ from: "source", only: "pdf" }), ctx());

		expect(result.ok).toBe(true);
		const textDir = path.join(workspace, "source", "text");
		// The Markdown is readable where it already is; copying it here as well
		// would show a writing agent the same material at two paths.
		expect(fs.readdirSync(textDir)).toEqual(["results.md"]);
	});

	it("reports the filtered extension when an optional directory has no match", async () => {
		seed("source", { "notes.md": "notes only" });

		const result = await runBuiltin(step({ from: "source", only: "pdf", optional: true }), ctx());

		expect(result.ok).toBe(true);
		expect(result.summary).toContain(".pdf");
	});

	/**
	 * One scan among several hundred references must not cost the other 399,
	 * which is how every fan-out in this pipeline already treats a bad item.
	 * corpus/ stays strict: it is small, hand-picked, and the profile every
	 * later stage rests on.
	 */
	// uniqueSlug never registered the name it generated, so a real `paper-2.pdf`
	// was handed the same slug the disambiguator had just invented for the second
	// `paper.pdf`: two papers written to one file, the second silently clobbering
	// the first, both reported as extracted.
	it("gives every document its own file even when the slugs would collide", async () => {
		seed("corpus", {
			"paper.pdf": minimalPdf([bodyPage("FIRST_PAPER")]),
			"Paper.pdf": minimalPdf([bodyPage("SECOND_PAPER")]),
			"paper-2.pdf": minimalPdf([bodyPage("THIRD_PAPER")]),
		});

		const result = await runBuiltin(step({ from: "corpus" }), ctx());
		expect(result.ok).toBe(true);

		const written = fs.readdirSync(path.join(workspace, "corpus", "text")).sort();
		expect(written).toHaveLength(3);

		const bodies = written.map((name) =>
			fs.readFileSync(path.join(workspace, "corpus", "text", name), "utf-8"),
		);
		for (const marker of ["FIRST_PAPER", "SECOND_PAPER", "THIRD_PAPER"]) {
			expect(bodies.some((body) => body.includes(marker))).toBe(true);
		}
	});

	describe("failure isolation", () => {
		const withOneScan = {
			"good.pdf": minimalPdf([bodyPage("READABLE")]),
			"scan.pdf": minimalPdf(["", "", ""]),
		};

		it("isolates an unreadable file in an optional directory", async () => {
			seed("references", withOneScan);

			const result = await runBuiltin(step({ from: "references", optional: true }), ctx());

			expect(result.ok).toBe(true);
			expect(result.summary).toContain("1 document(s) ready");
			expect(result.summary).toContain("1 skipped");
			// Isolated, not hidden: the reason still has to reach the reader.
			expect(result.error).toContain("scan.pdf");
			expect(result.error).toMatch(/OCR/);
		});

		it("still fails an optional directory when nothing could be read", async () => {
			seed("references", { "scan.pdf": minimalPdf(["", "", ""]) });

			const result = await runBuiltin(step({ from: "references", optional: true }), ctx());

			// Every file failing is a systematic problem, not one bad document.
			expect(result.ok).toBe(false);
		});

		it("fails the corpus on a single unreadable file", async () => {
			seed("corpus", withOneScan);

			const result = await runBuiltin(step({ from: "corpus" }), ctx());

			expect(result.ok).toBe(false);
			expect(result.error).toContain("scan.pdf");
		});
	});
});

describe("build-index builtin", () => {
	const indexStep = (options: Record<string, unknown> = {}): BuiltinStepSpec => ({
		kind: "builtin",
		id: "index-references",
		run: "build-index",
		with: options,
		outputs: [],
	});

	it("writes an index of the cards it finds", async () => {
		seed("references/cards", {
			"a.md": "---\ntitle: Thermal Fusion\nyear: 2024\n---\n\n## Work\n\nX.\n",
		});

		const result = await runBuiltin(indexStep(), ctx());

		expect(result.ok).toBe(true);
		expect(result.summary).toContain("indexed 1 card(s)");
		const index = fs.readFileSync(path.join(workspace, "references", "index.md"), "utf-8");
		expect(index).toContain("Thermal Fusion");
	});

	// An empty library is normal, and a run must not fail because the author
	// has no literature from outside their target venue.
	it("writes an empty index rather than failing when there are no cards", async () => {
		const result = await runBuiltin(indexStep(), ctx());

		expect(result.ok).toBe(true);
		expect(fs.readFileSync(path.join(workspace, "references", "index.md"), "utf-8")).toContain(
			"0 paper(s)",
		);
	});

	// Losing the index over one malformed card would be a worse trade than
	// listing it: the paper is still in the library and still citable.
	it("reports a malformed card without failing the step", async () => {
		seed("references/cards", {
			"good.md": "---\ntitle: Good\n---\n\nbody\n",
			"bad.md": "---\ntitle: [unclosed\n---\n\nbody\n",
		});

		const result = await runBuiltin(indexStep(), ctx());

		expect(result.ok).toBe(true);
		expect(result.summary).toContain("1 unparseable");
	});
});
