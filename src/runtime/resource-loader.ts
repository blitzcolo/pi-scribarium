import {
	createExtensionRuntime,
	DefaultResourceLoader,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import type { PromptMode } from "../agents/types.js";

export interface StageResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	systemPrompt: string;
	promptMode: PromptMode;
	/** Opt back into the machine's skills, extensions, and context files. */
	inheritResources: boolean;
}

/**
 * A `ResourceLoader` that supplies exactly one system prompt and nothing else.
 *
 * Overriding `systemPromptOverride` alone does **not** isolate a role:
 * `buildSystemPrompt()` still appends the append-prompt section, a
 * `<project_context>` block built from context files such as AGENTS.md, and the
 * skills catalogue whenever the `read` tool is enabled (CLAUDE.md gotcha #2).
 * Returning empty from every accessor is the only way to guarantee that nothing
 * from the developer's machine reaches the model, which is what makes stage
 * output reproducible across machines.
 */
export function staticResourceLoader(systemPrompt: string): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPrompt,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * Build the resource loader for one stage.
 *
 * The common case — `prompt_mode: replace` with `inherit_resources: false` —
 * uses the static loader above and touches no files at all. The other cases go
 * through `DefaultResourceLoader`, which needs `cwd` and `agentDir` (both
 * required, despite what the SDK docs show) and must be `reload()`ed before use.
 */
export async function createStageResourceLoader(
	options: StageResourceLoaderOptions,
): Promise<ResourceLoader> {
	const { cwd, agentDir, systemPrompt, promptMode, inheritResources } = options;

	if (promptMode === "replace" && !inheritResources) {
		return staticResourceLoader(systemPrompt);
	}

	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		...(inheritResources
			? {}
			: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				}),
		...(promptMode === "replace"
			? {
					systemPromptOverride: () => systemPrompt,
					appendSystemPromptOverride: () => [],
				}
			: {
					// `append` keeps pi's base coding prompt and adds the role on top,
					// mirroring what pi's own subagent extension does with
					// --append-system-prompt.
					appendSystemPromptOverride: (base: string[]) =>
						inheritResources ? [...base, systemPrompt] : [systemPrompt],
				}),
	});

	await loader.reload();
	return loader;
}
