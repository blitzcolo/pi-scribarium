import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveItems } from "../../src/pipeline/items.js";
import { RunLayout } from "../../src/workspace/layout.js";

let workspace: string;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-items-"));
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

function write(relative: string, body = "x"): void {
	const target = path.join(workspace, relative);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, body);
}

describe("resolveItems", () => {
	it("derives a stable slug id from the filename stem", () => {
		write("corpus/text/Smith 2020.md");
		write("corpus/text/jones-2019.md");

		// Ordered by path, so ids do not depend on directory iteration order.
		const items = resolveItems({ kind: "glob", pattern: "corpus/text/*.md" }, workspace);
		expect(items.map((item) => item.id)).toEqual(["smith-2020", "jones-2019"]);
	});

	// The loader refuses a foreach output that does not mention ${item.*}, because
	// otherwise every item writes one path and N sessions race on it. Two items
	// sharing an id reintroduce that race by the back door.
	it("refuses two glob matches whose stems slug to the same id", () => {
		write("corpus/text/Smith 2020.md");
		write("corpus/text/smith-2020.md");

		expect(() => resolveItems({ kind: "glob", pattern: "corpus/text/*.md" }, workspace)).toThrow(
			/collide on id "smith-2020"/,
		);
	});

	it("refuses the same stem coming from two directories", () => {
		write("refs/a/intro.md");
		write("refs/b/intro.md");

		expect(() => resolveItems({ kind: "glob", pattern: "refs/**/*.md" }, workspace)).toThrow(
			/collide on id "intro"/,
		);
	});

	// The shipped pipeline fans out over outline/sections.json, whose ids are
	// invented by the outliner model — two sections that slug alike are entirely
	// plausible, and used to silently drop one section from the draft.
	it("refuses duplicate ids from a json or literal item list", () => {
		expect(() =>
			resolveItems(
				{ kind: "items", values: [{ id: "methods" }, { id: "Methods" }] },
				workspace,
			),
		).toThrow(/collide on id "methods"/);
	});

	it("names both offenders so the collision is actionable", () => {
		write("refs/a/intro.md");
		write("refs/b/intro.md");

		expect(() => resolveItems({ kind: "glob", pattern: "refs/**/*.md" }, workspace)).toThrow(
			/refs\/a\/intro\.md and refs\/b\/intro\.md/,
		);
	});
});

describe("workspace containment", () => {
	// path.join *normalizes* `..` rather than rejecting it, and not every path
	// reaching artifact() is a literal from the pipeline: a JSON items source
	// spreads arbitrary fields into the template scope, and only `item.id` is
	// slugged. So `output: draft/${item.stem}.md` with a stem of `../../tmp/x`
	// wrote outside the workspace, with mkdirSync(recursive) creating the path.
	it("refuses an artifact path that leaves the workspace", () => {
		const layout = new RunLayout(workspace, "20260101T000000-abcd");

		expect(layout.artifact("draft/intro.md")).toBe(path.join(workspace, "draft", "intro.md"));
		// Normalizing within the workspace is still fine.
		expect(layout.artifact("draft/../final.md")).toBe(path.join(workspace, "final.md"));

		expect(() => layout.artifact("../../../tmp/pwn.md")).toThrow(/outside the workspace/);
		expect(() => layout.artifact("/etc/passwd")).toThrow(/outside the workspace/);
	});
});
