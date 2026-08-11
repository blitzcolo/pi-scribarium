import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { isCustomTool, type CustomToolName } from "../agents/types.js";
import type { Fetcher } from "../search/http.js";
import { createSearchPapersTool } from "./tools/search-papers.js";

/**
 * Build the custom tools a stage was granted.
 *
 * Granting one takes three agreeing pieces, and the split is deliberate: the
 * name has to be in `CUSTOM_TOOLS` for an agent file to mention it at all, in
 * the agent's own `tools:` list (which the SDK treats as a strict allowlist), and
 * constructed here. Miss the last and the model is told about a tool that will
 * never run; miss the middle and the tool is built but filtered out.
 */

export interface CustomToolContext {
	/** Injected so tests serve fixtures rather than reaching the open internet. */
	fetcher?: Fetcher;
}

export function buildCustomTools(
	granted: readonly string[],
	context: CustomToolContext = {},
): ToolDefinition[] {
	const tools: ToolDefinition[] = [];

	for (const name of granted) {
		if (!isCustomTool(name)) continue;
		tools.push(build(name, context));
	}
	return tools;
}

function build(name: CustomToolName, context: CustomToolContext): ToolDefinition {
	switch (name) {
		case "search_papers":
			return createSearchPapersTool({
				...(context.fetcher !== undefined ? { fetcher: context.fetcher } : {}),
			});
	}
}
