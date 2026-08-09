import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAgents } from "../../src/agents/discover.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { commandInit } from "../../src/cli/commands/init.js";
import { loadPipeline } from "../../src/pipeline/load.js";
import type { BuiltinStepSpec, PipelineSpec } from "../../src/pipeline/schema.js";

/**
 * The shipped pipeline and the scaffolded workspace are what every user gets,
 * and nothing else in the suite loads them. A `${vars.x}` typo or an agent
 * renamed out from under a step would otherwise be found by the first person to
 * run `scribarium init` rather than by CI.
 */

const SHIPPED_PIPELINE = path.join(process.cwd(), "pipelines", "paper.yaml");

/**
 * Shipped agents only. `cwd` and `agentDir` point at an empty directory so a
 * developer's own `~/.pi/agent/agents` or `.pi/agents` cannot decide whether
 * the shipped pipeline validates.
 */
function shippedRegistry(): AgentRegistry {
	const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-noagents-"));
	try {
		const { agents } = discoverAgents({ cwd: empty, agentDir: empty });
		return AgentRegistry.fromDefinitions(agents);
	} finally {
		fs.rmSync(empty, { recursive: true, force: true });
	}
}

function ingestSteps(spec: PipelineSpec): BuiltinStepSpec[] {
	return spec.steps.filter(
		(step): step is BuiltinStepSpec => step.kind === "builtin" && step.run === "ingest",
	);
}

describe("the shipped pipeline", () => {
	let spec: PipelineSpec;

	beforeEach(() => {
		spec = loadPipeline(SHIPPED_PIPELINE, shippedRegistry());
	});

	it("loads and validates against the shipped agents", () => {
		expect(spec.steps.length).toBeGreaterThan(0);
	});

	it("ingests the three input directories, and only corpus/ is required", () => {
		const byDir = new Map(ingestSteps(spec).map((step) => [step.with["from"], step]));

		expect([...byDir.keys()].sort()).toEqual(["corpus", "references", "source"]);
		expect(byDir.get("corpus")?.with["optional"]).not.toBe(true);
		expect(byDir.get("references")?.with["optional"]).toBe(true);
		expect(byDir.get("source")?.with["optional"]).toBe(true);
	});

	// Extracting source/*.md into source/text/ would put the author's own notes
	// in front of a writing agent twice, at two different paths.
	it("extracts PDFs only from source/", () => {
		const source = ingestSteps(spec).find((step) => step.with["from"] === "source");
		expect(source?.with["only"]).toBe("pdf");
	});

	// The distinction this pipeline exists to enforce: references/ is citable
	// but must never reach the profiler, or a paper from the wrong venue skews
	// the structure and evidence bar every later stage is written against.
	it("indexes references for citation checking but keeps them out of the profile", () => {
		const check = spec.steps.find(
			(step): step is BuiltinStepSpec =>
				step.kind === "builtin" && step.run === "check-citations",
		);
		expect(check?.with["sources"]).toContain("references/text");

		const profile = spec.steps.find((step) => step.id === "profile");
		expect(profile?.kind).toBe("agent");
		if (profile?.kind !== "agent") throw new Error("profile must be an agent step");
		expect(profile.input).not.toContain("references");
		// It reads the analyses, which are derived from corpus/ alone.
		expect(profile.input).toContain("analysis/papers/");
	});

	it("keeps the profile downstream of corpus analysis and upstream of the outline", () => {
		const order = spec.steps.map((step) => step.id);
		expect(order.indexOf("analyze")).toBeLessThan(order.indexOf("profile"));
		expect(order.indexOf("profile")).toBeLessThan(order.indexOf("outline"));
	});
});

describe("scribarium init", () => {
	let root: string;
	let stdout: string;
	let write: typeof process.stdout.write;

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-init-"));
		stdout = "";
		write = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string) => {
			stdout += chunk;
			return true;
		}) as typeof process.stdout.write;
		commandInit(root, false);
	});

	afterEach(() => {
		process.stdout.write = write;
		fs.rmSync(root, { recursive: true, force: true });
	});

	it("scaffolds all three input directories", () => {
		for (const dir of ["corpus", "references", "source"]) {
			expect(fs.existsSync(path.join(root, dir))).toBe(true);
			expect(fs.existsSync(path.join(root, dir, "_README.md"))).toBe(true);
		}
	});

	it("explains what separates corpus/ from references/", () => {
		const guidance = fs.readFileSync(path.join(root, "references", "_README.md"), "utf-8");
		expect(guidance).toMatch(/not.*read by the journal profiler/is);
		expect(stdout).toContain("references");
	});

	// Guidance files must not themselves be ingested as documents; a _README in
	// corpus/ was previously analysed as if it were a paper from the venue.
	it("prefixes guidance files so ingest skips them", () => {
		for (const dir of ["corpus", "references", "source"]) {
			expect(fs.readdirSync(path.join(root, dir))).toEqual(["_README.md"]);
		}
	});

	it("writes a pipeline the loader accepts", () => {
		const spec = loadPipeline(path.join(root, "pipeline.yaml"), shippedRegistry());
		expect(ingestSteps(spec).length).toBeGreaterThan(0);
	});
});
