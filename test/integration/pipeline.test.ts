import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAgentFile } from "../../src/agents/parse.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { initialRunState, runPipeline } from "../../src/pipeline/engine.js";
import { parsePipeline } from "../../src/pipeline/load.js";
import { hashPipeline, newRunId, RunLayout } from "../../src/workspace/layout.js";
import { EventLog, RunStateStore, type RunState } from "../../src/workspace/run-state.js";
import { minimalPdf } from "../helpers/minimal-pdf.js";
import { createScriptedRuntime, SCRIPTED_MODEL_REF, type Script } from "../helpers/scripted-provider.js";

let workspace: string;
let agentDir: string;
let layout: RunLayout;

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-pipeline-"));
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(path.join(workspace, "corpus"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	layout = new RunLayout(workspace, newRunId());
	layout.ensure();
});

afterEach(() => {
	fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
});

const registry = AgentRegistry.fromDefinitions(
	["analyst", "writer"].map((name) =>
		parseAgentFile(
			`---\nname: ${name}\ndescription: ${name}\nmodel: ${SCRIPTED_MODEL_REF}\ntools: [read, write]\n---\n\nYou are ${name}.\n`,
			`/agents/${name}.md`,
			"shipped",
		),
	),
);

async function execute(source: string, script: Script, existing?: RunState) {
	const spec = parsePipeline(source, path.join(workspace, "pipeline.yaml"), registry);
	const scripted = await createScriptedRuntime(agentDir, script);
	const state =
		existing ??
		RunStateStore.create(layout, initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }));

	const final = await runPipeline({
		spec,
		layout,
		state,
		registry,
		modelRuntime: scripted.runtime,
		agentDir,
	});
	return { final, scripted, spec };
}

/** Writes `content` to `to`, then reports done on the following turn. */
function writeThenFinish(to: string, content: string): Script {
	return (ctx) =>
		ctx.turn === 1
			? { toolCalls: [{ name: "write", args: { path: to, content } }] }
			: { text: `Wrote ${to}.` };
}

describe("runPipeline", () => {
	it("runs ingest and two agent steps in order, end to end", async () => {
		fs.writeFileSync(
			path.join(workspace, "corpus", "paper.pdf"),
			minimalPdf(["A study of neural surrogates for radiative transfer."]),
		);

		const source = `
name: demo
vars:
  topic: emulation
steps:
  - id: ingest
    builtin: ingest
  - id: analyze
    agent: analyst
    input: Analyse the corpus about \${vars.topic}.
    output: analysis/profile.md
  - id: write
    agent: writer
    input: Use \${steps.analyze.outputs}.
    output: draft/paper.md
`;
		const { final } = await execute(source, (ctx) => {
			// Each agent step writes its declared output, then summarises.
			const target = ctx.systemPrompt.includes("analyst") ? "analysis/profile.md" : "draft/paper.md";
			return ctx.lastUserText.includes("Wrote") || ctx.turn % 2 === 0
				? { text: `Wrote ${target}.` }
				: { toolCalls: [{ name: "write", args: { path: target, content: `# ${target}\n` } }] };
		});

		expect(final.status).toBe("completed");
		expect(Object.keys(final.steps)).toEqual(["ingest", "analyze", "write"]);
		for (const id of ["ingest", "analyze", "write"]) {
			expect(final.steps[id]?.status).toBe("completed");
		}

		// Ingest wrote into the workspace; agents wrote their declared artifacts.
		expect(fs.existsSync(path.join(workspace, "corpus", "text", "paper.md"))).toBe(true);
		expect(fs.existsSync(path.join(workspace, "analysis", "profile.md"))).toBe(true);
		expect(fs.existsSync(path.join(workspace, "draft", "paper.md"))).toBe(true);

		expect(final.steps["analyze"]?.outputs).toEqual(["analysis/profile.md"]);
	});

	it("totals usage across steps to the sum of their parts", async () => {
		const source = `
steps:
  - id: a
    agent: analyst
    output: a.md
  - id: b
    agent: writer
    output: b.md
`;
		const { final } = await execute(source, (ctx) =>
			ctx.turn % 2 === 1
				? {
						toolCalls: [
							{ name: "write", args: { path: ctx.turn === 1 ? "a.md" : "b.md", content: "x" } },
						],
						usage: { input: 100, output: 10 },
					}
				: { text: "done", usage: { input: 50, output: 5 } },
		);

		expect(final.status).toBe("completed");
		const perStep = Object.values(final.steps).map((s) => s.usage?.input ?? 0);
		expect(perStep.reduce((a, b) => a + b, 0)).toBe(final.usageTotal.input);
		expect(final.usageTotal.input).toBe(300);
		expect(final.usageTotal.cost).toBeGreaterThan(0);
	});

	// The declared output is the contract. An agent that says it wrote a file but
	// did not must fail, or the next stage silently reads nothing.
	it("fails a step whose declared output was never written", async () => {
		const source = `
steps:
  - id: a
    agent: analyst
    output: analysis/never-written.md
`;
		const { final } = await execute(source, () => ({ text: "All done! I wrote the file." }));

		expect(final.status).toBe("failed");
		expect(final.steps["a"]?.status).toBe("failed");
		expect(final.steps["a"]?.error?.code).toBe("MISSING_OUTPUT");
		expect(final.steps["a"]?.error?.message).toMatch(/analysis\/never-written\.md/);
	});

	it("stops the run at a failed step rather than building on missing input", async () => {
		const source = `
steps:
  - id: first
    agent: analyst
    output: a.md
  - id: second
    agent: writer
    output: b.md
`;
		const { final, scripted } = await execute(source, () => ({ error: "provider exploded" }));

		expect(final.status).toBe("failed");
		expect(final.steps["first"]?.status).toBe("failed");
		// The second step must never have been attempted.
		expect(final.steps["second"]).toBeUndefined();
		expect(scripted.requests).toHaveLength(1);
	});

	it("checkpoints every boundary and logs the run narrative", async () => {
		const source = `
steps:
  - id: only
    agent: analyst
    output: out.md
`;
		await execute(source, writeThenFinish("out.md", "body"));

		const persisted = new RunStateStore(layout).load();
		expect(persisted.status).toBe("completed");
		expect(persisted.steps["only"]?.status).toBe("completed");
		expect(persisted.steps["only"]?.sessionFile).toBeTypeOf("string");

		const events = new EventLog(layout.eventsFile).read().map((e) => e.type);
		expect(events).toEqual(["run_start", "step_start", "step_end", "run_end"]);

		// The prompt and the final text are recorded for audit.
		const log = fs.readFileSync(layout.logFile("only"), "utf-8");
		expect(log).toContain("## Prompt");
		expect(log).toContain("## Final text");
	});

	// Resume relies on this: a completed step is not re-run, and crucially not
	// re-paid for.
	it("skips steps already marked completed", async () => {
		const source = `
steps:
  - id: done-already
    agent: analyst
    output: a.md
  - id: still-pending
    agent: writer
    output: b.md
`;
		const spec = parsePipeline(source, path.join(workspace, "pipeline.yaml"), registry);
		const state = RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }),
		);
		state.steps["done-already"] = {
			type: "agent",
			status: "completed",
			attempts: 1,
			outputs: ["a.md"],
		};

		const { final, scripted } = await execute(source, writeThenFinish("b.md", "body"), state);

		expect(final.status).toBe("completed");
		expect(final.steps["still-pending"]?.status).toBe("completed");
		// Only the pending step reached the model.
		expect(scripted.requests.every((r) => !r.systemPrompt.includes("analyst"))).toBe(true);
	});

	it("fails the run when the corpus for ingest is empty", async () => {
		const { final } = await execute("steps:\n  - id: ingest\n    builtin: ingest\n", () => ({
			text: "unused",
		}));

		expect(final.status).toBe("failed");
		expect(final.steps["ingest"]?.error?.message).toMatch(/No \.pdf, \.md, or \.txt files/);
	});
});
