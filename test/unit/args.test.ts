import { describe, expect, it } from "vitest";

import {
	flagAll,
	flagBoolean,
	flagString,
	flagsMissingValues,
	keepIds,
	parseArgs,
} from "../../src/cli/args.js";

describe("parseArgs", () => {
	it("separates the command from its positionals", () => {
		const args = parseArgs(["ingest", "corpus", "extra"]);
		expect(args.command).toBe("ingest");
		expect(args.positionals).toEqual(["corpus", "extra"]);
	});

	it("reads both --flag value and --flag=value", () => {
		const args = parseArgs(["run-agent", "--workspace", "/tmp/ws", "--out=/tmp/out"]);
		expect(flagString(args, "workspace")).toBe("/tmp/ws");
		expect(flagString(args, "out")).toBe("/tmp/out");
	});

	it("treats a flag with no value as boolean", () => {
		const args = parseArgs(["ingest", "--force", "--workspace", "/tmp"]);
		expect(flagBoolean(args, "force")).toBe(true);
		expect(flagString(args, "workspace")).toBe("/tmp");
	});

	// `--quiet --input x` must not consume `--input` as the value of `--quiet`.
	it("does not swallow the next flag as a value", () => {
		const args = parseArgs(["run-agent", "writer", "--quiet", "--input", "outline.md"]);
		expect(flagBoolean(args, "quiet")).toBe(true);
		expect(flagString(args, "input")).toBe("outline.md");
		expect(args.positionals).toEqual(["writer"]);
	});

	it("accepts short aliases with values", () => {
		expect(flagString(parseArgs(["agents", "-w", "/tmp"]), "workspace", "w")).toBe("/tmp");
	});

	it("treats a trailing short flag as boolean", () => {
		expect(flagBoolean(parseArgs(["-v"]), "version", "v")).toBe(true);
	});

	// A *value* flag still consumes the next token, short or long alike, so that
	// `-w /tmp` does not parse as a boolean plus a stray positional. Known boolean
	// flags are exempt (see below), which is what makes `-q writer` safe.
	it("consumes the next token after a short value flag", () => {
		const args = parseArgs(["run-agent", "writer", "-q"]);
		expect(args.positionals).toEqual(["writer"]);
		expect(flagBoolean(args, "quiet", "q")).toBe(true);

		const withValue = parseArgs(["run-agent", "-m", "some/model", "writer"]);
		expect(flagString(withValue, "model", "m")).toBe("some/model");
		expect(withValue.positionals).toEqual(["writer"]);
	});

	// A boolean flag that eats the next token is not an error, so it acts on the
	// wrong thing in silence: `run --quiet paper.yaml` ran the default pipeline,
	// and `approve -y run-123` approved whichever run happened to be latest.
	it("does not let a boolean flag swallow the following positional", () => {
		const run = parseArgs(["run", "--quiet", "paper.yaml"]);
		expect(run.positionals).toEqual(["paper.yaml"]);
		expect(flagBoolean(run, "quiet")).toBe(true);

		const approve = parseArgs(["approve", "-y", "run-123"]);
		expect(approve.positionals).toEqual(["run-123"]);
		expect(flagBoolean(approve, "yes", "y")).toBe(true);

		const init = parseArgs(["init", "--force", "./mypaper"]);
		expect(init.positionals).toEqual(["./mypaper"]);
	});

	it("still lets a value flag take the following token", () => {
		const args = parseArgs(["run", "--workspace", "/tmp/w", "paper.yaml"]);
		expect(flagString(args, "workspace")).toBe("/tmp/w");
		expect(args.positionals).toEqual(["paper.yaml"]);
	});

	// `--yes=false` reads as an explicit refusal. Treating it as set meant
	// `run --yes=false` auto-approved every gate and spent the run unattended.
	it("reads an explicit false as false", () => {
		for (const value of ["false", "0", "no", "off", "FALSE"]) {
			expect(flagBoolean(parseArgs(["run", `--yes=${value}`]), "yes")).toBe(false);
		}
		expect(flagBoolean(parseArgs(["run", "--yes=true"]), "yes")).toBe(true);
		expect(flagBoolean(parseArgs(["run", "--yes"]), "yes")).toBe(true);
	});

	it("reports a value flag that was given no value", () => {
		const args = parseArgs(["run", "--workspace"]);
		expect(flagsMissingValues(args, "workspace", "model")).toEqual(["workspace"]);
		expect(flagsMissingValues(parseArgs(["run", "--workspace", "/tmp/w"]), "workspace")).toEqual([]);
	});

	it("passes everything after -- through as positionals", () => {
		const args = parseArgs(["run-agent", "writer", "--", "--not-a-flag"]);
		expect(args.positionals).toEqual(["writer", "--not-a-flag"]);
		expect(flagBoolean(args, "not-a-flag")).toBe(false);
	});

	it("returns an undefined command for empty input", () => {
		expect(parseArgs([]).command).toBeUndefined();
	});

	it("reports a missing flag as absent rather than empty", () => {
		const args = parseArgs(["agents"]);
		expect(flagString(args, "workspace")).toBeUndefined();
		expect(flagBoolean(args, "strict")).toBe(false);
	});
});

describe("repeatable flags", () => {
	it("keeps every occurrence, not just the last", () => {
		const args = parseArgs(["run", "--var", "bulk=a/b", "--var", "judgement=c/d"]);
		expect(flagAll(args, "var")).toEqual(["bulk=a/b", "judgement=c/d"]);
		// `flags` still holds the last, which is what single-value flags want.
		expect(flagString(args, "var")).toBe("judgement=c/d");
	});

	it("returns nothing for a flag never given", () => {
		expect(flagAll(parseArgs(["run"]), "var")).toEqual([]);
	});
});

describe("values that begin with a dash", () => {
	// Review feedback is written as a markdown list, so this is the normal case
	// for `reject -m`, not an edge case. It used to be swallowed entirely.
	it("keeps a multi-line value that starts with a bullet", () => {
		const feedback = "- first point\n- second point\n\nA closing paragraph.";
		const args = parseArgs(["reject", "-m", feedback]);

		expect(flagString(args, "message", "m")).toBe(feedback);
		expect(args.positionals).toEqual([]);
	});

	it("treats a negative number as a value, not a flag", () => {
		expect(flagString(parseArgs(["run", "--threshold", "-1.5"]), "threshold")).toBe("-1.5");
	});

	it("still recognises real flags", () => {
		const args = parseArgs(["run", "--quiet", "--model", "p/m", "-y"]);
		expect(flagBoolean(args, "quiet")).toBe(true);
		expect(flagString(args, "model")).toBe("p/m");
		expect(flagBoolean(args, "yes", "y")).toBe(true);
	});

	it("keeps a lone dash as a positional", () => {
		expect(parseArgs(["run", "-"]).positionals).toEqual(["-"]);
	});
});

describe("keepIds", () => {
	it("is undefined when --keep is absent, so the whole list is approved", () => {
		expect(keepIds(parseArgs(["approve", "run-1"]))).toBeUndefined();
	});

	it("splits one comma-separated value", () => {
		expect(keepIds(parseArgs(["approve", "--keep", "ip-1,ip-3"]))).toEqual(["ip-1", "ip-3"]);
	});

	it("accumulates a repeated flag", () => {
		expect(keepIds(parseArgs(["approve", "--keep", "ip-1", "--keep", "ip-3,ip-4"]))).toEqual([
			"ip-1",
			"ip-3",
			"ip-4",
		]);
	});

	it("trims and drops blanks left by a trailing comma", () => {
		expect(keepIds(parseArgs(["approve", "--keep", " ip-1 , ,ip-2,"]))).toEqual(["ip-1", "ip-2"]);
	});

	// Distinct from undefined on purpose: the caller has to reject this rather
	// than pick one of the two wrong readings of it.
	it("reports an empty list rather than nothing when the value is all separators", () => {
		expect(keepIds(parseArgs(["approve", "--keep", ",,"]))).toEqual([]);
	});
});
