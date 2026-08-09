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
import { runBuiltin } from "./builtins.js";
import { resolveItems } from "./items.js";
import { mapPool } from "./pool.js";
import { interpolate, type TemplateScope } from "./template.js";
import type { AgentStepSpec, ForeachItem, ForeachStepSpec, PipelineSpec, StepSpec } from "./schema.js";

export interface RunPipelineOptions {
	spec: PipelineSpec;
	layout: RunLayout;
	state: RunState;
	registry: AgentRegistry;
	modelRuntime: ModelRuntime;
	agentDir: string;
	defaultModelRef?: string;
	defaultThinking?: ThinkingLevelName;
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
	| { type: "stage"; stepId: string; itemId?: string; event: StageEvent };

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

	for (const [index, step] of spec.steps.entries()) {
		const existing = state.steps[step.id];
		if (existing?.status === "completed") {
			// Resume: this step already finished in an earlier attempt.
			onEvent?.({ type: "log", message: `skipping completed step ${step.id}` });
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

		if (stepState.status !== "completed") {
			state.status = stepState.error?.code === "EXTERNAL_ABORT" ? "aborted" : "failed";
			store.save(state);
			log.append("run_end", { status: state.status });
			return state;
		}
	}

	state.status = "completed";
	state.cursor = { stepIndex: spec.steps.length };
	store.save(state);
	log.append("run_end", { status: state.status, usage: state.usageTotal });
	return state;
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

	const logFile = layout.logFile(step.id, item?.id);
	fs.writeFileSync(logFile, `# ${step.id}${item === undefined ? "" : ` / ${item.id}`}\n\n## Prompt\n\n${task}\n`, "utf-8");

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
		prompt: task,
		cwd: layout.workspace,
		agentDir: options.agentDir,
		modelRuntime,
		sessionDir: layout.sessionsDir,
		...(modelRef !== undefined ? { defaultModelRef: modelRef } : {}),
		...(options.defaultThinking !== undefined ? { defaultThinking: options.defaultThinking } : {}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
		onEvent: (event) => options.onEvent?.({ type: "stage", stepId: step.id, event, ...(item !== undefined ? { itemId: item.id } : {}) }),
	});

	fs.appendFileSync(logFile, `\n## Final text\n\n${result.text}\n`, "utf-8");

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
	stepState.items = {};

	if (items.length === 0) {
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

	let usage = emptyUsage();
	let turns = 0;
	let completed = 0;
	let failed = 0;

	const settled = await mapPool(
		items,
		step.concurrency,
		async (item) => await runOneStage(step, options, state, item),
		{
			...(step.maxFailures !== undefined ? { maxFailures: step.maxFailures } : {}),
			...(options.signal !== undefined ? { signal: options.signal } : {}),
			onSettled: (index, outcome) => {
				const item = items[index] as ForeachItem;
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
	stepState.outputs = settled.flatMap((outcome) =>
		outcome.ok && outcome.value.error === undefined ? outcome.value.outputs : [],
	);

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
