import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAgentFile } from "../../src/agents/parse.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import {
	createFileGate,
	gateDecisionFile,
	gateRequestFile,
	writeDecision,
} from "../../src/gates/file.js";
import { selectGate } from "../../src/gates/select.js";
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

/**
 * The shape the shipped pipeline actually uses: a gate rejecting back into a
 * fan-out, with a step in between that was written against its output.
 */
const FANOUT_PIPELINE = `
steps:
  - id: write
    agent: writer
    foreach:
      items:
        - id: intro
        - id: methods
    input: Draft section \${item.id}.
    output: draft/\${item.id}.md
  - id: assemble
    agent: outliner
    input: Assemble the draft.
    output: draft/paper.md
  - id: approve-draft
    gate: Approve the draft
    show: draft/paper.md
    on_reject: write
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
	source: string = PIPELINE,
): Promise<{ final: RunState; scripted: ScriptedRuntime }> {
	const spec = parsePipeline(source, path.join(workspace, "pipeline.yaml"), registry);
	const runtime = scripted ?? (await createScriptedRuntime(agentDir, script));
	const runState =
		state ??
		RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }),
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
	it("revise then resume re-runs only the target, with the feedback in its prompt", async () => {
		const { final: halted, scripted } = await execute(scribe());
		const requestsAfterHalt = scripted.requests.length;

		writeDecision(layout, "approve-outline", {
			kind: "revise",
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
		expect(decisions[0]).toMatchObject({ kind: "revise", feedback: "Add a limitations subsection." });
	});

	// The shipped pipeline rejects `approve-review` back into `write`, a fan-out,
	// with `assemble` and `review` in between. Both halves of that used to fail:
	// fan-out items never saw the feedback and were all carried forward as already
	// complete, so the step re-completed having run nothing; and the steps between
	// the target and the gate stayed `completed`, so the gate re-opened on exactly
	// the artifact the reviewer had just rejected.
	it("re-runs a rejected fan-out, and every step between it and the gate", async () => {
		const script = scribe();
		const first = await execute(script, undefined, undefined, FANOUT_PIPELINE);
		expect(first.final.status).toBe("awaiting_gate");
		expect(first.final.steps["assemble"]?.attempts).toBe(1);

		writeDecision(layout, "approve-draft", {
			kind: "revise",
			feedback: "Tighten the methods.",
		});
		const second = await execute(script, first.final, first.scripted, FANOUT_PIPELINE);

		// Every item was drafted again, with the reviewer's words in its prompt.
		for (const id of ["intro", "methods"]) {
			expect(fs.readFileSync(path.join(workspace, "draft", `${id}.md`), "utf-8")).toContain(
				"Addressed: Tighten the methods.",
			);
		}
		expect(Object.keys(second.final.steps["write"]?.items ?? {})).toHaveLength(2);

		// The step in between ran again rather than being skipped as complete.
		expect(second.final.steps["assemble"]?.attempts).toBe(2);

		// The regenerated work needs approval of its own.
		expect(second.final.status).toBe("awaiting_gate");
		// Consumed, so the step is not left permanently uncacheable.
		expect(second.final.steps["write"]?.pendingFeedback).toBeUndefined();
	});

	// `readDecision` was only ever consulted by the file gate, but the workflow the
	// CLI itself prints — revise with -m, then resume — is normally typed at a
	// terminal, where selectGate picks the interactive gate. The recorded feedback
	// was discarded, the reviewer re-prompted as though they had said nothing, and
	// the stale decision left on disk for a later run to consume.
	it("honours a recorded decision even when a terminal gate is selected", async () => {
		const { final: halted } = await execute(scribe());
		expect(halted.status).toBe("awaiting_gate");

		writeDecision(layout, "approve-outline", { kind: "approve" });

		// The interactive gate would block on stdin here if the decision were
		// ignored, so reaching a terminal state at all is the assertion.
		const spec = parsePipeline(PIPELINE, path.join(workspace, "pipeline.yaml"), registry);
		const scripted = await createScriptedRuntime(agentDir, scribe());
		const final = await runPipeline({
			spec,
			layout,
			state: halted,
			registry,
			modelRuntime: scripted.runtime,
			agentDir,
			gate: selectGate(layout, { autoApprove: false, mode: "interactive" }),
		});

		expect(final.steps["approve-outline"]?.status).toBe("completed");
		expect(final.status).toBe("completed");
		// Consumed, so a later gate does not silently reuse it.
		expect(fs.existsSync(gateDecisionFile(layout, "approve-outline"))).toBe(false);
	});

	it("consumes a decision so the regenerated work is reviewed again", async () => {
		const { final: halted, scripted } = await execute(scribe());
		writeDecision(layout, "approve-outline", { kind: "revise", feedback: "More detail." });
		const { final } = await execute(scribe(), halted, scripted);

		// A decision left in place would re-revise forever without ever asking.
		expect(fs.existsSync(gateRequestFile(layout, "approve-outline"))).toBe(true);
		expect(final.steps["approve-outline"]?.status).toBe("awaiting");
	});

	/**
	 * `revise` was called `reject` for one release. A decision is a file on
	 * disk, so a run left waiting across the upgrade — exactly the case the file
	 * protocol exists to serve, since the process exits and comes back later —
	 * would otherwise have its answer read as malformed and be asked again.
	 */
	it("still reads a decision recorded under the old name", async () => {
		const { final: halted, scripted } = await execute(scribe());
		fs.writeFileSync(
			gateDecisionFile(layout, "approve-outline"),
			JSON.stringify({ kind: "reject", feedback: "Add a limitations subsection." }),
		);
		const { final } = await execute(scribe(), halted, scripted);

		expect(final.steps["outline"]?.pendingFeedback).toBeUndefined();
		const decisions = final.steps["approve-outline"]?.decisions ?? [];
		expect(decisions[0]).toMatchObject({ kind: "revise" });
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

	// An optional gate is skipped exactly when its artifacts are absent, so one
	// with no artifacts can never be skipped and never has anything to justify
	// stopping for. Silently, both ways: it reads as a gate that will stay out of
	// the way and behaves as one that always blocks.
	it("rejects an optional gate that shows nothing", () => {
		expect(() =>
			parsePipeline(
				"steps:\n  - id: g\n    gate: Just checking\n    optional: true\n",
				"/p.yaml",
				registry,
			),
		).toThrow(/optional but shows nothing/);
	});
});

/**
 * Pruning a gate's list.
 *
 * The list a gate lets you cut down is normally the one a later fan-out spends
 * money on, so what matters is not that the file changed but that the fan-out
 * downstream sees the cut.
 */
const SELECT_PIPELINE = `
steps:
  - id: propose
    agent: outliner
    input: Propose candidates.
    output: explore/candidates.json
  - id: prune
    gate: Review the candidates
    show: explore/candidates.json
    select:
      from: explore/candidates.json
      path: candidates
    on_reject: propose
  - id: judge
    agent: writer
    foreach:
      json: explore/candidates.json
      path: candidates
    input: Judge \${item.id}.
    output: verdicts/\${item.id}.md
`;

/** Writes a real candidates.json for the first step, Markdown for the fan-out. */
function proposer(): Script {
	const written = new Set<string>();
	return (ctx) => {
		const target = /Write your output to (\S+?)\.\s*$/m.exec(ctx.lastUserText)?.[1];
		if (target === undefined) return { text: "Done." };
		if (written.has(target)) return { text: `Wrote ${target}.` };
		written.add(target);

		const body = target.endsWith(".json")
			? `${JSON.stringify(
					{
						version: 1,
						candidates: ["ip-1", "ip-2", "ip-3"].map((id) => ({
							id,
							title: `Candidate ${id}`,
						})),
					},
					null,
					2,
				)}\n`
			: `# ${target}\n`;
		return { toolCalls: [{ name: "write", args: { path: target, content: body } }] };
	};
}

describe("gate select", () => {
	it("prunes the list and fans out over only what survived", async () => {
		const script = proposer();
		const first = await execute(script, undefined, undefined, SELECT_PIPELINE);
		expect(first.final.status).toBe("awaiting_gate");

		writeDecision(layout, "prune", { kind: "approve", keep: ["ip-1", "ip-3"] });
		const { final } = await execute(script, first.final, first.scripted, SELECT_PIPELINE);

		expect(final.status).toBe("completed");
		expect(fs.existsSync(path.join(workspace, "verdicts/ip-1.md"))).toBe(true);
		expect(fs.existsSync(path.join(workspace, "verdicts/ip-3.md"))).toBe(true);
		// The point of the whole feature: the dropped candidate is never paid for.
		expect(fs.existsSync(path.join(workspace, "verdicts/ip-2.md"))).toBe(false);
		// `outputs` is the ordered one; `items` is keyed in completion order, so
		// asserting its key sequence would pass or fail on scheduling.
		expect(final.steps["judge"]?.outputs).toEqual(["verdicts/ip-1.md", "verdicts/ip-3.md"]);
		expect(Object.keys(final.steps["judge"]?.items ?? {}).sort()).toEqual(["ip-1", "ip-3"]);
	});

	it("archives the unpruned list where a reviewer can get it back", async () => {
		const script = proposer();
		const first = await execute(script, undefined, undefined, SELECT_PIPELINE);
		writeDecision(layout, "prune", { kind: "approve", keep: ["ip-2"] });
		await execute(script, first.final, first.scripted, SELECT_PIPELINE);

		const archived = fs
			.readdirSync(path.join(layout.attemptsDir, "prune", "explore"), { recursive: true })
			.map(String);
		expect(archived.some((name) => name.startsWith("candidates.attempt"))).toBe(true);
	});

	// Approving without a keep list must not quietly become "keep nothing".
	it("keeps everything when approved without a keep list", async () => {
		const script = proposer();
		const first = await execute(script, undefined, undefined, SELECT_PIPELINE);
		writeDecision(layout, "prune", { kind: "approve" });
		const { final } = await execute(script, first.final, first.scripted, SELECT_PIPELINE);

		expect(final.steps["judge"]?.outputs).toEqual([
			"verdicts/ip-1.md",
			"verdicts/ip-2.md",
			"verdicts/ip-3.md",
		]);
	});

	// A typo must not spend the run on the subset it happened to recognise. The
	// gate is left awaiting so the reviewer can answer again.
	it("refuses an unknown id and leaves the gate awaiting", async () => {
		const script = proposer();
		const first = await execute(script, undefined, undefined, SELECT_PIPELINE);
		writeDecision(layout, "prune", { kind: "approve", keep: ["ip-1", "ip-33"] });

		await expect(
			execute(script, first.final, first.scripted, SELECT_PIPELINE),
		).rejects.toThrow(/Available: ip-1, ip-2, ip-3/);

		const state = new RunStateStore(layout).load();
		expect(state.steps["prune"]?.status).toBe("awaiting");
		expect(fs.existsSync(path.join(workspace, "verdicts/ip-1.md"))).toBe(false);
		const list = JSON.parse(
			fs.readFileSync(path.join(workspace, "explore/candidates.json"), "utf-8"),
		) as { candidates: Array<{ id: string }> };
		expect(list.candidates.map((entry) => entry.id)).toEqual(["ip-1", "ip-2", "ip-3"]);
	});

	it("publishes the selectable ids in the file-gate request", async () => {
		await execute(proposer(), undefined, undefined, SELECT_PIPELINE);

		const request = JSON.parse(fs.readFileSync(gateRequestFile(layout, "prune"), "utf-8")) as {
			selectable?: { file: string; items: Array<{ id: string; label?: string }> };
			howToRespond: Record<string, string>;
		};
		expect(request.selectable?.file).toBe("explore/candidates.json");
		expect(request.selectable?.items.map((item) => item.id)).toEqual(["ip-1", "ip-2", "ip-3"]);
		expect(request.howToRespond["approveSome"]).toContain("--keep ip-1,ip-2");
	});

	// --keep against a gate with nothing to prune is a mistake worth naming: the
	// reviewer believes they cut the list, and silently approving all of it is the
	// one outcome they did not ask for.
	it("refuses a keep list on a gate with no select", async () => {
		const script = scribe();
		const first = await execute(script);
		writeDecision(layout, "approve-outline", { kind: "approve", keep: ["anything"] });

		await expect(execute(script, first.final, first.scripted)).rejects.toThrow(
			/does not declare "select:"/,
		);
	});
});

const OPTIONAL_GATE_PIPELINE = `
steps:
  - id: outline
    agent: outliner
    input: Draft the outline.
    output: outline/outline.md
  - id: supply-extras
    gate: Supply what could not be fetched
    optional: true
    show: outline/missing.md
  - id: write
    agent: writer
    input: Write from \${steps.outline.outputs}.
    output: draft/paper.md
`;

/**
 * A gate that only sometimes has a decision to offer.
 *
 * The shipped case is supplying PDFs that failed to download: worth stopping for
 * when some failed, and pure friction when none did. Stopping regardless would
 * mean an unattended run halting after every clean fetch — in file mode an exit
 * 10 and an approve-and-resume cycle to answer a question with no material
 * behind it.
 */
describe("optional gates", () => {
	it("is skipped when the artifact was never written", async () => {
		const { final } = await execute(scribe(), undefined, undefined, OPTIONAL_GATE_PIPELINE);

		expect(final.status).toBe("completed");
		expect(final.steps["supply-extras"]?.status).toBe("skipped");
		// Skipping is not stopping: everything downstream still ran.
		expect(final.steps["write"]?.status).toBe("completed");
	});

	// The builtin deletes its list rather than emptying it, but an empty file is
	// the same absence of anything to decide about.
	it("is skipped when the artifact is empty", async () => {
		fs.mkdirSync(path.join(workspace, "outline"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "outline", "missing.md"), "");

		const { final } = await execute(scribe(), undefined, undefined, OPTIONAL_GATE_PIPELINE);

		expect(final.steps["supply-extras"]?.status).toBe("skipped");
		expect(final.status).toBe("completed");
	});

	it("stops as any other gate would once there is something to show", async () => {
		fs.mkdirSync(path.join(workspace, "outline"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "outline", "missing.md"), "# 3 papers still missing\n");

		const { final } = await execute(scribe(), undefined, undefined, OPTIONAL_GATE_PIPELINE);

		expect(final.status).toBe("awaiting_gate");
		expect(final.steps["supply-extras"]?.status).toBe("awaiting");
		// And the run did not run ahead of the decision.
		expect(final.steps["write"]).toBeUndefined();
	});
});
