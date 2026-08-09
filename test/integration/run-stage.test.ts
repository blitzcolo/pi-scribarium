import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentDefinition } from "../../src/agents/types.js";
import { runStage } from "../../src/runtime/run-stage.js";
import {
	createScriptedRuntime,
	SCRIPTED_MODEL_REF,
	type Script,
	type ScriptedRuntime,
} from "../helpers/scripted-provider.js";

let root: string;
let workspace: string;
let agentDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-stage-"));
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(workspace, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function agent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
	return {
		name: "tester",
		description: "Test agent",
		modelRef: SCRIPTED_MODEL_REF,
		promptMode: "replace",
		maxTurns: 20,
		softTurnRatio: 0.8,
		outputs: [],
		compaction: true,
		inheritResources: false,
		systemPrompt: "ROLE_PROMPT_SENTINEL",
		source: "workspace",
		filePath: "/agents/tester.md",
		tools: ["read", "write"],
		...overrides,
	};
}

async function run(script: Script, overrides: Partial<AgentDefinition> = {}) {
	const scripted: ScriptedRuntime = await createScriptedRuntime(agentDir, script);
	const result = await runStage({
		agent: agent(overrides),
		prompt: "Do the task.",
		cwd: workspace,
		agentDir,
		modelRuntime: scripted.runtime,
	});
	return { result, scripted };
}

describe("runStage against a scripted provider", () => {
	it("completes a stage that writes a real file, and reports real usage", async () => {
		const { result } = await run((ctx) =>
			ctx.turn === 1
				? {
						toolCalls: [
							{ name: "write", args: { path: "out/report.md", content: "# Report\n\nBody.\n" } },
						],
					}
				: { text: "Wrote out/report.md.", usage: { input: 200, output: 80 } },
		);

		expect(result.status).toBe("completed");
		expect(result.error).toBeUndefined();
		expect(result.turns).toBe(2);
		expect(result.text).toBe("Wrote out/report.md.");

		// The tool really ran: the file exists on disk with the right content.
		expect(fs.readFileSync(path.join(workspace, "out/report.md"), "utf-8")).toContain("# Report");

		// Usage aggregates across both turns, and cost is derived from the model's
		// per-token prices rather than being reported as zero.
		expect(result.usage.input).toBe(300);
		expect(result.usage.output).toBe(130);
		expect(result.usage.cost).toBeGreaterThan(0);
	});

	// Regression for CLAUDE.md gotcha #1: a provider failure after acceptance does
	// not reject prompt(), so a stage that only used try/catch would report
	// "completed" for a run that plainly failed.
	it("reports a mid-run provider error as failed rather than completed", async () => {
		const { result } = await run((ctx) =>
			ctx.turn === 1 ? { error: "upstream exploded" } : { text: "unreachable" },
		);

		expect(result.status).toBe("failed");
		expect(result.error?.code).toBe("AGENT_ERROR");
		expect(result.error?.message).toMatch(/upstream exploded/);
	});

	it("steers at the soft limit and aborts at the hard limit", async () => {
		const { result, scripted } = await run(
			// Never finishes on its own: always asks for another tool call.
			() => ({ toolCalls: [{ name: "read", args: { path: "does-not-matter.md" } }] }),
			{ maxTurns: 4, softTurnRatio: 0.5 },
		);

		expect(result.status).toBe("failed");
		expect(result.error?.code).toBe("TURN_BUDGET_EXCEEDED");
		expect(result.softWarned).toBe(true);

		// abort() is cooperative: it stops the loop but a turn already in flight
		// still completes, so the observed count can exceed maxTurns by one. The
		// budget bounds the run; it is not an exact ceiling on turns executed.
		expect(result.turns).toBeGreaterThanOrEqual(4);
		expect(result.turns).toBeLessThanOrEqual(5);

		// The steer really reached the model as a user message.
		const sawBudgetNotice = scripted.requests.some((r) => r.lastUserText.includes("Budget notice"));
		expect(sawBudgetNotice).toBe(true);
	});

	it("sends the role prompt and nothing from the machine", async () => {
		fs.writeFileSync(path.join(workspace, "AGENTS.md"), "PROJECT_CONTEXT_SENTINEL");
		fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), "APPEND_SYSTEM_SENTINEL");

		const { scripted } = await run(() => ({ text: "done" }));

		const prompt = scripted.systemPrompts[0] ?? "";
		expect(prompt).toContain("ROLE_PROMPT_SENTINEL");
		expect(prompt).not.toContain("PROJECT_CONTEXT_SENTINEL");
		expect(prompt).not.toContain("APPEND_SYSTEM_SENTINEL");
	});

	it("advertises exactly the allowlisted tools, and does not leak between stages", async () => {
		const scripted = await createScriptedRuntime(agentDir, () => ({ text: "done" }));
		const common = { prompt: "Do it.", cwd: workspace, agentDir, modelRuntime: scripted.runtime };

		await runStage({ ...common, agent: agent({ tools: ["read"] }) });
		await runStage({ ...common, agent: agent({ tools: ["read", "write", "grep"] }) });
		await runStage({ ...common, agent: agent({ tools: [] }) });

		expect(scripted.requests[0]?.toolNames).toEqual(["read"]);
		expect(scripted.requests[1]?.toolNames.sort()).toEqual(["grep", "read", "write"]);
		// An empty allowlist really means no tools, not "fall back to defaults".
		expect(scripted.requests[2]?.toolNames).toEqual([]);
	});

	it("records a truncation when output exceeds the cap", async () => {
		const scripted = await createScriptedRuntime(agentDir, () => ({ text: "x".repeat(5000) }));
		const result = await runStage({
			agent: agent(),
			prompt: "Do it.",
			cwd: workspace,
			agentDir,
			modelRuntime: scripted.runtime,
			outputLimitBytes: 1024,
		});

		expect(result.truncated).toBe(true);
		expect(result.text).toMatch(/\[truncated:/);
		expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(1024);
	});
});
