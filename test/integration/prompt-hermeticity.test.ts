import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import { createStageResourceLoader, staticResourceLoader } from "../../src/runtime/resource-loader.js";

/**
 * Regression tests for CLAUDE.md gotcha #2.
 *
 * Overriding the system prompt does not, by itself, isolate an agent role:
 * `buildSystemPrompt()` still appends project context files and the skills
 * catalogue. If a role's prompt silently absorbs the developer's AGENTS.md,
 * stage output stops being reproducible across machines — and nothing fails
 * loudly enough to notice.
 *
 * These tests need no credentials and make no network calls: a session can be
 * constructed without a resolved model, and `session.systemPrompt` is readable
 * immediately.
 */

const ROLE = "ROLE_PROMPT_SENTINEL";
const PROJECT_CONTEXT = "PROJECT_CONTEXT_SENTINEL";
const APPEND_SYSTEM = "APPEND_SYSTEM_SENTINEL";
const SKILL = "SKILL_SENTINEL";

let root: string;
let cwd: string;
let agentDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-hermetic-"));
	cwd = path.join(root, "workspace");
	agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });

	// Plant everything the SDK is known to pull into a system prompt.
	fs.writeFileSync(path.join(cwd, "AGENTS.md"), `# Project\n\n${PROJECT_CONTEXT}\n`);
	fs.writeFileSync(path.join(agentDir, "APPEND_SYSTEM.md"), `${APPEND_SYSTEM}\n`);
	const skillDir = path.join(agentDir, "skills", "planted");
	fs.mkdirSync(skillDir, { recursive: true });
	fs.writeFileSync(
		path.join(skillDir, "SKILL.md"),
		`---\nname: planted\ndescription: ${SKILL}\n---\n\nSkill body.\n`,
	);
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

async function systemPromptFor(resourceLoader: ResourceLoader): Promise<string> {
	const modelRuntime = await ModelRuntime.create({
		authPath: path.join(agentDir, "auth.json"),
		modelsPath: path.join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime,
		resourceLoader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager: SettingsManager.inMemory({ quietStartup: true }),
		// `read` must be enabled: the SDK only injects the skills catalogue when
		// it is, so disabling it would hide the very leak under test.
		tools: ["read"],
	});
	try {
		return session.systemPrompt;
	} finally {
		session.dispose();
	}
}

describe("stage prompt hermeticity", () => {
	it("keeps the machine's context files and skills out of a replace-mode role", async () => {
		const loader = await createStageResourceLoader({
			cwd,
			agentDir,
			systemPrompt: ROLE,
			promptMode: "replace",
			inheritResources: false,
		});

		const prompt = await systemPromptFor(loader);

		expect(prompt).toContain(ROLE);
		expect(prompt).not.toContain(PROJECT_CONTEXT);
		expect(prompt).not.toContain(APPEND_SYSTEM);
		expect(prompt).not.toContain(SKILL);
	});

	it("static loader yields the role prompt and nothing else of substance", async () => {
		const prompt = await systemPromptFor(staticResourceLoader(ROLE));

		expect(prompt).toContain(ROLE);
		expect(prompt).not.toContain(PROJECT_CONTEXT);
		expect(prompt).not.toContain(APPEND_SYSTEM);
		expect(prompt).not.toContain(SKILL);
		// Only the role plus the SDK's trailing cwd line.
		expect(prompt.length).toBeLessThan(ROLE.length + 200);
	});

	// The trap itself. If this ever stops leaking, upstream changed the
	// behaviour and the mitigation above can be reconsidered — but until then,
	// `systemPromptOverride` alone is not isolation.
	it("demonstrates that systemPromptOverride alone still leaks", async () => {
		const naive = new DefaultResourceLoader({
			cwd,
			agentDir,
			systemPromptOverride: () => ROLE,
		});
		await naive.reload();

		const prompt = await systemPromptFor(naive);

		expect(prompt).toContain(ROLE);
		expect(prompt).toContain(PROJECT_CONTEXT);
		expect(prompt).toContain(APPEND_SYSTEM);
	});

	it("inherit_resources opts back in deliberately", async () => {
		const loader = await createStageResourceLoader({
			cwd,
			agentDir,
			systemPrompt: ROLE,
			promptMode: "append",
			inheritResources: true,
		});

		const prompt = await systemPromptFor(loader);

		expect(prompt).toContain(ROLE);
		expect(prompt).toContain(PROJECT_CONTEXT);
	});
});
