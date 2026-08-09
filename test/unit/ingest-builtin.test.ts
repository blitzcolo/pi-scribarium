import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuiltin } from "../../src/pipeline/builtins.js";
import type { BuiltinStepSpec } from "../../src/pipeline/schema.js";
import { minimalPdf } from "../helpers/minimal-pdf.js";

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
		seed("references", { "kowalski.pdf": minimalPdf(["REFERENCE_BODY"]) });

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
			"results.pdf": minimalPdf(["MEASURED_RESULTS"]),
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
});
