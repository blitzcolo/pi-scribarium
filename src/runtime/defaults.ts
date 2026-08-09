import { SettingsManager } from "@earendil-works/pi-coding-agent";

import { THINKING_LEVELS, type ThinkingLevelName } from "../agents/types.js";

export interface RunDefaults {
	/** `provider/model` reference, when pi has a configured default. */
	modelRef?: string;
	thinking?: ThinkingLevelName;
}

/**
 * Read the model defaults the user has configured for pi itself.
 *
 * Stages run with an in-memory `SettingsManager` so a run never reads or writes
 * the developer's own settings file. That isolation means the session cannot
 * pick up `defaultModel` on its own, and an agent without a pinned `model:`
 * would silently fall back to whichever model is listed first. Reading the
 * defaults here and passing them in explicitly keeps the isolation while still
 * honouring the user's configuration.
 */
export function readRunDefaults(cwd: string, agentDir: string): RunDefaults {
	let settings: SettingsManager;
	try {
		settings = SettingsManager.create(cwd, agentDir);
	} catch {
		return {};
	}

	const provider = settings.getDefaultProvider();
	const model = settings.getDefaultModel();
	const thinking = settings.getDefaultThinkingLevel();

	return {
		...(provider !== undefined && model !== undefined
			? { modelRef: `${provider}/${model}` }
			: model !== undefined
				? { modelRef: model }
				: {}),
		...(thinking !== undefined && (THINKING_LEVELS as readonly string[]).includes(thinking)
			? { thinking: thinking as ThinkingLevelName }
			: {}),
	};
}
