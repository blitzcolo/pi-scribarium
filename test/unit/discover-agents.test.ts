import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverAgents, findProjectAgentsDir } from "../../src/agents/discover.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { UnknownAgentError } from "../../src/util/errors.js";

let root: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-discover-"));
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

function writeAgent(dir: string, name: string, extra = ""): void {
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(
		path.join(dir, `${name}.md`),
		`---\nname: ${name}\ndescription: from ${path.basename(dir)}\n${extra}\n---\n\nBody for ${name}.\n`,
	);
}

/** Isolate discovery from the developer's real ~/.pi and repo layout. */
function discoverIn(options: { cwd: string; agentDir: string; workspaceDir?: string }) {
	return discoverAgents({ ...options, includeShipped: false });
}

describe("discoverAgents", () => {
	it("finds definitions across the user and workspace locations", () => {
		const agentDir = path.join(root, "pi-home");
		const workspace = path.join(root, "workspace");
		writeAgent(path.join(agentDir, "agents"), "from-user");
		writeAgent(path.join(workspace, ".scribarium", "agents"), "from-workspace");

		const { agents } = discoverIn({ cwd: workspace, agentDir, workspaceDir: workspace });

		expect(agents.map((a) => a.name).sort()).toEqual(["from-user", "from-workspace"]);
		expect(agents.find((a) => a.name === "from-user")?.source).toBe("user");
		expect(agents.find((a) => a.name === "from-workspace")?.source).toBe("workspace");
	});

	it("lets a higher-precedence source override the same agent name", () => {
		const agentDir = path.join(root, "pi-home");
		const workspace = path.join(root, "workspace");
		writeAgent(path.join(agentDir, "agents"), "writer", "max_turns: 5");
		writeAgent(path.join(workspace, ".scribarium", "agents"), "writer", "max_turns: 99");

		const { agents } = discoverIn({ cwd: workspace, agentDir, workspaceDir: workspace });

		expect(agents).toHaveLength(1);
		expect(agents[0]?.source).toBe("workspace");
		expect(agents[0]?.maxTurns).toBe(99);
	});

	it("picks up a project-level .pi/agents by walking upward from cwd", () => {
		const agentDir = path.join(root, "pi-home");
		const project = path.join(root, "project");
		const nested = path.join(project, "a", "b", "c");
		fs.mkdirSync(nested, { recursive: true });
		writeAgent(path.join(project, ".pi", "agents"), "project-agent");

		expect(findProjectAgentsDir(nested)).toBe(path.join(project, ".pi", "agents"));

		const { agents } = discoverIn({ cwd: nested, agentDir });
		expect(agents.map((a) => a.name)).toEqual(["project-agent"]);
		expect(agents[0]?.source).toBe("project");
	});

	// One broken file in a shared ~/.pi/agent/agents must not take the tool down.
	it("reports invalid files as diagnostics without throwing", () => {
		const agentDir = path.join(root, "pi-home");
		const dir = path.join(agentDir, "agents");
		writeAgent(dir, "good");
		fs.writeFileSync(path.join(dir, "nameless.md"), "---\ndescription: no name here\n---\n\nBody.\n");
		fs.writeFileSync(path.join(dir, "bad-tool.md"), "---\nname: bad-tool\ndescription: x\ntools: telepathy\n---\n\nBody.\n");

		const { agents, diagnostics } = discoverIn({ cwd: root, agentDir });

		expect(agents.map((a) => a.name)).toEqual(["good"]);
		expect(diagnostics).toHaveLength(2);
		expect(diagnostics.map((d) => path.basename(d.filePath)).sort()).toEqual([
			"bad-tool.md",
			"nameless.md",
		]);
		expect(diagnostics.find((d) => d.filePath.endsWith("bad-tool.md"))?.message).toMatch(
			/unknown tool/,
		);
	});

	it("ignores non-markdown files and missing directories", () => {
		const agentDir = path.join(root, "pi-home");
		const dir = path.join(agentDir, "agents");
		writeAgent(dir, "real");
		fs.writeFileSync(path.join(dir, "notes.txt"), "not an agent");

		const { agents, diagnostics } = discoverIn({
			cwd: path.join(root, "does-not-exist"),
			agentDir,
		});

		expect(agents.map((a) => a.name)).toEqual(["real"]);
		expect(diagnostics).toEqual([]);
	});
});

describe("AgentRegistry", () => {
	it("looks agents up by name and exposes distinct model refs", () => {
		const agentDir = path.join(root, "pi-home");
		writeAgent(path.join(agentDir, "agents"), "alpha", "model: anthropic/claude-sonnet-4-5");
		writeAgent(path.join(agentDir, "agents"), "beta", "model: anthropic/claude-sonnet-4-5");
		writeAgent(path.join(agentDir, "agents"), "gamma", "model: deepseek/deepseek-chat");

		const registry = AgentRegistry.load({ cwd: root, agentDir, includeShipped: false });

		expect(registry.get("alpha").name).toBe("alpha");
		expect(registry.has("beta")).toBe(true);
		expect([...registry.modelRefs()].sort()).toEqual([
			"anthropic/claude-sonnet-4-5",
			"deepseek/deepseek-chat",
		]);
	});

	it("suggests near misses for an unknown agent", () => {
		const agentDir = path.join(root, "pi-home");
		writeAgent(path.join(agentDir, "agents"), "reviewer");

		const registry = AgentRegistry.load({ cwd: root, agentDir, includeShipped: false });

		expect(() => registry.get("reviwer")).toThrow(UnknownAgentError);
		expect(() => registry.get("reviwer")).toThrow(/Did you mean: reviewer/);
	});
});
