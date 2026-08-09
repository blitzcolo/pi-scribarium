import { describe, expect, it } from "vitest";

import { normalizeTools, parseAgentFile } from "../../src/agents/parse.js";
import { AGENT_DEFAULTS, DEFAULT_TOOLS } from "../../src/agents/types.js";
import { AgentDefinitionError } from "../../src/util/errors.js";

const FILE = "/agents/example.md";

function agentFile(frontmatter: string, body = "You are a test agent."): string {
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

const MINIMAL = "name: example\ndescription: An example agent.";

describe("parseAgentFile", () => {
	it("parses a minimal pi-compatible definition and applies defaults", () => {
		const agent = parseAgentFile(agentFile(MINIMAL), FILE, "workspace");

		expect(agent.name).toBe("example");
		expect(agent.description).toBe("An example agent.");
		expect(agent.systemPrompt).toBe("You are a test agent.");
		expect(agent.source).toBe("workspace");
		expect(agent.filePath).toBe(FILE);

		expect(agent.promptMode).toBe(AGENT_DEFAULTS.promptMode);
		expect(agent.maxTurns).toBe(AGENT_DEFAULTS.maxTurns);
		expect(agent.softTurnRatio).toBe(AGENT_DEFAULTS.softTurnRatio);
		expect(agent.compaction).toBe(AGENT_DEFAULTS.compaction);
		expect(agent.inheritResources).toBe(AGENT_DEFAULTS.inheritResources);
		expect(agent.outputs).toEqual([]);

		// Unspecified optionals must be absent, not present-and-undefined.
		expect("modelRef" in agent).toBe(false);
		expect("tools" in agent).toBe(false);
		expect("thinking" in agent).toBe(false);
		expect("timeoutMs" in agent).toBe(false);
	});

	// Acceptance criterion: pi writes `tools` as a comma string, we also allow a
	// YAML list. Both must normalize identically.
	it("treats the comma-string and YAML-list tool forms as identical", () => {
		const commaForm = parseAgentFile(
			agentFile(`${MINIMAL}\ntools: read, grep, write`),
			FILE,
			"user",
		);
		const listForm = parseAgentFile(
			agentFile(`${MINIMAL}\ntools: [read, grep, write]`),
			FILE,
			"user",
		);
		const blockForm = parseAgentFile(
			agentFile(`${MINIMAL}\ntools:\n  - read\n  - grep\n  - write`),
			FILE,
			"user",
		);

		expect(commaForm.tools).toEqual(["read", "grep", "write"]);
		expect(listForm.tools).toEqual(commaForm.tools);
		expect(blockForm.tools).toEqual(commaForm.tools);
	});

	it("parses the full scribarium superset", () => {
		const agent = parseAgentFile(
			agentFile(
				[
					MINIMAL,
					"model: anthropic/claude-opus-4-5:high",
					"tools: [read, write]",
					"thinking: high",
					"prompt_mode: append",
					"max_turns: 12",
					"soft_turn_ratio: 0.5",
					"timeout_ms: 900000",
					"output: draft/${item.id}.md",
					"compaction: false",
					"inherit_resources: true",
				].join("\n"),
			),
			FILE,
			"project",
		);

		expect(agent.modelRef).toBe("anthropic/claude-opus-4-5:high");
		expect(agent.thinking).toBe("high");
		expect(agent.promptMode).toBe("append");
		expect(agent.maxTurns).toBe(12);
		expect(agent.softTurnRatio).toBe(0.5);
		expect(agent.timeoutMs).toBe(900_000);
		expect(agent.outputs).toEqual(["draft/${item.id}.md"]);
		expect(agent.compaction).toBe(false);
		expect(agent.inheritResources).toBe(true);
	});

	it("accepts a list of declared outputs", () => {
		const agent = parseAgentFile(
			agentFile(`${MINIMAL}\noutput: [outline/outline.md, outline/sections.json]`),
			FILE,
			"shipped",
		);
		expect(agent.outputs).toEqual(["outline/outline.md", "outline/sections.json"]);
	});

	// YAML 1.2 semantics: `no` is the string "no", not false. This is why the
	// SDK's real `yaml` parser matters (CLAUDE.md gotcha #9).
	it("rejects YAML-1.1-style booleans rather than silently coercing", () => {
		expect(() => parseAgentFile(agentFile(`${MINIMAL}\ncompaction: no`), FILE, "user")).toThrow(
			/must be true or false/,
		);
	});

	describe("validation", () => {
		it.each([
			["name", "description: Only a description."],
			["description", "name: only-a-name"],
		])("rejects a definition missing %s", (_field, frontmatter) => {
			expect(() => parseAgentFile(agentFile(frontmatter), FILE, "user")).toThrow(
				AgentDefinitionError,
			);
		});

		it("rejects an empty body, which would be an empty system prompt", () => {
			expect(() => parseAgentFile(agentFile(MINIMAL, "   "), FILE, "user")).toThrow(
				/body is empty/,
			);
		});

		it.each(["Example", "has space", "-leading", "UPPER"])(
			"rejects the invalid agent name %j",
			(name) => {
				expect(() =>
					parseAgentFile(agentFile(`name: ${JSON.stringify(name)}\ndescription: x`), FILE, "user"),
				).toThrow(/must match/);
			},
		);

		it("rejects an unknown thinking level", () => {
			expect(() =>
				parseAgentFile(agentFile(`${MINIMAL}\nthinking: extreme`), FILE, "user"),
			).toThrow(/must be one of/);
		});

		it("rejects a non-integer max_turns", () => {
			expect(() => parseAgentFile(agentFile(`${MINIMAL}\nmax_turns: 2.5`), FILE, "user")).toThrow(
				/whole number/,
			);
		});

		it.each([0, 1.5])("rejects the out-of-range soft_turn_ratio %s", (ratio) => {
			expect(() =>
				parseAgentFile(agentFile(`${MINIMAL}\nsoft_turn_ratio: ${ratio}`), FILE, "user"),
			).toThrow(AgentDefinitionError);
		});

		it("names the offending file in the error message", () => {
			expect(() => parseAgentFile(agentFile("description: no name"), FILE, "user")).toThrow(
				new RegExp(FILE.replace(/\//g, "\\/")),
			);
		});
	});
});

describe("normalizeTools", () => {
	it("returns undefined when unspecified so the caller can apply defaults", () => {
		expect(normalizeTools(undefined, FILE)).toBeUndefined();
		expect(normalizeTools(null, FILE)).toBeUndefined();
		expect(DEFAULT_TOOLS).toEqual(["read", "grep", "find", "ls"]);
	});

	it("treats `all` as unspecified and `none`/empty as an explicit empty allowlist", () => {
		expect(normalizeTools("all", FILE)).toBeUndefined();
		// The SDK honours [] as a real empty allowlist (CLAUDE.md gotcha #8).
		expect(normalizeTools("none", FILE)).toEqual([]);
		expect(normalizeTools("", FILE)).toEqual([]);
		expect(normalizeTools([], FILE)).toEqual([]);
	});

	it("trims, drops empties, and dedupes", () => {
		expect(normalizeTools(" read ,, grep ,read ", FILE)).toEqual(["read", "grep"]);
	});

	it("rejects unknown tool names instead of letting pi silently ignore them", () => {
		expect(() => normalizeTools("read, telepathy", FILE)).toThrow(/unknown tool "telepathy"/);
		expect(() => normalizeTools("read, telepathy, alchemy", FILE)).toThrow(/unknown tools/);
	});

	it("rejects a structurally wrong value", () => {
		expect(() => normalizeTools(42, FILE)).toThrow(/comma-separated string or a list/);
	});
});
