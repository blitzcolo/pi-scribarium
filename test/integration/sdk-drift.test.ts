import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	parseFrontmatter,
	resolveCliModel,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

import { staticResourceLoader } from "../../src/runtime/resource-loader.js";
import { createScriptedRuntime } from "../helpers/scripted-provider.js";

/**
 * Upstream drift detector.
 *
 * pi is pre-1.0 and its own documentation already contradicts its types in
 * several places, so the behaviours CLAUDE.md records are asserted here rather
 * than trusted. Each test names the gotcha it guards: when one fails, the
 * mitigation built on it needs rethinking, not patching around.
 *
 * These use the scripted provider and cost nothing.
 */

/** getModel returns `Model | undefined`; spread it so the option stays absent. */
function modelOption(runtime: ModelRuntime): { model?: never } {
	const model = runtime.getModel("scribarium-scripted", "scripted");
	return (model === undefined ? {} : { model }) as { model?: never };
}

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-drift-"));
	cwd = path.join(root, "ws");
	agentDir = path.join(root, "pi");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

describe("SDK surface", () => {
	it("still exports everything the orchestrator imports", () => {
		for (const [name, value] of Object.entries({
			createAgentSession,
			DefaultResourceLoader,
			getAgentDir,
			ModelRuntime,
			parseFrontmatter,
			resolveCliModel,
			SessionManager,
			SettingsManager,
		})) {
			expect(value, `${name} disappeared from the SDK`).toBeTypeOf("function");
		}
	});

	// Gotcha #6: the SDK's peers are nested under its own shrinkwrap.
	it("does not resolve SDK sub-packages from our root", async () => {
		// The specifier is held in a variable so TypeScript does not try to
		// resolve it either — that it cannot is the point of the test.
		const nested = "@earendil-works/pi-agent-core";
		await expect(import(nested)).rejects.toThrow();
	});

	// Gotcha #7: synchronous, returns undefined rather than throwing.
	it("keeps resolveCliModel synchronous with an error field", async () => {
		const runtime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const result = resolveCliModel({ cliModel: "no-such-provider/no-such-model", modelRuntime: runtime });

		expect(result).not.toBeInstanceOf(Promise);
		expect(result.model).toBeUndefined();
		expect(typeof result.error === "string" || result.error === undefined).toBe(true);
	});

	// Gotcha #9: parseFrontmatter uses a real YAML parser, so both tool spellings
	// arrive as their natural types.
	it("parses frontmatter as YAML 1.2", () => {
		const array = parseFrontmatter<{ tools?: unknown; flag?: unknown }>(
			"---\ntools: [read, grep]\nflag: no\n---\n\nbody\n",
		);
		expect(Array.isArray(array.frontmatter.tools)).toBe(true);
		// YAML 1.2: `no` is the string, not false.
		expect(array.frontmatter.flag).toBe("no");
		expect(array.body).toBe("body");
	});
});

describe("session behaviours the design depends on", () => {
	// Gotcha #2, the one that fails silently. If this ever stops leaking,
	// upstream changed and the static loader can be reconsidered.
	it("still appends context files and skills to a custom system prompt", async () => {
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "PROJECT_SENTINEL");
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
			allowModelNetwork: false,
		});

		const naive = new DefaultResourceLoader({ cwd, agentDir, systemPromptOverride: () => "ROLE" });
		await naive.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader: naive,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ quietStartup: true }),
			tools: ["read"],
		});
		try {
			expect(session.systemPrompt).toContain("PROJECT_SENTINEL");
		} finally {
			session.dispose();
		}
	});

	it("keeps a static ResourceLoader hermetic", async () => {
		fs.writeFileSync(path.join(cwd, "AGENTS.md"), "PROJECT_SENTINEL");
		const modelRuntime = await ModelRuntime.create({
			authPath: path.join(agentDir, "auth.json"),
			modelsPath: path.join(agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime,
			resourceLoader: staticResourceLoader("ROLE_ONLY"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ quietStartup: true }),
			tools: ["read"],
		});
		try {
			expect(session.systemPrompt).toContain("ROLE_ONLY");
			expect(session.systemPrompt).not.toContain("PROJECT_SENTINEL");
		} finally {
			session.dispose();
		}
	});

	// Gotcha #1: a mid-run provider failure does not reject prompt().
	it("reports a mid-run provider error on state.errorMessage, not by throwing", async () => {
		const scripted = await createScriptedRuntime(agentDir, () => ({ error: "upstream exploded" }));
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: scripted.runtime,
			...modelOption(scripted.runtime),
			resourceLoader: staticResourceLoader("ROLE"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ quietStartup: true }),
			tools: [],
		});
		try {
			// Must not throw.
			await session.prompt("do the thing");
			expect(session.state.errorMessage).toMatch(/upstream exploded/);
		} finally {
			session.dispose();
		}
	});

	// Gotcha #8 and #11: [] is a real empty allowlist, and stats are aggregated.
	it("honours an empty tool allowlist and reports usage", async () => {
		const scripted = await createScriptedRuntime(agentDir, () => ({
			text: "done",
			usage: { input: 42, output: 7 },
		}));
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			modelRuntime: scripted.runtime,
			...modelOption(scripted.runtime),
			resourceLoader: staticResourceLoader("ROLE"),
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ quietStartup: true }),
			tools: [],
		});
		try {
			await session.prompt("hello");
			expect(scripted.requests[0]?.toolNames).toEqual([]);
			expect(session.getSessionStats().tokens.input).toBe(42);
			expect(session.getLastAssistantText()).toBe("done");
		} finally {
			session.dispose();
		}
	});
});
