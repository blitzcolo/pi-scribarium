import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAgentFile } from "../../src/agents/parse.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { createFileGate, gateRequestFile, writeDecision } from "../../src/gates/file.js";
import { initialRunState, runPipeline } from "../../src/pipeline/engine.js";
import { parsePipeline } from "../../src/pipeline/load.js";
import { hashPipeline, newRunId, RunLayout } from "../../src/workspace/layout.js";
import { RunStateStore, type RunState } from "../../src/workspace/run-state.js";
import {
	createScriptedRuntime,
	SCRIPTED_MODEL_REF,
	type Script,
	type ScriptedRuntime,
} from "../helpers/scripted-provider.js";

let workspace: string;
let agentDir: string;
let layout: RunLayout;

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-gate-"));
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	layout = new RunLayout(workspace, newRunId());
	layout.ensure();
});

afterEach(() => {
	fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
});

const registry = AgentRegistry.fromDefinitions(
	["outliner", "writer"].map((name) =>
		parseAgentFile(
			`---\nname: ${name}\ndescription: ${name}\nmodel: ${SCRIPTED_MODEL_REF}\ntools: [read, write]\n---\n\nYou are ${name}.\n`,
			`/agents/${name}.md`,
			"shipped",
		),
	),
);

const PIPELINE = `
steps:
  - id: outline
    agent: outliner
    input: Draft the outline.
    output: outline/outline.md
  - id: approve-outline
    gate: Approve the outline
    show: outline/outline.md
    on_reject: outline
  - id: write
    agent: writer
    input: Write from \${steps.outline.outputs}.
    output: draft/paper.md
`;

/** Writes each step's declared output once, then reports done. */
function scribe(): Script {
	const written = new Set<string>();
	return (ctx) => {
		const target = /Write your output to (\S+?)\.\s*$/m.exec(ctx.lastUserText)?.[1];
		if (target === undefined) return { text: "Done." };

		// Echo any reviewer feedback into the artifact so tests can see it landed.
		const feedback = /<reviewer_feedback>\s*([\s\S]*?)\s*<\/reviewer_feedback>/.exec(
			ctx.lastUserText,
		)?.[1];

		// A revision always rewrites; only an unchanged repeat prompt is a no-op.
		const key = `${target}::${feedback ?? ""}`;
		if (written.has(key)) return { text: `Wrote ${target}.` };
		written.add(key);

		const body = feedback === undefined ? "# v1\n" : `# v2\n\nAddressed: ${feedback}\n`;
		return { toolCalls: [{ name: "write", args: { path: target, content: body } }] };
	};
}

async function execute(
	script: Script,
	state?: RunState,
	scripted?: ScriptedRuntime,
): Promise<{ final: RunState; scripted: ScriptedRuntime }> {
	const spec = parsePipeline(PIPELINE, path.join(workspace, "pipeline.yaml"), registry);
	const runtime = scripted ?? (await createScriptedRuntime(agentDir, script));
	const runState =
		state ??
		RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(PIPELINE) }),
		);

	const final = await runPipeline({
		spec,
		layout,
		state: runState,
		registry,
		modelRuntime: runtime.runtime,
		agentDir,
		gate: createFileGate(layout),
	});
	return { final, scripted: runtime };
}

describe("gates", () => {
	// M3 acceptance: a headless run stops at the gate rather than sailing past it.
	it("halts at the gate and writes a request for the reviewer", async () => {
		const { final, scripted } = await execute(scribe());

		expect(final.status).toBe("awaiting_gate");
		expect(final.steps["outline"]?.status).toBe("completed");
		expect(final.steps["approve-outline"]?.status).toBe("awaiting");
		// The step after the gate must not have run.
		expect(final.steps["write"]).toBeUndefined();

		const request = JSON.parse(fs.readFileSync(gateRequestFile(layout, "approve-outline"), "utf-8"));
		expect(request.title).toBe("Approve the outline");
		expect(request.artifacts[0]).toMatchObject({ path: "outline/outline.md", exists: true });
		expect(request.howToRespond.approve).toContain("scribarium approve");

		// Only the outline step reached the model.
		expect(scripted.requests.every((r) => !r.systemPrompt.includes("You are writer"))).toBe(true);
	});

	it("approve then resume finishes without re-running completed steps", async () => {
		const { final: halted, scripted } = await execute(scribe());
		const outlineBefore = fs.statSync(path.join(workspace, "outline/outline.md")).mtimeMs;
		const requestsAfterHalt = scripted.requests.length;

		writeDecision(layout, "approve-outline", { kind: "approve" });
		const { final } = await execute(scribe(), halted, scripted);

		expect(final.status).toBe("completed");
		expect(final.steps["write"]?.status).toBe("completed");
		expect(fs.existsSync(path.join(workspace, "draft/paper.md"))).toBe(true);

		// The outline was neither re-run nor rewritten.
		expect(fs.statSync(path.join(workspace, "outline/outline.md")).mtimeMs).toBe(outlineBefore);
		const newPrompts = scripted.requests.slice(requestsAfterHalt);
		expect(newPrompts.every((r) => r.systemPrompt.includes("You are writer"))).toBe(true);
	});

	// The core of regenerate-with-feedback.
	it("reject then resume re-runs only the target, with the feedback in its prompt", async () => {
		const { final: halted, scripted } = await execute(scribe());
		const requestsAfterHalt = scripted.requests.length;

		writeDecision(layout, "approve-outline", {
			kind: "reject",
			feedback: "Add a limitations subsection.",
		});
		const { final } = await execute(scribe(), halted, scripted);

		// Rewound to the outline, regenerated it, and stopped at the gate again —
		// a regenerated artifact still needs approval.
		expect(final.status).toBe("awaiting_gate");
		expect(final.steps["write"]).toBeUndefined();

		const regenerated = scripted.requests.slice(requestsAfterHalt);
		const prompt = regenerated[0]?.lastUserText ?? "";
		expect(prompt).toContain("<previous_attempt");
		expect(prompt).toContain("Add a limitations subsection.");
		expect(prompt).toContain("this is a revision, not a rewrite");

		// v1 is archived, and the live artifact is the revision.
		const archived = path.join(layout.attemptsDir, "outline", "outline/outline.attempt1.md");
		expect(fs.readFileSync(archived, "utf-8")).toContain("# v1");
		expect(fs.readFileSync(path.join(workspace, "outline/outline.md"), "utf-8")).toContain("# v2");

		const decisions = final.steps["approve-outline"]?.decisions ?? [];
		expect(decisions[0]).toMatchObject({ kind: "reject", feedback: "Add a limitations subsection." });
	});

	it("consumes a decision so the regenerated work is reviewed again", async () => {
		const { final: halted, scripted } = await execute(scribe());
		writeDecision(layout, "approve-outline", { kind: "reject", feedback: "More detail." });
		const { final } = await execute(scribe(), halted, scripted);

		// A decision left in place would re-reject forever without ever asking.
		expect(fs.existsSync(gateRequestFile(layout, "approve-outline"))).toBe(true);
		expect(final.steps["approve-outline"]?.status).toBe("awaiting");
	});

	it("abort stops the run", async () => {
		const { final: halted, scripted } = await execute(scribe());
		writeDecision(layout, "approve-outline", { kind: "abort" });
		const { final } = await execute(scribe(), halted, scripted);

		expect(final.status).toBe("aborted");
		expect(final.steps["write"]).toBeUndefined();
	});

	it("skip continues past the gate without approving", async () => {
		const { final: halted, scripted } = await execute(scribe());
		writeDecision(layout, "approve-outline", { kind: "skip" });
		const { final } = await execute(scribe(), halted, scripted);

		expect(final.status).toBe("completed");
		expect(final.steps["approve-outline"]?.status).toBe("skipped");
		expect(final.steps["write"]?.status).toBe("completed");
	});

	it("auto-approve runs straight through", async () => {
		const spec = parsePipeline(PIPELINE, path.join(workspace, "pipeline.yaml"), registry);
		const scripted = await createScriptedRuntime(agentDir, scribe());
		const state = RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(PIPELINE) }),
		);

		const final = await runPipeline({
			spec,
			layout,
			state,
			registry,
			modelRuntime: scripted.runtime,
			agentDir,
			gate: async () => ({ kind: "approve" }),
		});

		expect(final.status).toBe("completed");
		expect(final.steps["approve-outline"]?.status).toBe("completed");
	});
});

describe("gate validation", () => {
	it("rejects on_reject pointing at a step that has not run yet", () => {
		const source = `
steps:
  - id: g
    gate: Approve
    on_reject: later
  - id: later
    agent: outliner
`;
		expect(() => parsePipeline(source, "/p.yaml", registry)).toThrow(
			/on_reject must name an earlier step/,
		);
	});

	it("accepts a gate with no artifacts to show", () => {
		expect(() =>
			parsePipeline("steps:\n  - id: g\n    gate: Just checking\n", "/p.yaml", registry),
		).not.toThrow();
	});
});
