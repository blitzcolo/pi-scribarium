import { describe, expect, it } from "vitest";

import { flagBoolean, flagString, parseArgs } from "../../src/cli/args.js";

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

	// The documented trade-off of uniform short/long handling: a boolean short
	// flag placed before a positional would consume it, so positionals come first.
	it("consumes the next token after a short flag, so positionals precede flags", () => {
		const args = parseArgs(["run-agent", "writer", "-q"]);
		expect(args.positionals).toEqual(["writer"]);
		expect(flagBoolean(args, "quiet", "q")).toBe(true);
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
