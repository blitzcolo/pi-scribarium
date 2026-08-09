import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_TOOLS, type AgentDefinition, type ThinkingLevelName } from "../agents/types.js";
import { resolveStageModel } from "./model.js";
import { createStageResourceLoader } from "./resource-loader.js";
import { truncateOutput } from "./truncate.js";
import { TurnBudget } from "./turn-budget.js";

/** Default cap on returned stage text. Matches pi's own subagent example. */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 50 * 1024;

export type StageStatus = "completed" | "failed" | "aborted";

export type StageErrorCode =
	| "TURN_BUDGET_EXCEEDED"
	| "TIMEOUT"
	| "EXTERNAL_ABORT"
	| "AGENT_ERROR";

export interface StageUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
}

export type StageEvent =
	| { type: "turn"; turns: number; maxTurns: number }
	| { type: "tool"; tool: string }
	| { type: "compaction" }
	| { type: "retry"; attempt: number }
	| { type: "steer" }
	| { type: "warn"; message: string }
	| { type: "text"; delta: string };

export interface RunStageOptions {
	agent: AgentDefinition;
	/** The task message sent to the agent. */
	prompt: string;
	/** Working directory for the session; relative tool paths resolve here. */
	cwd: string;
	/** pi's global config dir. Defaults to the SDK's `getAgentDir()`. */
	agentDir: string;
	modelRuntime: ModelRuntime;
	/** When set, the session transcript is persisted here as JSONL. */
	sessionDir?: string;
	outputLimitBytes?: number;
	/** Cancels the stage; surfaces as an `aborted` result. */
	signal?: AbortSignal;
	onEvent?: (event: StageEvent) => void;
}

export interface RunStageResult {
	status: StageStatus;
	/** Final assistant text, truncated to the output limit. Advisory only — the
	 * authoritative contract is the agent's declared `outputs`. */
	text: string;
	truncated: boolean;
	turns: number;
	softWarned: boolean;
	retries: number;
	compactions: number;
	usage: StageUsage;
	/** Context window pressure at the end of the run, if known. */
	contextPercent: number | null;
	sessionId: string;
	sessionFile?: string;
	durationMs: number;
	error?: { code: StageErrorCode; message: string };
}

/**
 * Run one agent to completion in an isolated session.
 *
 * Failures are returned, not thrown, so that a single bad item in a fan-out
 * cannot abort its siblings. Only configuration errors — an unresolvable model
 * reference — propagate, and preflight is expected to have caught those first.
 */
export async function runStage(options: RunStageOptions): Promise<RunStageResult> {
	const startedAt = Date.now();
	const { agent, modelRuntime, onEvent } = options;

	const resolved = agent.modelRef !== undefined
		? resolveStageModel(modelRuntime, agent.modelRef)
		: undefined;
	if (resolved?.warning !== undefined) {
		onEvent?.({ type: "warn", message: resolved.warning });
	}

	const thinkingLevel: ThinkingLevelName | undefined = agent.thinking ?? resolved?.thinkingLevel;

	const resourceLoader = await createStageResourceLoader({
		cwd: options.cwd,
		agentDir: options.agentDir,
		systemPrompt: agent.systemPrompt,
		promptMode: agent.promptMode,
		inheritResources: agent.inheritResources,
	});

	// An in-memory settings manager keeps the run from reading or writing the
	// developer's own ~/.pi/agent/settings.json.
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: agent.compaction },
		retry: { enabled: true, maxRetries: 2 },
		images: { blockImages: true },
		quietStartup: true,
	});

	const sessionManager =
		options.sessionDir !== undefined
			? SessionManager.create(options.cwd, options.sessionDir)
			: SessionManager.inMemory(options.cwd);

	const { session, modelFallbackMessage } = await createAgentSession({
		cwd: options.cwd,
		agentDir: options.agentDir,
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager,
		// `tools` is a strict allowlist; [] is honoured as "no tools".
		tools: [...(agent.tools ?? DEFAULT_TOOLS)],
		...(resolved !== undefined ? { model: resolved.model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	});
	if (modelFallbackMessage !== undefined) {
		onEvent?.({ type: "warn", message: modelFallbackMessage });
	}

	const budget = new TurnBudget(agent.maxTurns, agent.softTurnRatio);
	let retries = 0;
	let compactions = 0;
	let timedOut = false;
	let externallyAborted = false;
	let cancelled = false;

	/** Abort at most once, from whichever source fires first. */
	const cancel = (): void => {
		if (cancelled) return;
		cancelled = true;
		// Never await abort() inside a listener: it resolves only once the agent
		// is idle, which cannot happen while we are still handling its event.
		void session.abort().catch(() => {});
	};

	const unsubscribe = session.subscribe((event) => {
		switch (event.type) {
			case "turn_end": {
				const action = budget.onTurnEnd();
				onEvent?.({ type: "turn", turns: budget.turns, maxTurns: budget.maxTurns });
				if (action === "steer") {
					onEvent?.({ type: "steer" });
					void session.steer(budget.steerMessage()).catch(() => {});
				} else if (action === "abort") {
					cancel();
				}
				break;
			}
			case "message_update":
				if (event.assistantMessageEvent.type === "text_delta") {
					onEvent?.({ type: "text", delta: event.assistantMessageEvent.delta });
				}
				break;
			case "tool_execution_start":
				onEvent?.({ type: "tool", tool: event.toolName });
				break;
			case "compaction_start":
				compactions++;
				onEvent?.({ type: "compaction" });
				break;
			case "auto_retry_start":
				retries++;
				onEvent?.({ type: "retry", attempt: event.attempt });
				break;
			default:
				break;
		}
	});

	const onExternalAbort = (): void => {
		externallyAborted = true;
		cancel();
	};
	options.signal?.addEventListener("abort", onExternalAbort, { once: true });

	const timer =
		agent.timeoutMs !== undefined
			? setTimeout(() => {
					timedOut = true;
					cancel();
				}, agent.timeoutMs)
			: undefined;
	timer?.unref?.();

	let thrown: string | undefined;
	try {
		// Resolves only after the whole accepted run settles, including retries.
		await session.prompt(options.prompt);
	} catch (error) {
		thrown = error instanceof Error ? error.message : String(error);
	} finally {
		await session.waitForIdle().catch(() => {});
	}

	// Everything must be read before dispose().
	const stateError = session.state.errorMessage;
	const stats = session.getSessionStats();
	const contextUsage = session.getContextUsage();
	const rawText = session.getLastAssistantText() ?? "";
	const sessionFile = session.sessionFile;

	unsubscribe();
	options.signal?.removeEventListener("abort", onExternalAbort);
	if (timer !== undefined) clearTimeout(timer);
	await settingsManager.flush().catch(() => {});
	session.dispose();

	const { text, truncated } = truncateOutput(
		rawText,
		options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
	);

	return {
		...classify({ budget, timedOut, externallyAborted, stateError, thrown }),
		text,
		truncated,
		turns: budget.turns,
		softWarned: budget.softWarned,
		retries,
		compactions,
		usage: {
			input: stats.tokens.input,
			output: stats.tokens.output,
			cacheRead: stats.tokens.cacheRead,
			cacheWrite: stats.tokens.cacheWrite,
			total: stats.tokens.total,
			cost: stats.cost,
		},
		contextPercent: contextUsage?.percent ?? null,
		sessionId: stats.sessionId,
		durationMs: Date.now() - startedAt,
		...(sessionFile !== undefined ? { sessionFile } : {}),
	};
}

/**
 * Decide the outcome.
 *
 * Order matters. `session.abort()` sets `state.errorMessage`, so checking the
 * error first would relabel every budget-exceeded or timed-out stage as a
 * generic agent error (CLAUDE.md gotcha #3). And because a mid-run provider
 * failure never rejects `prompt()`, `state.errorMessage` is the only signal
 * that distinguishes a broken run from a healthy one (gotcha #1).
 */
function classify(input: {
	budget: TurnBudget;
	timedOut: boolean;
	externallyAborted: boolean;
	stateError: string | undefined;
	thrown: string | undefined;
}): { status: StageStatus; error?: { code: StageErrorCode; message: string } } {
	const { budget, timedOut, externallyAborted, stateError, thrown } = input;

	if (budget.exceeded) {
		return {
			status: "failed",
			error: {
				code: "TURN_BUDGET_EXCEEDED",
				message:
					`exceeded the ${budget.maxTurns}-turn budget` +
					(budget.softWarned ? ` (warned at turn ${budget.softLimit})` : ""),
			},
		};
	}
	if (timedOut) {
		return { status: "failed", error: { code: "TIMEOUT", message: "stage timed out" } };
	}
	if (externallyAborted) {
		return { status: "aborted", error: { code: "EXTERNAL_ABORT", message: "cancelled" } };
	}
	const message = stateError ?? thrown;
	if (message !== undefined) {
		return { status: "failed", error: { code: "AGENT_ERROR", message } };
	}
	return { status: "completed" };
}
