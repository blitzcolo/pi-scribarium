/**
 * Public library surface for pi-scribarium.
 *
 * The CLI in `src/cli/` is the primary entry point; this barrel exists so the
 * orchestrator can also be embedded programmatically.
 */

export { discoverAgents, findProjectAgentsDir, shippedAgentsDir } from "./agents/discover.js";
export type { Diagnostic, DiscoverOptions, DiscoverResult } from "./agents/discover.js";
export { normalizeTools, parseAgentFile } from "./agents/parse.js";
export { AgentRegistry } from "./agents/registry.js";
export {
	AGENT_DEFAULTS,
	BUILTIN_TOOLS,
	DEFAULT_TOOLS,
	THINKING_LEVELS,
} from "./agents/types.js";
export type {
	AgentDefinition,
	AgentFrontmatter,
	AgentSource,
	BuiltinToolName,
	PromptMode,
	ThinkingLevelName,
} from "./agents/types.js";
export {
	AgentDefinitionError,
	PreflightError,
	ScribariumError,
	StageConfigError,
	UnknownAgentError,
} from "./util/errors.js";
export { VERSION } from "./version.js";
