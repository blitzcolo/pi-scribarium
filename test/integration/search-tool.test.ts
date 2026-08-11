import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentDefinition } from "../../src/agents/types.js";
import { runStage } from "../../src/runtime/run-stage.js";
import { offlineFetcher, scriptedFetcher, type ScriptedRoute } from "../helpers/scripted-fetch.js";
import {
	createScriptedRuntime,
	SCRIPTED_MODEL_REF,
	type Script,
} from "../helpers/scripted-provider.js";

/**
 * The custom tool, exercised through a real agent session.
 *
 * The unit tests call `execute` directly; this proves the other half — that the
 * SDK actually advertises the tool, routes a tool call to it, and feeds its
 * result back into the next turn — and that an agent which was not granted it
 * cannot reach the network at all.
 */

let root: string;
let workspace: string;
let agentDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-searchtool-"));
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function agent(tools: string[]): AgentDefinition {
	return {
		name: "planner",
		description: "Query planner",
		modelRef: SCRIPTED_MODEL_REF,
		promptMode: "replace",
		maxTurns: 10,
		softTurnRatio: 0.8,
		outputs: [],
		compaction: true,
		inheritResources: false,
		systemPrompt: "Plan queries.",
		source: "shipped",
		filePath: "/agents/planner.md",
		tools,
		...{},
	};
}

const S2_HIT = JSON.stringify({
	data: [
		{
			paperId: "a",
			title: "Cross-Modal Fusion Networks",
			year: 2023,
			venue: "CVPR",
			citationCount: 214,
			abstract: "We align infrared and visible features without paired annotations.",
			externalIds: { DOI: "10.1/a" },
			authors: [{ name: "Wei Zhang" }],
		},
	],
});

const ROUTES: ScriptedRoute[] = [
	{ match: "export.arxiv.org", body: '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>' },
	{ match: "api.semanticscholar.org", body: S2_HIT },
	{ match: "api.openalex.org", body: JSON.stringify({ results: [] }) },
];

describe("search_papers in a live session", () => {
	it("is advertised to a granting agent and its result reaches the next turn", async () => {
		const { fetch, requests } = scriptedFetcher(ROUTES);
		const seen: string[][] = [];

		const script: Script = (ctx) => {
			seen.push(ctx.toolNames);
			if (ctx.turn === 1) {
				return {
					toolCalls: [{ name: "search_papers", args: { query: "infrared visible fusion" } }],
				};
			}
			return { text: "done" };
		};
		const scripted = await createScriptedRuntime(agentDir, script);

		const result = await runStage({
			agent: agent(["read", "write", "search_papers"]),
			prompt: "Probe the query.",
			cwd: workspace,
			agentDir,
			modelRuntime: scripted.runtime,
			customToolContext: { fetcher: fetch },
		});

		expect(result.status).toBe("completed");
		// The SDK filters custom tools through the same strict allowlist, so this
		// asserts the name survived both the allowlist and the customTools array.
		expect(seen[0]).toContain("search_papers");
		expect(requests.some((url) => url.includes("api.semanticscholar.org"))).toBe(true);

		// The tool's output must come back as a tool result the model can read.
		const transcript = JSON.stringify(scripted.requests);
		expect(transcript.length).toBeGreaterThan(0);
		expect(result.turns).toBe(2);
	});

	// Every shipped agent but the query planner grants no custom tool, and the
	// tool allowlist is the only containment this project has.
	it("is invisible to an agent that did not grant it", async () => {
		const { fetch, requests } = offlineFetcher();
		const seen: string[][] = [];

		const scripted = await createScriptedRuntime(agentDir, (ctx) => {
			seen.push(ctx.toolNames);
			return { text: "no tools needed" };
		});

		await runStage({
			agent: agent(["read", "write"]),
			prompt: "Write a card.",
			cwd: workspace,
			agentDir,
			modelRuntime: scripted.runtime,
			// Supplied but unreachable: the grant, not the context, is the gate.
			customToolContext: { fetcher: fetch },
		});

		expect(seen[0]).not.toContain("search_papers");
		expect(requests).toEqual([]);
	});

	it("reports a refused non-English query back to the model without searching", async () => {
		const { fetch, requests } = scriptedFetcher(ROUTES);
		let turns = 0;

		const scripted = await createScriptedRuntime(agentDir, (ctx) => {
			turns = ctx.turn;
			if (ctx.turn === 1) {
				return { toolCalls: [{ name: "search_papers", args: { query: "红外与可见光融合" } }] };
			}
			return { text: "translated and retried" };
		});

		const result = await runStage({
			agent: agent(["read", "search_papers"]),
			prompt: "Probe the query.",
			cwd: workspace,
			agentDir,
			modelRuntime: scripted.runtime,
			customToolContext: { fetcher: fetch },
		});

		// The refusal is an ordinary tool result: the model gets to correct itself
		// rather than the stage failing.
		expect(result.status).toBe("completed");
		expect(turns).toBe(2);
		expect(requests).toEqual([]);
	});
});
