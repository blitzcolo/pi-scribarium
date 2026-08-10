import {
	createAgentSession,
	SessionManager,
	SettingsManager,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

import { DEFAULT_TOOLS, type AgentDefinition, type ThinkingLevelName } from "../agents/types.js";
import { resolveStageModel } from "./model.js";
import { createStageResourceLoader } from "./resource-loader.js";
import { enterChildDepth } from "../util/safety.js";
import { truncateOutput } from "./truncate.js";
import { TurnBudget } from "./turn-budget.js";

/** Default cap on returned stage text. Matches pi's own subagent example. */
export const DEFAULT_OUTPUT_LIMIT_BYTES = 50 * 1024;

/**
 * Retry policy, tuned for sustained rate limiting rather than a dropped packet.
 *
 * A fan-out over a large corpus can hold a provider near its per-minute token
 * limit for the length of the run, so 429s arrive in stretches, not as isolated
 * blips. The default policy — 3 attempts, 2s and 4s apart — gives up six seconds
 * into a limit that resets on a sixty-second window, and a fan-out failure is
 * not loud: the item is recorded as failed, the run continues, and the reducer
 * downstream silently synthesises from fewer inputs. Waiting is the better
 * failure mode.
 *
 * Two independent layers, and the distinction matters:
 *
 * - `provider` is the HTTP client's own retry, around a single request. Its
 *   backoff is **capped** (`maxRetryDelayMs`), so this is the right layer to
 *   absorb rate limiting: the wait tracks the provider's window instead of
 *   doubling past it.
 * - `maxRetries`/`baseDelayMs` retry the whole agent turn after the stream has
 *   already failed. This backoff is **not capped** — `agent-session.js` computes
 *   `baseDelayMs * 2 ** (attempt - 1)` with no clamp — so the base has to stay
 *   small or the tail becomes absurd. At 1s the ten waits run 1s…512s, roughly
 *   17 minutes in total before an item is finally abandoned. That is deliberate:
 *   by the time this layer is reached the capped HTTP retries have already been
 *   exhausted, which means the throttling is real and lasting.
 *
 * The sleep is abortable, so Ctrl-C and a step `timeoutMs` both still cut it
 * short. Retries are counted per stage and surfaced in the run report, because
 * transparent retrying otherwise makes a 429 storm look like plain slowness.
 */
export const RETRY_SETTINGS = {
	enabled: true,
	maxRetries: 10,
	baseDelayMs: 1_000,
	provider: { maxRetries: 8, maxRetryDelayMs: 60_000 },
} as const;

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
	/**
	 * Model used when the agent does not pin one. Shipped agents deliberately
	 * leave `model:` unset so the package is portable, so without this they would
	 * fall back to whichever model happens to be listed first.
	 */
	defaultModelRef?: string;
	/** Thinking level used when neither the agent nor the model reference sets one. */
	defaultThinking?: ThinkingLevelName;
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

	// A signal that has already fired never dispatches `abort` again, so the
	// listener registered below would never run: the stage would build a session
	// and bill a full run for work the user has already cancelled. Refuse before
	// anything is created. This is the common case in a fan-out, where the pool
	// hands every queued item the same run-wide signal.
	if (options.signal?.aborted === true) {
		return {
			status: "aborted",
			error: { code: "EXTERNAL_ABORT", message: "cancelled before the stage started" },
			text: "",
			truncated: false,
			turns: 0,
			softWarned: false,
			retries: 0,
			compactions: 0,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
			contextPercent: null,
			sessionId: "",
			durationMs: Date.now() - startedAt,
		};
	}

	const modelRef = agent.modelRef ?? options.defaultModelRef;
	const resolved = modelRef !== undefined ? resolveStageModel(modelRuntime, modelRef) : undefined;
	if (resolved?.warning !== undefined) {
		onEvent?.({ type: "warn", message: resolved.warning });
	}

	// Precedence: the agent's own setting, then a `:level` suffix on the model
	// reference, then the run-wide default.
	const thinkingLevel: ThinkingLevelName | undefined =
		agent.thinking ?? resolved?.thinkingLevel ?? options.defaultThinking;

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
		retry: RETRY_SETTINGS,
		images: { blockImages: true },
		quietStartup: true,
	});

	// `tools` is a strict allowlist; [] is honoured as "no tools".
	const tools = [...(agent.tools ?? DEFAULT_TOOLS)];

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
		tools,
		...(resolved !== undefined ? { model: resolved.model } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
	});
	if (modelFallbackMessage !== undefined) {
		onEvent?.({ type: "warn", message: modelFallbackMessage });
	}

	// pi's `bash` tool inherits this process's environment, so an agent that can
	// shell out is exactly the case the recursion guard was written for: without
	// the increment a nested `scribarium` starts again at depth 0 and the guard
	// never fires. Released in the finally below, after the session is disposed.
	const releaseDepth = tools.includes("bash") ? enterChildDepth() : undefined;

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
					// A cancel already under way owns the outcome. abort() is
					// cooperative, so the settle can outlast the deadline, and a timer
					// firing during that drain would relabel a user's Ctrl-C as a
					// timeout — which `classify` ranks higher, turning exit 130 into 1.
					if (cancelled) return;
					timedOut = true;
					cancel();
				}, agent.timeoutMs)
			: undefined;
	timer?.unref?.();

	let thrown: string | undefined;
	let stateError: string | undefined;
	let stats: ReturnType<typeof session.getSessionStats> | undefined;
	let contextUsage: ReturnType<typeof session.getContextUsage>;
	let rawText = "";
	let sessionFile: string | undefined;

	try {
		// Resolves only after the whole accepted run settles, including retries.
		await session.prompt(options.prompt);
	} catch (error) {
		thrown = error instanceof Error ? error.message : String(error);
	} finally {
		// Disarmed before the drain, not after it: waitForIdle() waits out a turn
		// already in flight, and a timer still armed across that window would fire
		// on a stage that has in fact already finished.
		if (timer !== undefined) clearTimeout(timer);
		await session.waitForIdle().catch(() => {});

		// All of this belongs in the finally, not after it. A throw while reading
		// stats off an aborted session would otherwise skip the teardown *and*
		// propagate — breaking this function's "failures are returned, not thrown"
		// contract, and leaving an abort listener on the run-wide signal plus a
		// live session behind for every occurrence. At a fan-out's scale that is
		// MaxListenersExceededWarning and thirty leaked sessions.
		try {
			// Everything must be read before dispose().
			stateError = session.state.errorMessage;
			stats = session.getSessionStats();
			contextUsage = session.getContextUsage();
			rawText = session.getLastAssistantText() ?? "";
			sessionFile = session.sessionFile;
		} catch (error) {
			thrown ??= error instanceof Error ? error.message : String(error);
		}

		unsubscribe();
		options.signal?.removeEventListener("abort", onExternalAbort);
		await settingsManager.flush().catch(() => {});
		try {
			session.dispose();
		} catch {
			// Nothing left to salvage; the result is already assembled.
		}
		releaseDepth?.();
	}

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
			input: stats?.tokens.input ?? 0,
			output: stats?.tokens.output ?? 0,
			cacheRead: stats?.tokens.cacheRead ?? 0,
			cacheWrite: stats?.tokens.cacheWrite ?? 0,
			total: stats?.tokens.total ?? 0,
			cost: stats?.cost ?? 0,
		},
		contextPercent: contextUsage?.percent ?? null,
		sessionId: stats?.sessionId ?? "",
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
