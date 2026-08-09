import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseAgentFile } from "../../src/agents/parse.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { initialRunState, runPipeline, type PipelineEvent } from "../../src/pipeline/engine.js";
import { parsePipeline } from "../../src/pipeline/load.js";
import { hashPipeline, newRunId, RunLayout } from "../../src/workspace/layout.js";
import { RunStateStore } from "../../src/workspace/run-state.js";
import { createScriptedRuntime, SCRIPTED_MODEL_REF, type Script } from "../helpers/scripted-provider.js";

let workspace: string;
let agentDir: string;
let layout: RunLayout;

beforeEach(() => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-fanout-"));
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

/** Create `count` corpus documents named paper-01 … paper-NN. */
function seedCorpus(count: number): string[] {
	const ids: string[] = [];
	for (let i = 1; i <= count; i++) {
		const id = `paper-${String(i).padStart(2, "0")}`;
		fs.writeFileSync(path.join(workspace, "corpus", "text", `${id}.md`), `# ${id}\n\nBody.\n`);
		ids.push(id);
	}
	return ids;
}

const PIPELINE = (extra = "") => `
steps:
  - id: analyze
    agent: analyst
    foreach: "corpus/text/*.md"
    parallel: 4
    input: Analyse \${item.path}.
    output: analysis/\${item.id}.md
${extra}
`;

async function execute(source: string, script: Script) {
	const spec = parsePipeline(source, path.join(workspace, "pipeline.yaml"), registry);
	const scripted = await createScriptedRuntime(agentDir, script);
	const state = RunStateStore.create(
		layout,
		initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }),
	);
	const events: PipelineEvent[] = [];

	const final = await runPipeline({
		spec,
		layout,
		state,
		registry,
		modelRuntime: scripted.runtime,
		agentDir,
		onEvent: (event) => events.push(event),
	});
	return { final, scripted, events };
}

/**
 * Writes the analysis for whichever item the prompt names, then finishes.
 * `failing` ids error instead, simulating a provider failure on those papers.
 *
 * Stateful per item rather than keyed off the last user message: after the write
 * the tool result still mentions the path, so a text-matching script would write
 * again and again until the turn budget stopped it — two turns per item is the
 * behaviour under test.
 */
function analystScript(failing: Set<string> = new Set()): Script {
	const written = new Set<string>();
	return (ctx) => {
		const id = /analysis\/([a-z0-9-]+)\.md/.exec(ctx.systemPrompt + ctx.lastUserText)?.[1];
		if (id === undefined) return { text: "Done." };
		if (failing.has(id)) return { error: `provider failed on ${id}` };
		if (written.has(id)) return { text: `Wrote analysis for ${id}.` };
		written.add(id);
		return {
			toolCalls: [{ name: "write", args: { path: `analysis/${id}.md`, content: `# ${id}\n` } }],
		};
	};
}

describe("foreach fan-out", () => {
	// M2 acceptance: 30 papers at concurrency 4.
	it("analyses 30 papers concurrently, one session and artifact each", async () => {
		const ids = seedCorpus(30);
		const { final, events } = await execute(PIPELINE(), analystScript());

		expect(final.status).toBe("completed");
		expect(final.steps["analyze"]?.status).toBe("completed");

		// Every paper produced its own artifact.
		for (const id of ids) {
			expect(fs.existsSync(path.join(workspace, "analysis", `${id}.md`))).toBe(true);
		}
		expect(Object.keys(final.steps["analyze"]?.items ?? {})).toHaveLength(30);
		expect(final.steps["analyze"]?.outputs).toHaveLength(30);

		const start = events.find((e) => e.type === "fanout_start");
		expect(start).toMatchObject({ total: 30, concurrency: 4 });
	});

	// The whole point of the pool: one unreadable paper must not discard the
	// twenty-nine already paid for.
	it("isolates failing items and still completes the rest", async () => {
		seedCorpus(30);
		const failing = new Set(["paper-05", "paper-17", "paper-23"]);
		const { final } = await execute(PIPELINE(), analystScript(failing));

		const step = final.steps["analyze"];
		expect(step?.status).toBe("completed");
		expect(final.status).toBe("completed");

		const items = step?.items ?? {};
		expect(Object.values(items).filter((i) => i.status === "completed")).toHaveLength(27);
		expect(Object.values(items).filter((i) => i.status === "failed")).toHaveLength(3);

		for (const id of failing) {
			expect(items[id]?.status).toBe("failed");
			expect(items[id]?.error?.message).toMatch(/provider failed/);
			// A failed item leaves no half-written artifact behind.
			expect(fs.existsSync(path.join(workspace, "analysis", `${id}.md`))).toBe(false);
		}
		expect(step?.outputs).toHaveLength(27);
	});

	it("checkpoints each item as it settles, not just at the end", async () => {
		seedCorpus(8);
		const { final } = await execute(PIPELINE(), analystScript());

		// The persisted checkpoint carries per-item detail, which is what lets a
		// resumed run skip the items already paid for.
		const persisted = new RunStateStore(layout).load();
		expect(Object.keys(persisted.steps["analyze"]?.items ?? {})).toHaveLength(8);
		expect(persisted.steps["analyze"]?.items?.["paper-01"]?.outputs).toEqual([
			"analysis/paper-01.md",
		]);
		expect(final.steps["analyze"]?.usage?.input).toBeGreaterThan(0);
	});

	it("stops the step when the failure budget is exhausted", async () => {
		seedCorpus(20);
		const { final } = await execute(
			PIPELINE("    max_failures: 2"),
			// Everything fails, so the budget trips almost immediately.
			() => ({ error: "always fails" }),
		);

		expect(final.status).toBe("failed");
		expect(final.steps["analyze"]?.error?.message).toMatch(/max_failures reached/);
	});

	it("fails the step when every item fails", async () => {
		seedCorpus(3);
		const { final } = await execute(PIPELINE(), () => ({ error: "all broken" }));

		expect(final.steps["analyze"]?.status).toBe("failed");
		expect(final.steps["analyze"]?.error?.message).toMatch(/3 of 3 items failed/);
	});

	it("fails cleanly when the fan-out matches nothing", async () => {
		const { final } = await execute(PIPELINE(), analystScript());
		expect(final.steps["analyze"]?.error?.message).toMatch(/matched no items/);
	});

	it("rolls per-item usage up into the step and the run total", async () => {
		seedCorpus(5);
		const { final } = await execute(PIPELINE(), analystScript());

		const step = final.steps["analyze"];
		expect(step?.usage?.input).toBe(final.usageTotal.input);
		expect(final.usageTotal.cost).toBeGreaterThan(0);
	});

	it("gives each item its own log file", async () => {
		seedCorpus(3);
		await execute(PIPELINE(), analystScript());

		for (const id of ["paper-01", "paper-02", "paper-03"]) {
			const log = fs.readFileSync(layout.logFile("analyze", id), "utf-8");
			expect(log).toContain(`analyze / ${id}`);
		}
	});
});

describe("fan-out accounting", () => {
	it("reports the sum of per-item turns rather than zero", async () => {
		seedCorpus(4);
		const { final } = await execute(PIPELINE(), analystScript());

		// Each item takes two turns (write, then summarise). Reporting 0 for a
		// fan-out step would make the turn budget look unused.
		expect(final.steps["analyze"]?.turns).toBe(8);
	});
});
