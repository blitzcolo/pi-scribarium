import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAgents } from "../../src/agents/discover.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { commandInit } from "../../src/cli/commands/init.js";
import { resolvePipelinePath } from "../../src/cli/commands/run.js";
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

	// A reference card is a property of the paper, not of the run. Without the
	// cache a library of several hundred is re-analysed every run, which at that
	// size costs more than every other step combined.
	it("caches the reference fan-out and tolerates an empty library", () => {
		const step = spec.steps.find((s) => s.id === "analyze-references");
		expect(step?.kind).toBe("foreach");
		if (step?.kind !== "foreach") throw new Error("analyze-references must be a fan-out");

		expect(step.cache).toBe(true);
		expect(step.optional).toBe(true);
		expect(step.source).toMatchObject({ kind: "glob" });
	});

	it("indexes the cards before anything needs to read them", () => {
		const order = spec.steps.map((s) => s.id);
		expect(order.indexOf("analyze-references")).toBeLessThan(order.indexOf("index-references"));
		expect(order.indexOf("index-references")).toBeLessThan(order.indexOf("outline"));
	});

	// The reference library must reach the writer without reaching the profiler.
	it("routes the reference index to the writing stages only", () => {
		const write = spec.steps.find((s) => s.id === "write");
		if (write?.kind !== "foreach") throw new Error("write must be a fan-out");
		expect(write.input).toContain("references/index.md");

		const profile = spec.steps.find((s) => s.id === "profile");
		if (profile?.kind !== "agent") throw new Error("profile must be an agent step");
		expect(profile.input).not.toContain("references");
	});

	// The whole paper flow predates any network access and must keep working
	// without it. A search or fetch step appearing here would silently move a
	// documented offline guarantee.
	it("reaches the network in no step and grants no networked tool", () => {
		const registry = shippedRegistry();
		for (const step of spec.steps) {
			if (step.kind === "builtin") {
				expect(step.run).not.toMatch(/search-papers|fetch-papers/);
			}
			if (step.kind === "agent" || step.kind === "foreach") {
				expect(registry.get(step.agent)?.tools ?? []).not.toContain("search_papers");
			}
		}
	});
});

describe("the shipped explore pipeline", () => {
	let spec: PipelineSpec;

	beforeEach(() => {
		spec = loadPipeline(path.join(process.cwd(), "pipelines", "explore.yaml"), shippedRegistry(), {
			name: "demo",
		});
	});

	it("loads and validates against the shipped agents", () => {
		expect(spec.steps.length).toBeGreaterThan(0);
	});

	// Both gates guard spending, so their position is the design rather than a
	// detail: candidates before the search is paid for, follow-ups before the
	// second round is.
	it("gates before each of the two spending decisions", () => {
		const order = spec.steps.map((step) => step.id);
		const gates = spec.steps.filter((step) => step.kind === "gate").map((step) => step.id);

		expect(gates).toEqual(["prune-candidates", "approve-round2"]);
		expect(order.indexOf("prune-candidates")).toBeLessThan(order.indexOf("search-round1"));
		expect(order.indexOf("approve-round2")).toBeLessThan(order.indexOf("search-round2"));
	});

	// The candidate list is the cheapest thing to redo; the collation is
	// deterministic and would regenerate identically, so it deliberately has no
	// rewind target.
	it("rewinds a rejected candidate list to ideation and nothing else", () => {
		const gates = spec.steps.filter((step) => step.kind === "gate");
		expect(gates[0]).toMatchObject({ id: "prune-candidates", onReject: "ideate" });
		expect(gates[1]?.kind === "gate" ? gates[1].onReject : "unset").toBeUndefined();
	});

	it("caps both rounds so the two together cannot exceed the budget", () => {
		const byId = new Map(
			spec.steps
				.filter((step): step is BuiltinStepSpec => step.kind === "builtin")
				.map((step) => [step.id, step]),
		);

		expect(byId.get("search-round1")?.with["max_total"]).toBe("100");
		expect(byId.get("search-round2")?.with["max_total"]).toBe("150");
		// Round two must subtract what round one already fetched, or the cap is
		// per-round rather than total.
		expect(byId.get("search-round2")?.with["exclude"]).toContain("results-round1.json");
		expect(byId.get("collate-followups")?.with["max_total"]).toBe("150");
	});

	// Exactly one agent may reach the network, and it is the one that cannot
	// commit any spending.
	it("grants the search tool to the query planner alone", () => {
		const registry = shippedRegistry();
		const granted = spec.steps
			.filter((step) => step.kind === "agent" || step.kind === "foreach")
			.filter((step) => (registry.get(step.agent)?.tools ?? []).includes("search_papers"))
			.map((step) => step.id);

		expect(granted).toEqual(["plan-queries"]);
	});

	// The analysts and the judge must not be able to shell out or edit in place:
	// the tool allowlist is the only containment there is.
	it("gives no stage the bash tool", () => {
		const registry = shippedRegistry();
		for (const step of spec.steps) {
			if (step.kind !== "agent" && step.kind !== "foreach") continue;
			expect(registry.get(step.agent)?.tools ?? []).not.toContain("bash");
		}
	});

	// Round two re-globs the same directory as round one, so without the cache
	// every round-one paper would be analysed and paid for twice.
	it("analyses over one cached glob in both rounds", () => {
		const rounds = spec.steps.filter(
			(step) => step.id === "analyze" || step.id === "analyze-round2",
		);
		expect(rounds).toHaveLength(2);
		for (const step of rounds) {
			if (step.kind !== "foreach") throw new Error(`${step.id} must be a fan-out`);
			expect(step.cache).toBe(true);
			// Vars in a source or an output resolve at run time, so the spec still
			// holds the template — only `model:` is resolved by the loader.
			expect(step.source).toEqual({
				kind: "glob",
				pattern: "explore/${vars.name_slug}/refs/text/*.md",
			});
			expect(step.outputs).toEqual(["explore/${vars.name_slug}/cards/${item.id}.md"]);
		}
	});

	// Pruning at the gate means editing candidates.json, so every stage that
	// enumerates candidates has to re-read it rather than carry an earlier copy.
	it("drives the judging fan-out from the candidate file itself", () => {
		const judge = spec.steps.find((step) => step.id === "judge");
		if (judge?.kind !== "foreach") throw new Error("judge must be a fan-out");
		expect(judge.source).toMatchObject({
			kind: "json",
			file: "explore/${vars.name_slug}/candidates.json",
			path: "candidates",
		});
	});

	// `init` deliberately does not copy explore.yaml into a workspace, so without
	// a by-name lookup the only way to run it would be to spell out a path inside
	// node_modules.
	it("is reachable by bare name from any workspace", () => {
		const empty = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-noship-"));
		try {
			for (const given of ["explore", "explore.yaml"]) {
				expect(path.basename(resolvePipelinePath(given, empty))).toBe("explore.yaml");
			}
		} finally {
			fs.rmSync(empty, { recursive: true, force: true });
		}
	});

	// A pipeline the author edited into their own workspace must keep winning
	// over the shipped file of the same name.
	it("prefers a workspace copy over the shipped one", () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-ownpipe-"));
		try {
			const own = path.join(ws, "explore.yaml");
			fs.writeFileSync(own, "name: mine\nsteps: []\n");
			expect(resolvePipelinePath("explore.yaml", ws)).toBe(own);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
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
