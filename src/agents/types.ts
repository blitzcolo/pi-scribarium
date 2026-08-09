/**
 * Agent definition model.
 *
 * The on-disk format is a strict superset of pi's own subagent format
 * (`examples/extensions/subagent/agents/*.md`), which reads only `name`,
 * `description`, `tools`, and `model` and ignores everything else. That means:
 *
 *   - a file written for pi's subagent extension loads here unchanged;
 *   - a file written here drops into `~/.pi/agent/agents/` and still works as a
 *     pi subagent, losing only our extra semantics.
 *
 * Keeping that property is a deliberate design goal; do not add a *required*
 * field that pi's loader would not understand.
 */

/**
 * Mirrors `ThinkingLevel` from `@earendil-works/pi-agent-core`, which is not
 * re-exported by `pi-coding-agent` and is not resolvable from our project root
 * (the SDK's shrinkwrap nests it). Declared locally so it stays structurally
 * assignable to `createAgentSession`'s `thinkingLevel` option.
 * See CLAUDE.md gotcha #6.
 */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevelName = (typeof THINKING_LEVELS)[number];

/**
 * pi's built-in tool names. When `tools` is provided to `createAgentSession` it
 * is a *strict* allowlist, and unknown names are silently ignored — which would
 * yield a quietly tool-less agent — so we reject unknown names at load time.
 */
export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];

/** Tools granted when an agent does not declare any. Deliberately read-only. */
export const DEFAULT_TOOLS: readonly BuiltinToolName[] = ["read", "grep", "find", "ls"];

/**
 * `replace` swaps out pi's coding system prompt entirely (deterministic, the
 * default). `append` keeps pi's base prompt and appends the body — this is what
 * pi's own subagent extension does via `--append-system-prompt`, so it is the
 * compatibility mode for imported pi agents.
 */
export type PromptMode = "replace" | "append";

/** Where a definition was discovered. Later sources win on name collision. */
export type AgentSource = "shipped" | "user" | "project" | "workspace";

/** Raw frontmatter as authored. Every field except name/description is optional. */
export interface AgentFrontmatter {
	/** Required by pi's loader; files missing it are skipped there. */
	name?: unknown;
	/** Required by pi's loader; files missing it are skipped there. */
	description?: unknown;
	/** `provider/model[:thinking]`, resolved later via `resolveCliModel`. */
	model?: unknown;
	/** Comma-separated string (pi's form) or a YAML list. */
	tools?: unknown;
	thinking?: unknown;
	prompt_mode?: unknown;
	max_turns?: unknown;
	soft_turn_ratio?: unknown;
	timeout_ms?: unknown;
	output?: unknown;
	compaction?: unknown;
	inherit_resources?: unknown;
	/**
	 * Unknown keys are preserved rather than rejected: pi's own loader ignores
	 * fields it does not recognise, and `parseFrontmatter<T>` constrains
	 * `T extends Record<string, unknown>`. The SDK's `SkillFrontmatter` is
	 * declared the same way.
	 */
	[key: string]: unknown;
}

/** A validated, normalized agent definition. */
export interface AgentDefinition {
	name: string;
	description: string;
	/** Unresolved model reference, e.g. `anthropic/claude-opus-4-5:high`. */
	modelRef?: string;
	/** Normalized tool allowlist. `undefined` means "use DEFAULT_TOOLS". */
	tools?: readonly string[];
	thinking?: ThinkingLevelName;
	promptMode: PromptMode;
	/** Userland turn budget — the SDK has no such concept (CLAUDE.md gotcha #4). */
	maxTurns: number;
	/** Fraction of `maxTurns` at which the agent is steered to wrap up. */
	softTurnRatio: number;
	timeoutMs?: number;
	/** Declared artifact paths; may contain `${item.*}` templates. */
	outputs: readonly string[];
	compaction: boolean;
	/** When true, the role inherits the machine's skills/context files. */
	inheritResources: boolean;
	/** The frontmatter body, used as the system prompt. */
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export const AGENT_DEFAULTS = {
	promptMode: "replace",
	maxTurns: 40,
	softTurnRatio: 0.8,
	compaction: true,
	inheritResources: false,
} as const satisfies Partial<AgentDefinition>;
