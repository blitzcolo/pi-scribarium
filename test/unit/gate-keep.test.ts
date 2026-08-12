import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyKeep, KeepError, readSelectable } from "../../src/gates/keep.js";
import { newRunId, RunLayout } from "../../src/workspace/layout.js";

let workspace: string;
let layout: RunLayout;

beforeEach(() => {
	workspace = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-keep-"));
	layout = new RunLayout(workspace, newRunId());
	layout.ensure();
});

afterEach(() => {
	fs.rmSync(workspace, { recursive: true, force: true });
});

const FILE = "explore/demo/candidates.json";

function write(document: unknown): void {
	const absolute = path.join(workspace, FILE);
	fs.mkdirSync(path.dirname(absolute), { recursive: true });
	fs.writeFileSync(absolute, JSON.stringify(document, null, 2), "utf-8");
}

function read(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(path.join(workspace, FILE), "utf-8")) as Record<
		string,
		unknown
	>;
}

function candidates(...ids: string[]): unknown {
	return {
		version: 1,
		direction: "multimodal fusion",
		candidates: ids.map((id) => ({ id, title: `Candidate ${id}`, queries: [`q for ${id}`] })),
	};
}

function keep(ids: string[]): ReturnType<typeof applyKeep> {
	return applyKeep({
		layout,
		stepId: "prune-candidates",
		select: { from: FILE, path: "candidates" },
		relativeFile: FILE,
		keep: ids,
		attempt: 1,
	});
}

describe("applyKeep", () => {
	it("keeps the chosen entries and deletes the rest", () => {
		write(candidates("ip-1", "ip-2", "ip-3"));

		const result = keep(["ip-1", "ip-3"]);

		expect(result.kept).toEqual(["ip-1", "ip-3"]);
		expect(result.dropped).toEqual(["ip-2"]);
		const after = read()["candidates"] as Array<{ id: string }>;
		expect(after.map((entry) => entry.id)).toEqual(["ip-1", "ip-3"]);
	});

	// The ids become fan-out item ids and artifact paths. Ordering them by how
	// someone typed a comma-separated flag would make the same decision produce a
	// different reducer prompt — the exact nondeterminism that already had to be
	// fixed once in the fan-out's own output ordering.
	it("orders survivors by the file, not by the order they were typed", () => {
		write(candidates("ip-1", "ip-2", "ip-3"));

		const result = keep(["ip-3", "ip-1"]);

		expect(result.kept).toEqual(["ip-1", "ip-3"]);
		const after = read()["candidates"] as Array<{ id: string }>;
		expect(after.map((entry) => entry.id)).toEqual(["ip-1", "ip-3"]);
	});

	it("preserves keys alongside the list", () => {
		write(candidates("ip-1", "ip-2"));

		keep(["ip-1"]);

		const after = read();
		expect(after["version"]).toBe(1);
		expect(after["direction"]).toBe("multimodal fusion");
	});

	it("keeps the whole entry, not just its id", () => {
		write(candidates("ip-1", "ip-2"));

		keep(["ip-1"]);

		const after = read()["candidates"] as Array<Record<string, unknown>>;
		expect(after[0]).toEqual({ id: "ip-1", title: "Candidate ip-1", queries: ["q for ip-1"] });
	});

	// A decision made once should not be the only copy of the work it discards —
	// the same reason a rejected step's output is archived before regeneration.
	it("archives the unfiltered list before overwriting it", () => {
		write(candidates("ip-1", "ip-2", "ip-3"));

		const result = keep(["ip-2"]);

		expect(result.archivedTo).toBeDefined();
		const archived = JSON.parse(fs.readFileSync(result.archivedTo as string, "utf-8")) as {
			candidates: Array<{ id: string }>;
		};
		expect(archived.candidates.map((entry) => entry.id)).toEqual(["ip-1", "ip-2", "ip-3"]);
	});

	it("does not archive or rewrite when nothing is dropped", () => {
		write(candidates("ip-1", "ip-2"));
		const before = fs.readFileSync(path.join(workspace, FILE), "utf-8");

		const result = keep(["ip-1", "ip-2"]);

		expect(result.dropped).toEqual([]);
		expect(result.archivedTo).toBeUndefined();
		expect(fs.readFileSync(path.join(workspace, FILE), "utf-8")).toBe(before);
	});

	// A typo that silently kept nothing would delete every candidate the reviewer
	// meant to save, so an unknown id fails the whole decision rather than
	// applying the subset it recognised.
	it("refuses an unknown id and leaves the file untouched", () => {
		write(candidates("ip-1", "ip-2"));
		const before = fs.readFileSync(path.join(workspace, FILE), "utf-8");

		expect(() => keep(["ip-1", "ip-33"])).toThrow(KeepError);
		expect(fs.readFileSync(path.join(workspace, FILE), "utf-8")).toBe(before);
	});

	it("names the available ids when one is unknown", () => {
		write(candidates("ip-1", "ip-2"));

		expect(() => keep(["ip-9"])).toThrow(/Available: ip-1, ip-2/);
	});

	it("refuses to keep nothing", () => {
		write(candidates("ip-1", "ip-2"));

		expect(() => keep([])).toThrow(/Keeping nothing/);
	});

	// `--keep ip-1,` must not resolve to some unrelated entry: slugging an empty
	// string yields the fallback id, so blanks have to be dropped before matching.
	it("ignores blank ids rather than slugging them into a match", () => {
		write(candidates("ip-1", "item"));

		const result = keep(["ip-1", "", "  "]);

		expect(result.kept).toEqual(["ip-1"]);
		expect(result.dropped).toEqual(["item"]);
	});

	it("matches ids the way the fan-out slugs them", () => {
		write(candidates("IP-1", "ip-2"));

		expect(keep(["ip-1"]).kept).toEqual(["IP-1"]);
	});

	// Two ids that fold together make "keep this one" ambiguous, and the fan-out's
	// own distinct-id check would refuse them a step later anyway.
	it("refuses a list whose ids collide once slugged", () => {
		write(candidates("ip 1", "ip-1"));

		expect(() => keep(["ip-1"])).toThrow(/indistinguishable/);
	});

	// Without an id there is no way to say "keep this", so dropping such an entry
	// would delete work the reviewer was never offered the chance to save.
	it("refuses a list with entries that have no id", () => {
		write({ candidates: [{ id: "ip-1" }, { title: "no id here" }] });

		expect(() => keep(["ip-1"])).toThrow(/without a string "id"/);
	});

	it("reports a path that is not an array", () => {
		write({ candidates: { ip1: {} } });

		expect(() => keep(["ip-1"])).toThrow(/Expected a JSON array/);
	});

	it("reports a missing file", () => {
		expect(() => keep(["ip-1"])).toThrow(/Cannot read the list to prune/);
	});

	it("prunes a bare top-level array when no path is given", () => {
		const absolute = path.join(workspace, FILE);
		fs.mkdirSync(path.dirname(absolute), { recursive: true });
		fs.writeFileSync(absolute, JSON.stringify([{ id: "a" }, { id: "b" }]), "utf-8");

		applyKeep({
			layout,
			stepId: "gate",
			select: { from: FILE },
			relativeFile: FILE,
			keep: ["b"],
			attempt: 1,
		});

		expect(JSON.parse(fs.readFileSync(absolute, "utf-8"))).toEqual([{ id: "b" }]);
	});
});

describe("readSelectable", () => {
	it("lists ids with the first human-readable field as a label", () => {
		write(candidates("ip-1", "ip-2"));

		const items = readSelectable(path.join(workspace, FILE), "candidates");

		expect(items).toEqual([
			{ id: "ip-1", label: "Candidate ip-1" },
			{ id: "ip-2", label: "Candidate ip-2" },
		]);
	});

	// Display is best-effort on purpose: a malformed list must still let the gate
	// open, because the gate is exactly where a bad artifact should be catchable.
	it("returns nothing for a missing or malformed file instead of throwing", () => {
		expect(readSelectable(path.join(workspace, "absent.json"), "candidates")).toEqual([]);

		write({ candidates: "not an array" });
		expect(readSelectable(path.join(workspace, FILE), "candidates")).toEqual([]);
	});

	it("skips entries without an id rather than inventing one", () => {
		write({ candidates: [{ id: "ip-1" }, { title: "anonymous" }] });

		expect(readSelectable(path.join(workspace, FILE), "candidates")).toEqual([{ id: "ip-1" }]);
	});
});
