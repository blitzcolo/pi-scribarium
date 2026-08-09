import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAgentFile } from "../../src/agents/parse.js";
import { AgentRegistry } from "../../src/agents/registry.js";
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
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-resume-"));
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(path.join(workspace, "corpus", "text"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	layout = new RunLayout(workspace, newRunId());
	layout.ensure();
});

afterEach(() => {
	fs.rmSync(path.dirname(workspace), { recursive: true, force: true });
});

const registry = AgentRegistry.fromDefinitions([
	parseAgentFile(
		`---\nname: analyst\ndescription: analyst\nmodel: ${SCRIPTED_MODEL_REF}\ntools: [read, write]\n---\n\nYou are the analyst.\n`,
		"/agents/analyst.md",
		"shipped",
	),
]);

const FANOUT = `
steps:
  - id: analyze
    agent: analyst
    foreach: "corpus/text/*.md"
    parallel: 2
    input: Analyse \${item.path}.
    output: analysis/\${item.id}.md
`;

function seedCorpus(count: number): string[] {
	const ids: string[] = [];
	for (let i = 1; i <= count; i++) {
		const id = `paper-${String(i).padStart(2, "0")}`;
		fs.writeFileSync(path.join(workspace, "corpus", "text", `${id}.md`), `# ${id}\n`);
		ids.push(id);
	}
	return ids;
}

function writer(): Script {
	const seen = new Set<string>();
	return (ctx) => {
		const target = /Write your output to (\S+?)\.\s*$/m.exec(ctx.lastUserText)?.[1];
		if (target === undefined) return { text: "Done." };
		if (seen.has(target)) return { text: `Wrote ${target}.` };
		seen.add(target);
		return { toolCalls: [{ name: "write", args: { path: target, content: "body\n" } }] };
	};
}

async function execute(source: string, script: Script, state?: RunState, scripted?: ScriptedRuntime) {
	const spec = parsePipeline(source, path.join(workspace, "pipeline.yaml"), registry);
	const runtime = scripted ?? (await createScriptedRuntime(agentDir, script));
	const runState =
		state ??
		RunStateStore.create(layout, initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }));

	const final = await runPipeline({
		spec,
		layout,
		state: runState,
		registry,
		modelRuntime: runtime.runtime,
		agentDir,
	});
	return { final, scripted: runtime };
}

describe("resume", () => {
	// M3 acceptance: a killed fan-out re-runs only what it did not finish. This
	// is what makes an interrupted thirty-paper run cheap to recover.
	it("re-runs only the incomplete items of a partial fan-out", async () => {
		seedCorpus(6);
		const spec = parsePipeline(FANOUT, path.join(workspace, "pipeline.yaml"), registry);
		const state = RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(FANOUT) }),
		);

		// Simulate a kill after four of six items settled.
		fs.mkdirSync(path.join(workspace, "analysis"), { recursive: true });
		const finished = ["paper-01", "paper-02", "paper-03", "paper-04"];
		for (const id of finished) {
			fs.writeFileSync(path.join(workspace, "analysis", `${id}.md`), "body\n");
		}
		state.steps["analyze"] = {
			type: "foreach",
			status: "failed",
			attempts: 1,
			outputs: finished.map((id) => `analysis/${id}.md`),
			items: Object.fromEntries(
				finished.map((id) => [id, { status: "completed" as const, outputs: [`analysis/${id}.md`] }]),
			),
		};
		new RunStateStore(layout).save(state);

		const { final, scripted } = await execute(FANOUT, writer(), state);

		expect(final.status).toBe("completed");
		expect(Object.keys(final.steps["analyze"]?.items ?? {})).toHaveLength(6);

		// Only the two unfinished papers reached the model.
		const analysed = scripted.requests
			.map((r) => /analysis\/(paper-\d+)\.md/.exec(r.lastUserText)?.[1])
			.filter((id): id is string => id !== undefined);
		expect(new Set(analysed)).toEqual(new Set(["paper-05", "paper-06"]));
	});

	it("keeps completed items when a later attempt adds the rest", async () => {
		seedCorpus(3);
		const spec = parsePipeline(FANOUT, path.join(workspace, "pipeline.yaml"), registry);
		const state = RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(FANOUT) }),
		);
		fs.mkdirSync(path.join(workspace, "analysis"), { recursive: true });
		fs.writeFileSync(path.join(workspace, "analysis", "paper-01.md"), "kept\n");
		state.steps["analyze"] = {
			type: "foreach",
			status: "failed",
			attempts: 1,
			outputs: ["analysis/paper-01.md"],
			items: { "paper-01": { status: "completed", outputs: ["analysis/paper-01.md"] } },
		};
		new RunStateStore(layout).save(state);

		const { final } = await execute(FANOUT, writer(), state);

		expect(final.steps["analyze"]?.status).toBe("completed");
		// The already-finished artifact was not rewritten.
		expect(fs.readFileSync(path.join(workspace, "analysis", "paper-01.md"), "utf-8")).toBe("kept\n");
	});
});

describe("pipeline drift", () => {
	// Resuming across an edited spec would mix steps produced by two different
	// pipelines, so the mismatch is reported rather than silently applied.
	it("detects that the source no longer matches the frozen copy", () => {
		const original = FANOUT;
		const edited = `${FANOUT}    max_failures: 1\n`;

		expect(hashPipeline(original)).not.toBe(hashPipeline(edited));

		const spec = parsePipeline(original, path.join(workspace, "pipeline.yaml"), registry);
		const state = RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(original) }),
		);

		// What `resume` compares.
		expect(hashPipeline(edited) === state.pipelineHash).toBe(false);
		expect(hashPipeline(original) === state.pipelineHash).toBe(true);
	});
});
