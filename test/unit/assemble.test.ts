import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runBuiltin } from "../../src/pipeline/builtins.js";
import type { BuiltinStepSpec } from "../../src/pipeline/schema.js";

let workspace: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-assemble-"));
	fs.mkdirSync(path.join(workspace, "draft"), { recursive: true });
	fs.mkdirSync(path.join(workspace, "outline"), { recursive: true });
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

const step: BuiltinStepSpec = {
	kind: "builtin",
	id: "assemble",
	run: "assemble",
	with: {},
	outputs: [],
};

const ctx = () => ({
	workspace,
	resolveOutput: (p: string) => path.join(workspace, p),
});

function writeSections(ids: Array<{ id: string; title: string }>): void {
	fs.writeFileSync(
		path.join(workspace, "outline", "sections.json"),
		JSON.stringify({ sections: ids }),
	);
}

describe("assemble", () => {
	it("concatenates sections in outline order, not filesystem order", async () => {
		writeSections([
			{ id: "intro", title: "Introduction" },
			{ id: "method", title: "Method" },
			{ id: "results", title: "Results" },
		]);
		// Written in a deliberately different order.
		fs.writeFileSync(path.join(workspace, "draft", "results.md"), "## Results\n\nR.");
		fs.writeFileSync(path.join(workspace, "draft", "intro.md"), "## Introduction\n\nI.");
		fs.writeFileSync(path.join(workspace, "draft", "method.md"), "## Method\n\nM.");

		const result = await runBuiltin(step, ctx());
		const paper = fs.readFileSync(path.join(workspace, "draft", "paper.md"), "utf-8");

		expect(result.ok).toBe(true);
		expect(paper.indexOf("Introduction")).toBeLessThan(paper.indexOf("Method"));
		expect(paper.indexOf("Method")).toBeLessThan(paper.indexOf("Results"));
	});

	// A silently dropped section reads as a deliberate omission to whoever
	// reviews the draft; a marker reads as the failure it is.
	it("marks a section that was never drafted rather than skipping it", async () => {
		writeSections([
			{ id: "intro", title: "Introduction" },
			{ id: "method", title: "Method" },
		]);
		fs.writeFileSync(path.join(workspace, "draft", "intro.md"), "## Introduction\n\nI.");

		const result = await runBuiltin(step, ctx());
		const paper = fs.readFileSync(path.join(workspace, "draft", "paper.md"), "utf-8");

		expect(result.ok).toBe(true);
		expect(result.summary).toMatch(/1\/2 section/);
		expect(result.summary).toMatch(/missing: method/);
		expect(paper).toContain("SECTION MISSING: method");
	});

	it("fails clearly when the section list is unreadable or empty", async () => {
		expect((await runBuiltin(step, ctx())).ok).toBe(false);

		writeSections([]);
		const empty = await runBuiltin(step, ctx());
		expect(empty.ok).toBe(false);
		expect(empty.error).toMatch(/no sections/);
	});
});
