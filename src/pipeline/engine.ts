import * as fs from "node:fs";
import * as path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../agents/registry.js";
import type { ThinkingLevelName } from "../agents/types.js";
import { runStage, type RunStageResult, type StageEvent } from "../runtime/run-stage.js";
import type { RunLayout } from "../workspace/layout.js";
import {
	addUsage,
	emptyUsage,
	EventLog,
	RunStateStore,
	type RunState,
	type StepState,
} from "../workspace/run-state.js";
import { archiveAttempt, buildRegeneratePrompt } from "../gates/regenerate.js";
import type { GateHandler } from "../gates/types.js";
import { redactSecrets } from "../util/safety.js";
import { runBuiltin } from "./builtins.js";
import { resolveItems } from "./items.js";
import { mapPool } from "./pool.js";
import { interpolate, type TemplateScope } from "./template.js";
import type {
	AgentStepSpec,
	ForeachItem,
	ForeachStepSpec,
	GateStepSpec,
	PipelineSpec,
	StepSpec,
} from "./schema.js";

export interface RunPipelineOptions {
	spec: PipelineSpec;
	layout: RunLayout;
	state: RunState;
	registry: AgentRegistry;
	modelRuntime: ModelRuntime;
	agentDir: string;
	defaultModelRef?: string;
	defaultThinking?: ThinkingLevelName;
	/** Decides what happens at a gate. Defaults to auto-approve. */
	gate?: GateHandler;
	signal?: AbortSignal;
	onEvent?: (event: PipelineEvent) => void;
}

export type PipelineEvent =
	| { type: "step_start"; stepId: string; index: number; total: number; kind: string }
	| { type: "step_end"; stepId: string; status: StepState["status"]; error?: string }
	| { type: "log"; message: string }
	| { type: "fanout_start"; stepId: string; total: number; concurrency: number }
	| {
			type: "fanout_progress";
			stepId: string;
			itemId: string;
			completed: number;
			failed: number;
			total: number;
			error?: string;
	  }
	| { type: "stage"; stepId: string; itemId?: string; event: StageEvent }
	| { type: "gate_awaiting"; stepId: string; title: string }
	| { type: "gate_decided"; stepId: string; decision: string; target?: string };

/**
 * Execute a pipeline in order.
 *
 * Every step boundary is checkpointed, so a run killed at any point can be
 * resumed from the last completed step rather than restarted. A failed step
 * stops the run: with stages feeding each other through files, continuing past
 * a failure would build on missing or half-written input.
 */
export async function runPipeline(options: RunPipelineOptions): Promise<RunState> {
	const { spec, layout, registry, modelRuntime, onEvent } = options;
	const store = new RunStateStore(layout);
	const log = new EventLog(layout.eventsFile);
	const state = options.state;

	log.append("run_start", { pipeline: spec.name, steps: spec.steps.length });

	// Index-driven rather than a for..of: a rejected gate rewinds to an earlier
	// step, which a simple iteration cannot express.
	let index = 0;
	while (index < spec.steps.length) {
		const step = spec.steps[index] as StepSpec;
		const existing = state.steps[step.id];
		if (existing?.status === "completed" || existing?.status === "skipped") {
			// Resume: this step already finished in an earlier attempt.
			onEvent?.({ type: "log", message: `skipping ${existing.status} step ${step.id}` });
			index++;
			continue;
		}

		if (step.kind === "gate") {
			const outcome = await executeGate(step, options, state, store, log);
			if (outcome.kind === "defer") {
				state.status = "awaiting_gate";
				state.cursor = { stepIndex: index, stepId: step.id };
				store.save(state);
				log.append("run_end", { status: "awaiting_gate", stepId: step.id });
				return state;
			}
			if (outcome.kind === "abort") {
				state.status = "aborted";
				store.save(state);
				log.append("run_end", { status: "aborted", stepId: step.id });
				return state;
			}
			if (outcome.kind === "rewind") {
				index = spec.steps.findIndex((candidate) => candidate.id === outcome.target);
				continue;
			}
			index++;
			continue;
		}

		state.cursor = { stepIndex: index, stepId: step.id };
		state.status = "running";
		const stepState: StepState = {
			type: step.kind,
			status: "running",
			attempts: (existing?.attempts ?? 0) + 1,
			startedAt: new Date().toISOString(),
			outputs: [],
			// Carried across attempts: a rejection stores feedback on this step and
			// the retry must still see it, and the decision history is the audit
			// trail for why the step ran more than once.
			...(existing?.pendingFeedback !== undefined
				? { pendingFeedback: existing.pendingFeedback }
				: {}),
			...(existing?.decisions !== undefined ? { decisions: existing.decisions } : {}),
			// Item results survive a retry so a resumed fan-out can skip what it
			// already finished; without this a killed thirty-paper run would pay
			// for all thirty again.
			...(existing?.items !== undefined ? { items: existing.items } : {}),
		};
		state.steps[step.id] = stepState;
		store.save(state);
		log.append("step_start", { stepId: step.id, kind: step.kind, attempt: stepState.attempts });
		onEvent?.({ type: "step_start", stepId: step.id, index, total: spec.steps.length, kind: step.kind });

		try {
			if (step.kind === "builtin") {
				await executeBuiltin(step, stepState, options);
			} else if (step.kind === "foreach") {
				await executeForeach(step, stepState, options, state, store);
			} else {
				await executeAgent(step, stepState, options, state);
			}
		} catch (error) {
			stepState.status = "failed";
			stepState.error = {
				code: "BUILTIN_ERROR",
				message: error instanceof Error ? error.message : String(error),
			};
		}

		stepState.endedAt = new Date().toISOString();
		if (stepState.usage !== undefined) {
			state.usageTotal = addUsage(state.usageTotal, stepState.usage);
		}
		store.save(state);
		log.append("step_end", {
			stepId: step.id,
			status: stepState.status,
			...(stepState.error !== undefined ? { error: stepState.error } : {}),
		});
		onEvent?.({
			type: "step_end",
			stepId: step.id,
			status: stepState.status,
			...(stepState.error !== undefined ? { error: stepState.error.message } : {}),
		});

		// "skipped" is a deliberate outcome, not a failure: an optional fan-out
		// over an empty directory did the only correct thing available to it.
		if (stepState.status !== "completed" && stepState.status !== "skipped") {
			state.status = stepState.error?.code === "EXTERNAL_ABORT" ? "aborted" : "failed";
			store.save(state);
			log.append("run_end", { status: state.status });
			return state;
		}
		index++;
	}

	state.status = "completed";
	state.cursor = { stepIndex: spec.steps.length };
	store.save(state);
	log.append("run_end", { status: state.status, usage: state.usageTotal });
	return state;
}

type GateOutcome =
	| { kind: "proceed" }
	| { kind: "defer" }
	| { kind: "abort" }
	| { kind: "rewind"; target: string };

/**
 * Ask for a human decision.
 *
 * A rejection rewinds to `on_reject` and stores the feedback on that step, so
 * the next execution folds it into the prompt. The gate itself is then reset to
 * pending: after regenerating, the reviewer should be asked again rather than
 * the run sailing past an approval that was never given.
 */
async function executeGate(
	step: GateStepSpec,
	options: RunPipelineOptions,
	state: RunState,
	store: RunStateStore,
	log: EventLog,
): Promise<GateOutcome> {
	const { layout, onEvent } = options;
	const handler = options.gate ?? (async () => ({ kind: "approve" as const }));

	const artifacts = step.show.map((relative) => {
		const absolutePath = layout.artifact(relative);
		let bytes = 0;
		let exists = false;
		try {
			bytes = fs.statSync(absolutePath).size;
			exists = true;
		} catch {
			// Reported as missing rather than hidden: reviewing an artifact that
			// was never written is exactly the case worth surfacing.
		}
		return { path: relative, absolutePath, bytes, exists };
	});

	const stepState: StepState = state.steps[step.id] ?? {
		type: "gate",
		status: "awaiting",
		attempts: 0,
		outputs: [],
	};
	stepState.type = "gate";
	stepState.status = "awaiting";
	state.steps[step.id] = stepState;
	store.save(state);

	onEvent?.({ type: "gate_awaiting", stepId: step.id, title: step.title });
	log.append("gate_awaiting", { stepId: step.id });

	const decision = await handler({
		step,
		runId: layout.runId,
		workspace: layout.workspace,
		artifacts,
		usageSoFar: state.usageTotal,
	});

	if (decision === "defer") return { kind: "defer" };

	(stepState.decisions ??= []).push({
		at: new Date().toISOString(),
		kind: decision.kind,
		...(decision.kind === "reject" ? { feedback: decision.feedback } : {}),
		...(decision.kind === "reject" && decision.target !== undefined
			? { target: decision.target }
			: {}),
	});
	stepState.attempts++;
	onEvent?.({ type: "gate_decided", stepId: step.id, decision: decision.kind });
	log.append("gate_decided", { stepId: step.id, decision: decision.kind });

	switch (decision.kind) {
		case "approve":
			stepState.status = "completed";
			store.save(state);
			return { kind: "proceed" };

		case "skip":
			stepState.status = "skipped";
			store.save(state);
			return { kind: "proceed" };

		case "abort":
			stepState.status = "failed";
			stepState.error = { code: "EXTERNAL_ABORT", message: "reviewer aborted the run" };
			store.save(state);
			return { kind: "abort" };

		case "reject": {
			const target = decision.target ?? step.onReject;
			if (target === undefined || state.steps[target] === undefined) {
				stepState.status = "failed";
				stepState.error = {
					code: "BUILTIN_ERROR",
					message:
						`rejected, but there is nothing to regenerate: ` +
						`gate "${step.id}" has no on_reject target`,
				};
				store.save(state);
				return { kind: "abort" };
			}

			const targetState = state.steps[target] as StepState;
			targetState.pendingFeedback = decision.feedback;
			// Re-open both the target and this gate so the loop runs them again.
			targetState.status = "pending";
			stepState.status = "awaiting";
			store.save(state);
			onEvent?.({ type: "gate_decided", stepId: step.id, decision: "reject", target });
			return { kind: "rewind", target };
		}
	}
}

async function executeBuiltin(
	step: Extract<StepSpec, { kind: "builtin" }>,
	stepState: StepState,
	options: RunPipelineOptions,
): Promise<void> {
	const result = await runBuiltin(step, {
		workspace: options.layout.workspace,
		resolveOutput: (relative) => options.layout.artifact(relative),
		onProgress: (message) => options.onEvent?.({ type: "log", message }),
	});

	if (!result.ok) {
		stepState.status = "failed";
		stepState.error = { code: "BUILTIN_ERROR", message: result.error ?? result.summary };
		return;
	}
	stepState.status = "completed";
	options.onEvent?.({ type: "log", message: result.summary });
	// A builtin can succeed and still have something to say — an optional
	// directory that isolated a few unreadable files, say. Dropping it here
	// would make those files disappear from the run entirely.
	if (result.error !== undefined) {
		options.onEvent?.({ type: "log", message: `      warning: ${result.error}` });
	}
}

/** Template scope shared by every stage in a step. */
function baseScope(
	options: RunPipelineOptions,
	state: RunState,
	item?: ForeachItem,
): TemplateScope {
	const { spec, layout } = options;
	return {
		vars: spec.vars,
		workspace: layout.workspace,
		runId: layout.runId,
		steps: Object.fromEntries(
			Object.entries(state.steps).map(([id, value]) => [id, { outputs: value.outputs }]),
		),
		...(item !== undefined ? { item } : {}),
	};
}

/**
 * Run one agent stage and record it. Shared by plain agent steps and by each
 * item of a fan-out, so both get the same output contract and failure handling.
 */
/**
 * The outputs of an item that does not need re-running, or null.
 *
 * A per-paper summary is a property of the paper, not of the run that produced
 * it: re-analysing an unchanged file buys an identical artifact at full price.
 * At a few dozen items that is an annoyance; at several hundred it is the
 * difference between a cache miss costing minutes and costing the whole run.
 *
 * The test is the one `ingest` already uses — every declared output exists and
 * is at least as new as the source. Deliberately mtime rather than a content
 * hash: `touch` is then the documented way to force a rebuild, and a corpus
 * lives on a filesystem, not in a build system.
 */
function cachedOutputs(
	step: ForeachStepSpec,
	item: ForeachItem,
	options: RunPipelineOptions,
	state: RunState,
): string[] | null {
	if (step.cache !== true || item.path === undefined) return null;

	// Feedback means a human asked for this step to be done again. Honouring a
	// cache then would silently discard their words.
	if (state.steps[step.id]?.pendingFeedback !== undefined) return null;

	const { layout } = options;
	let sourceMtime: number;
	try {
		sourceMtime = fs.statSync(path.resolve(layout.workspace, item.path)).mtimeMs;
	} catch {
		return null;
	}

	const scope = baseScope(options, state, item);
	const outputs = step.outputs.map((template) => interpolate(template, scope));
	for (const output of outputs) {
		try {
			if (fs.statSync(layout.artifact(output)).mtimeMs < sourceMtime) return null;
		} catch {
			return null;
		}
	}
	return outputs;
}

async function runOneStage(
	step: AgentStepSpec | ForeachStepSpec,
	options: RunPipelineOptions,
	state: RunState,
	item?: ForeachItem,
): Promise<{ outputs: string[]; result: RunStageResult; error?: StepState["error"] }> {
	const { layout, registry, modelRuntime } = options;
	const agent = registry.get(step.agent);
	const scope = baseScope(options, state, item);

	const outputs = step.outputs.map((template) => interpolate(template, scope));
	const scopeWithOutputs: TemplateScope = {
		...scope,
		...(outputs.length > 0 ? { output: outputs.join(", ") } : {}),
	};
	const task = buildTask(step, outputs, scopeWithOutputs);

	const previous = state.steps[step.id];
	const feedback = item === undefined ? previous?.pendingFeedback : undefined;
	const finalTask =
		feedback === undefined
			? task
			: buildRegeneratePrompt(
					task,
					archiveAttempt(layout, step.id, outputs, Math.max(1, (previous?.attempts ?? 1) - 1)),
					feedback,
				);

	const logFile = layout.logFile(step.id, item?.id);
	fs.writeFileSync(
		logFile,
		redactSecrets(
			`# ${step.id}${item === undefined ? "" : ` / ${item.id}`}\n\n## Prompt\n\n${finalTask}\n`,
		),
		"utf-8",
	);

	// Stages run with the workspace as cwd so a prompt can name corpus/text/x.md
	// and analysis/x.md naturally. Parent directories are created up front: an
	// agent should not have to spend a turn discovering it must mkdir first.
	for (const output of outputs) {
		fs.mkdirSync(path.dirname(layout.artifact(output)), { recursive: true });
	}

	const modelRef = agent.modelRef ?? step.model ?? options.defaultModelRef;
	const result: RunStageResult = await runStage({
		agent: {
			...agent,
			...(step.maxTurns !== undefined ? { maxTurns: step.maxTurns } : {}),
			...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
		},
		prompt: finalTask,
		cwd: layout.workspace,
		agentDir: options.agentDir,
		modelRuntime,
		sessionDir: layout.sessionsDir,
		...(modelRef !== undefined ? { defaultModelRef: modelRef } : {}),
		...(options.defaultThinking !== undefined ? { defaultThinking: options.defaultThinking } : {}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
		onEvent: (event) => options.onEvent?.({ type: "stage", stepId: step.id, event, ...(item !== undefined ? { itemId: item.id } : {}) }),
	});

	fs.appendFileSync(logFile, redactSecrets(`\n## Final text\n\n${result.text}\n`), "utf-8");

	if (result.status !== "completed") {
		return {
			outputs,
			result,
			error: result.error ?? { code: "AGENT_ERROR", message: "stage did not complete" },
		};
	}

	// The declared outputs are the real contract. getLastAssistantText() is
	// advisory — an agent whose last act was a tool call returns empty text, and
	// one that talks about writing a file without writing it must not pass.
	const missing = outputs.filter((output) => !fs.existsSync(layout.artifact(output)));
	if (missing.length > 0) {
		return {
			outputs,
			result,
			error: {
				code: "MISSING_OUTPUT",
				message: `declared output(s) not written: ${missing.join(", ")}`,
			},
		};
	}

	return { outputs, result };
}

async function executeAgent(
	step: AgentStepSpec,
	stepState: StepState,
	options: RunPipelineOptions,
	state: RunState,
): Promise<void> {
	const { outputs, result, error } = await runOneStage(step, options, state);

	stepState.turns = result.turns;
	stepState.usage = result.usage;
	if (result.sessionFile !== undefined) stepState.sessionFile = result.sessionFile;

	if (error !== undefined) {
		stepState.status = "failed";
		stepState.error = error;
		return;
	}
	stepState.outputs = outputs;
	stepState.status = "completed";
	delete stepState.pendingFeedback;
}

/**
 * Fan out one agent over many items.
 *
 * Each item gets its own session, its own artifact path, and its own entry in
 * `status.json` written the moment it settles — a kill loses at most the items
 * still in flight. A failing item is recorded and the rest continue: the whole
 * point of analysing thirty papers concurrently is that one unreadable file
 * must not discard the twenty-nine already paid for.
 */
async function executeForeach(
	step: ForeachStepSpec,
	stepState: StepState,
	options: RunPipelineOptions,
	state: RunState,
	store: RunStateStore,
): Promise<void> {
	const items = resolveItems(step.source, options.layout.workspace);
	const previous = stepState.items ?? {};
	stepState.items = { ...previous };

	if (items.length === 0) {
		if (step.optional === true) {
			stepState.status = "skipped";
			options.onEvent?.({ type: "log", message: `      no items; skipping ${step.id}` });
			return;
		}
		stepState.status = "failed";
		stepState.error = { code: "BUILTIN_ERROR", message: "fan-out matched no items" };
		return;
	}

	options.onEvent?.({
		type: "fanout_start",
		stepId: step.id,
		total: items.length,
		concurrency: Math.min(step.concurrency, items.length),
	});

	// Two reasons to skip an item, and they are worth distinguishing in the log.
	// `carried` is resume: this run already did it. `cached` is cross-run: the
	// output on disk is newer than the source, so re-running would buy an
	// identical file at full price.
	let carried = 0;
	let cached = 0;
	const pending: ForeachItem[] = [];

	for (const item of items) {
		if (previous[item.id]?.status === "completed") {
			carried++;
			continue;
		}
		const fresh = cachedOutputs(step, item, options, state);
		if (fresh !== null) {
			cached++;
			(stepState.items ??= {})[item.id] = { status: "completed", outputs: fresh };
			continue;
		}
		pending.push(item);
	}

	let usage = emptyUsage();
	let turns = 0;
	let completed = carried + cached;
	let failed = 0;

	if (carried > 0) {
		options.onEvent?.({
			type: "log",
			message: `      ${carried} item(s) already complete, skipping`,
		});
	}
	if (cached > 0) {
		options.onEvent?.({
			type: "log",
			message: `      ${cached} item(s) cached (output newer than source), skipping`,
		});
		store.save(state);
	}

	const settled = await mapPool(
		pending,
		step.concurrency,
		async (item) => await runOneStage(step, options, state, item),
		{
			...(step.maxFailures !== undefined ? { maxFailures: step.maxFailures } : {}),
			...(options.signal !== undefined ? { signal: options.signal } : {}),
			onSettled: (index, outcome) => {
				const item = pending[index] as ForeachItem;
				const entry =
					outcome.ok && outcome.value.error === undefined
						? { status: "completed" as const, outputs: outcome.value.outputs }
						: {
								status: "failed" as const,
								error: outcome.ok
									? (outcome.value.error ?? { code: "AGENT_ERROR" as const, message: "failed" })
									: { code: "AGENT_ERROR" as const, message: outcome.error.message },
							};

				if (outcome.ok) {
					usage = addUsage(usage, outcome.value.result.usage);
					turns += outcome.value.result.turns;
				}
				if (entry.status === "completed") completed++;
				else failed++;

				(stepState.items ??= {})[item.id] = entry;
				stepState.usage = usage;
				// Turns are per item; the step reports their sum, not zero.
				stepState.turns = turns;
				// Checkpoint per item so a kill costs at most the in-flight work.
				store.save(state);

				options.onEvent?.({
					type: "fanout_progress",
					stepId: step.id,
					itemId: item.id,
					completed,
					failed,
					total: items.length,
					...(entry.status === "failed" ? { error: entry.error.message } : {}),
				});
			},
		},
	);

	stepState.usage = usage;
	stepState.turns = turns;
	// Outputs span every completed item, carried-over ones included, because the
	// reducer downstream reads the whole set rather than just this attempt's.
	stepState.outputs = Object.values(stepState.items ?? {})
		.filter((entry) => entry.status === "completed")
		.flatMap((entry) => entry.outputs ?? []);

	if (failed === 0) {
		stepState.status = "completed";
		return;
	}

	// A partial fan-out still counts as completed when a failure budget was not
	// exceeded: the reducer downstream is told what is missing and can say so.
	// Only an exhausted budget, or losing everything, stops the run.
	const budgetExhausted = step.maxFailures !== undefined && failed >= step.maxFailures;
	if (completed === 0 || budgetExhausted) {
		stepState.status = "failed";
		stepState.error = {
			code: "AGENT_ERROR",
			message: `${failed} of ${items.length} items failed${budgetExhausted ? " (max_failures reached)" : ""}`,
		};
		return;
	}
	stepState.status = "completed";
}

function buildTask(
	step: AgentStepSpec | ForeachStepSpec,
	outputs: string[],
	scope: TemplateScope,
): string {
	const parts: string[] = [];
	if (step.input !== undefined) parts.push(interpolate(step.input, scope));

	if (outputs.length > 0) {
		parts.push(
			outputs.length === 1
				? `Write your output to ${outputs[0]}.`
				: `Write your outputs to: ${outputs.join(", ")}.`,
		);
	}
	parts.push("All paths are relative to the workspace root, which is your working directory.");
	return parts.join("\n\n");
}

export function initialRunState(input: {
	spec: PipelineSpec;
	layout: RunLayout;
	pipelineHash: string;
}): Omit<RunState, "schemaVersion" | "updatedAt"> {
	return {
		runId: input.layout.runId,
		workspace: input.layout.workspace,
		pipelinePath: input.spec.filePath,
		pipelineHash: input.pipelineHash,
		createdAt: new Date().toISOString(),
		status: "running",
		vars: input.spec.vars,
		cursor: { stepIndex: 0 },
		steps: {},
		usageTotal: emptyUsage(),
	};
}
