import * as fs from "node:fs";
import * as path from "node:path";

import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

import type { AgentRegistry } from "../agents/registry.js";
import { AGENT_DEFAULTS, type ThinkingLevelName } from "../agents/types.js";
import { runStage, type RunStageResult, type StageEvent } from "../runtime/run-stage.js";
import type { Fetcher } from "../search/http.js";
import { contain, type RunLayout } from "../workspace/layout.js";
import {
	addUsage,
	emptyUsage,
	EventLog,
	RunStateStore,
	type RunState,
	type StepState,
} from "../workspace/run-state.js";
import { clearDecision } from "../gates/file.js";
import { applyKeep, KeepError, readSelectable } from "../gates/keep.js";
import { archiveAttempt, buildRegeneratePrompt } from "../gates/regenerate.js";
import type { GateHandler } from "../gates/types.js";
import { redactSecrets } from "../util/safety.js";
import { describeNotice, runBuiltin } from "./builtins.js";
import { resolveItems } from "./items.js";
import { mapPool, MAX_CONCURRENCY } from "./pool.js";
import { interpolate, type TemplateScope } from "./template.js";
import type {
	AgentStepSpec,
	ForeachItem,
	ForeachSource,
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
	/**
	 * HTTP transport for the searching builtins and the `search_papers` tool.
	 *
	 * Injected rather than reached for directly so tests can serve fixtures, and
	 * so a step that is meant to stay offline can be proven to have made no
	 * request. Unset means the real polite fetcher.
	 */
	fetcher?: Fetcher;
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
	| { type: "gate_decided"; stepId: string; decision: string; target?: string }
	| { type: "gate_pruned"; stepId: string; kept: number; dropped: string[] };

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
		// An abort delivered between steps has no stage to interrupt, so nothing
		// else would notice it: the loop would calmly start the next step.
		if (options.signal?.aborted === true) {
			state.status = "aborted";
			store.save(state);
			log.append("run_end", { status: "aborted" });
			return state;
		}

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
			// Usage and turns are cumulative *for the step*, across every attempt.
			// The report answers "what did this step cost", which a resumed run's
			// final attempt alone does not.
			...(existing?.usage !== undefined ? { usage: existing.usage } : {}),
			...(existing?.turns !== undefined ? { turns: existing.turns } : {}),
		};
		state.steps[step.id] = stepState;
		store.save(state);
		log.append("step_start", { stepId: step.id, kind: step.kind, attempt: stepState.attempts });
		onEvent?.({ type: "step_start", stepId: step.id, index, total: spec.steps.length, kind: step.kind });

		try {
			if (step.kind === "builtin") {
				await executeBuiltin(step, stepState, options, state);
			} else if (step.kind === "foreach") {
				await executeForeach(step, stepState, options, state, store);
			} else {
				await executeAgent(step, stepState, options, state);
			}
		} catch (error) {
			stepState.status = "failed";
			stepState.error = {
				// Not every exception here comes from a builtin: this catch also covers
				// agent and fan-out steps, where an unresolvable template or an
				// unreadable item source lands.
				code: step.kind === "builtin" ? "BUILTIN_ERROR" : "AGENT_ERROR",
				message: error instanceof Error ? error.message : String(error),
			};
		}

		stepState.endedAt = new Date().toISOString();
		// The run total is folded in by whoever spent it, not here: a fan-out adds
		// each item as it settles, so a run killed at item 290 of 300 keeps the 290
		// it paid for rather than losing them with the step that never ended.
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
	const handler: GateHandler = options.gate ?? (async () => ({ kind: "approve" }));

	const scope = baseScope(options, state);
	const artifacts = step.show.map((template) => {
		// Interpolated, not used verbatim: the loader validates these as templates,
		// so `show: outline/${vars.name}.md` passes validation and then presented
		// the reviewer with a literal path that could not exist.
		const relative = interpolate(template, scope);
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

	// An optional gate whose artifacts are absent has nothing to decide about, and
	// stopping anyway would mean asking a question with no material behind it —
	// in file mode at the cost of an exit 10 and an approve-and-resume cycle.
	// Checked before the step is marked awaiting, so a run that never needed the
	// gate carries no trace of having stopped at one.
	if (step.optional === true && artifacts.every((artifact) => !artifact.exists || artifact.bytes === 0)) {
		const skipped: StepState = state.steps[step.id] ?? {
			type: "gate",
			status: "skipped",
			attempts: 0,
			outputs: [],
		};
		skipped.type = "gate";
		skipped.status = "skipped";
		state.steps[step.id] = skipped;
		store.save(state);
		onEvent?.({ type: "log", message: `skipping optional gate ${step.id}: nothing to review` });
		log.append("gate_skipped", { stepId: step.id, reason: "no artifacts to review" });
		return { kind: "proceed" };
	}

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

	// Resolved before the handler is called so both gate modes see the same list:
	// the terminal prints it, the file protocol writes it into the request.
	const selectFile =
		step.select === undefined ? undefined : interpolate(step.select.from, scope);
	const selectable =
		selectFile === undefined
			? undefined
			: {
					file: selectFile,
					items: readSelectable(layout.artifact(selectFile), step.select?.path),
				};

	const decision = await handler({
		step,
		runId: layout.runId,
		workspace: layout.workspace,
		artifacts,
		usageSoFar: state.usageTotal,
		...(selectable !== undefined ? { selectable } : {}),
	});

	if (decision === "defer") return { kind: "defer" };

	// Before the decision is recorded: a keep list that cannot be applied must
	// leave the gate exactly as it found it, still awaiting, so the reviewer can
	// correct the ids and answer again.
	if (decision.kind === "approve" && decision.keep !== undefined) {
		if (step.select === undefined || selectFile === undefined) {
			throw new KeepError(
				`Gate "${step.id}" does not declare "select:", so there is no list for --keep to ` +
					`prune. Approve without it, or add select: to the step.`,
			);
		}
		const result = applyKeep({
			layout,
			stepId: step.id,
			select: step.select,
			relativeFile: selectFile,
			keep: decision.keep,
			attempt: stepState.attempts + 1,
		});
		if (result.dropped.length > 0) {
			log.append("gate_pruned", {
				stepId: step.id,
				file: selectFile,
				kept: result.kept,
				dropped: result.dropped,
				...(result.archivedTo !== undefined ? { archivedTo: result.archivedTo } : {}),
			});
			onEvent?.({
				type: "gate_pruned",
				stepId: step.id,
				kept: result.kept.length,
				dropped: result.dropped,
			});
		}
	}

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
			// The target must be a step of *this* spec that has already run. A
			// `--force-pipeline` resume can drop a step the run's state still
			// mentions, and rewinding to a step the spec no longer has would index
			// the list at -1 and throw outside any handler.
			const targetIndex =
				target === undefined
					? -1
					: options.spec.steps.findIndex((candidate) => candidate.id === target);
			if (target === undefined || targetIndex === -1 || state.steps[target] === undefined) {
				stepState.status = "failed";
				stepState.error = {
					code: "BUILTIN_ERROR",
					message:
						target === undefined
							? `rejected, but there is nothing to regenerate: ` +
								`gate "${step.id}" has no on_reject target`
							: `rejected, but "${target}" is not a step of this run that has already run`,
				};
				store.save(state);
				return { kind: "abort" };
			}

			const targetState = state.steps[target] as StepState;
			targetState.pendingFeedback = decision.feedback;

			// Re-open the target *and everything after it*, not just the target. A
			// step between the target and this gate was written against the artifact
			// that is about to change; left `completed`, the main loop skips it and
			// the gate re-opens showing exactly the output the reviewer just
			// rejected — an approve/reject loop with nothing changing between turns.
			// Later gates lose their approval for the same reason it was given: it
			// was an approval of the old version. Same rule as `scribarium redo`.
			for (const candidate of options.spec.steps.slice(targetIndex)) {
				const candidateState = state.steps[candidate.id];
				if (candidateState === undefined) continue;
				candidateState.status = "pending";
				delete candidateState.error;
				if (candidate.kind === "gate") clearDecision(layout, candidate.id);
			}
			// This gate asks again once the work has been regenerated.
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
	state: RunState,
): Promise<void> {
	// `with` values are validated as templates by the loader, so they have to be
	// expanded here too — otherwise `manuscript: final/${vars.slug}.md` loads
	// cleanly and then fails at run time on a path nobody wrote.
	const scope = baseScope(options, state);
	const expanded = {
		...step,
		with: Object.fromEntries(
			Object.entries(step.with).map(([key, value]) => [
				key,
				typeof value === "string" ? interpolate(value, scope) : value,
			]),
		),
	};

	const result = await runBuiltin(expanded, {
		workspace: options.layout.workspace,
		resolveOutput: (relative) => options.layout.artifact(relative),
		onProgress: (message) => options.onEvent?.({ type: "log", message }),
		...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
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
		// Contained like every other declared path: `item.path` comes from a glob
		// or a JSON source, and path.resolve discards the base for an absolute one.
		sourceMtime = fs.statSync(layout.artifact(item.path)).mtimeMs;
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
	/**
	 * Cancellation for this stage. A fan-out passes the pool's own composed
	 * signal, which also fires when a failure budget is spent; without it
	 * `max_failures` could only decline to schedule more work, never wind down
	 * what is already running.
	 */
	signal?: AbortSignal,
): Promise<{
	outputs: string[];
	result: RunStageResult;
	error?: StepState["error"];
	modelRef?: string;
}> {
	const { layout, registry, modelRuntime } = options;
	const stageSignal = signal ?? options.signal;
	const agent = registry.get(step.agent);
	const scope = baseScope(options, state, item);

	const outputs = step.outputs.map((template) => interpolate(template, scope));
	const scopeWithOutputs: TemplateScope = {
		...scope,
		...(outputs.length > 0 ? { output: outputs.join(", ") } : {}),
	};
	const task = buildTask(step, outputs, scopeWithOutputs);

	const previous = state.steps[step.id];
	// Fan-out items get the feedback too. Withholding it made a rejection whose
	// `on_reject` names a foreach step — which the shipped pipeline does — write
	// the reviewer's words to disk and then ignore them.
	const feedback = previous?.pendingFeedback;
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
	// Precedence, matching `model` (agent first): an explicit value on the step is
	// an override, but a pipeline-wide `defaults:` is a fallback for agents that
	// state no budget of their own. `agent.maxTurns` is always set — from the
	// frontmatter or AGENT_DEFAULTS — so the pipeline default only applies when
	// the agent left it at the built-in default.
	const defaults = options.spec.defaults;
	const maxTurns =
		step.maxTurns ??
		(agent.maxTurns === AGENT_DEFAULTS.maxTurns ? (defaults.maxTurns ?? agent.maxTurns) : agent.maxTurns);
	const timeoutMs = step.timeoutMs ?? agent.timeoutMs ?? defaults.timeoutMs;

	const result: RunStageResult = await runStage({
		agent: {
			...agent,
			maxTurns,
			...(timeoutMs !== undefined ? { timeoutMs } : {}),
		},
		prompt: finalTask,
		cwd: layout.workspace,
		agentDir: options.agentDir,
		modelRuntime,
		sessionDir: layout.sessionsDir,
		// Only reaches an agent whose `tools:` grants a custom tool; every shipped
		// agent but the query planner grants none and stays offline regardless.
		// Passed unconditionally, unlike before: gating the whole context on an
		// injected fetcher meant that in production — where there is none and the
		// tool builds its own — the notice hook was never installed. The one stage
		// that reaches the network was therefore the one that said nothing while it
		// was being rate-limited, which is gotcha #21 at the layer where it hurts
		// most: minutes of absorbing 429s look exactly like a stage that has stopped.
		customToolContext: {
			...(options.fetcher !== undefined ? { fetcher: options.fetcher } : {}),
			onNotice: (notice) =>
				options.onEvent?.({
					type: "stage",
					stepId: step.id,
					event: { type: "warn", message: describeNotice(notice).trim() },
					...(item !== undefined ? { itemId: item.id } : {}),
				}),
		},
		...(modelRef !== undefined ? { defaultModelRef: modelRef } : {}),
		...(options.defaultThinking !== undefined ? { defaultThinking: options.defaultThinking } : {}),
		...(stageSignal !== undefined ? { signal: stageSignal } : {}),
		onEvent: (event) => options.onEvent?.({ type: "stage", stepId: step.id, event, ...(item !== undefined ? { itemId: item.id } : {}) }),
	});

	fs.appendFileSync(logFile, redactSecrets(`\n## Final text\n\n${result.text}\n`), "utf-8");

	// The declared outputs are the contract, and a stage that spent its whole turn
	// budget but wrote everything it promised has met it. That is precisely what
	// the soft-limit steer asks the agent to do — stop exploring, write the file —
	// and the wrap-up turn is the one that trips the budget, so failing here made
	// the cooperative path impossible to survive and cost the artifact as well.
	// Every turn completed cleanly, so unlike a timeout there is no half-written
	// file to worry about.
	const spentBudget =
		result.status === "failed" && result.error?.code === "TURN_BUDGET_EXCEEDED";
	const wroteEverything =
		outputs.length > 0 && outputs.every((output) => fs.existsSync(layout.artifact(output)));

	if (result.status !== "completed" && !(spentBudget && wroteEverything)) {
		return {
			outputs,
			result,
			...(modelRef !== undefined ? { modelRef } : {}),
			error: result.error ?? { code: "AGENT_ERROR", message: "stage did not complete" },
		};
	}

	if (spentBudget) {
		options.onEvent?.({
			type: "stage",
			stepId: step.id,
			...(item !== undefined ? { itemId: item.id } : {}),
			event: {
				type: "warn",
				message: `${step.id}${item === undefined ? "" : `/${item.id}`}: used its whole turn budget, but wrote every declared output`,
			},
		});
	}

	// The declared outputs are the real contract. getLastAssistantText() is
	// advisory — an agent whose last act was a tool call returns empty text, and
	// one that talks about writing a file without writing it must not pass.
	const missing = outputs.filter((output) => !fs.existsSync(layout.artifact(output)));
	if (missing.length > 0) {
		return {
			outputs,
			result,
			...(modelRef !== undefined ? { modelRef } : {}),
			error: {
				code: "MISSING_OUTPUT",
				message: `declared output(s) not written: ${missing.join(", ")}`,
			},
		};
	}

	return { outputs, result, ...(modelRef !== undefined ? { modelRef } : {}) };
}

async function executeAgent(
	step: AgentStepSpec,
	stepState: StepState,
	options: RunPipelineOptions,
	state: RunState,
): Promise<void> {
	const { outputs, result, error, modelRef } = await runOneStage(step, options, state);

	// Cumulative across attempts; the run total takes only this attempt's delta.
	stepState.turns = (stepState.turns ?? 0) + result.turns;
	stepState.usage = addUsage(stepState.usage ?? emptyUsage(), result.usage);
	state.usageTotal = addUsage(state.usageTotal, result.usage);
	if (modelRef !== undefined) stepState.model = modelRef;
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
	const items = resolveItems(interpolateSource(step.source, baseScope(options, state)), options.layout.workspace);

	// A rejection asks for this step to be done again, so an item completed under
	// an *earlier* attempt no longer counts as done — carrying them all forward
	// left nothing to run and re-completed the step having done nothing at all.
	// An item completed during *this* attempt still counts, or a regeneration
	// killed halfway would start over from the beginning.
	const recorded = stepState.items ?? {};
	const previous =
		stepState.pendingFeedback === undefined
			? recorded
			: Object.fromEntries(
					Object.entries(recorded).filter(([, entry]) => entry.attempt === stepState.attempts),
				);
	stepState.items = { ...previous };

	if (items.length === 0) {
		if (step.optional === true) {
			stepState.status = "skipped";
			// Nothing matched, so there is nothing the feedback could be applied to.
			// Left in place it would disable this step's cache for the rest of the run.
			delete stepState.pendingFeedback;
			options.onEvent?.({ type: "log", message: `      no items; skipping ${step.id}` });
			return;
		}
		stepState.status = "failed";
		stepState.error = { code: "BUILTIN_ERROR", message: "fan-out matched no items" };
		return;
	}

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
			(stepState.items ??= {})[item.id] = {
				status: "completed",
				outputs: fresh,
				attempt: stepState.attempts,
			};
			continue;
		}
		pending.push(item);
	}

	options.onEvent?.({
		type: "fanout_start",
		stepId: step.id,
		total: items.length,
		// Reported after the skips are known and clamped exactly as the pool
		// clamps, so the number on screen is the number of sessions that will run.
		concurrency: Math.max(1, Math.min(step.concurrency, pending.length, MAX_CONCURRENCY)),
	});

	// Cumulative across attempts, so the report answers what the step cost rather
	// than what its last attempt cost.
	let usage = stepState.usage ?? emptyUsage();
	let turns = stepState.turns ?? 0;
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

	await mapPool(
		pending,
		step.concurrency,
		async (item, _index, itemSignal) => await runOneStage(step, options, state, item, itemSignal),
		{
			...(step.maxFailures !== undefined ? { maxFailures: step.maxFailures } : {}),
			// A stage that ran and reported it never wrote its output resolves
			// rather than throws, and is the failure that actually dominates.
			isFailure: (value) => value.error !== undefined,
			...(options.signal !== undefined ? { signal: options.signal } : {}),
			onSettled: (index, outcome) => {
				const item = pending[index] as ForeachItem;
				const entry =
					outcome.ok && outcome.value.error === undefined
						? {
								status: "completed" as const,
								outputs: outcome.value.outputs,
								attempt: stepState.attempts,
							}
						: {
								status: "failed" as const,
								attempt: stepState.attempts,
								error: outcome.ok
									? (outcome.value.error ?? { code: "AGENT_ERROR" as const, message: "failed" })
									: { code: "AGENT_ERROR" as const, message: outcome.error.message },
							};

				if (outcome.ok) {
					usage = addUsage(usage, outcome.value.result.usage);
					turns += outcome.value.result.turns;
					if (outcome.value.modelRef !== undefined) stepState.model = outcome.value.modelRef;
					// Folded into the run total here, not at step end: a fan-out killed
					// at item 290 of 300 never reaches its end, and the resumed attempt
					// counts only new items — so all 290 items' spend would vanish.
					state.usageTotal = addUsage(state.usageTotal, outcome.value.result.usage);
				}
				if (entry.status === "completed") completed++;
				else {
					failed++;
					// Whatever the item managed to write is not a result. Left in the
					// workspace a truncated card is indistinguishable from a finished
					// one: `build-index` collates it, a writer cites it, and `cache:` —
					// which asks only whether the output is newer than its source —
					// serves it as a hit to every later run. Keep it where it can be
					// inspected instead.
					const moved = outcome.ok
						? quarantineFailedOutputs(
								options.layout,
								step.id,
								stepState.attempts,
								outcome.value.outputs,
							)
						: [];
					if (moved.length > 0) {
						options.onEvent?.({
							type: "log",
							message: `      ${item.id}: set aside partial output (${moved.join(", ")})`,
						});
					}
				}

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
	//
	// Ordered by item, not by completion. `Object.values` walks insertion order,
	// which under concurrency is whichever session finished first — so the same
	// corpus produced a different list on every run, and that list is rendered
	// into the reducer's prompt as `${steps.<id>.outputs}`. A prompt that varies
	// run to run for identical inputs is not reproducible, and the difference is
	// invisible until someone compares two transcripts.
	const settled = stepState.items ?? {};
	const ordered = items
		.map((item) => settled[item.id])
		.filter((entry) => entry?.status === "completed");
	// An item whose source file vanished between attempts is no longer in `items`
	// but may still hold a completed entry; keep it, in a stable position.
	const seen = new Set(items.map((item) => item.id));
	const orphaned = Object.entries(settled)
		.filter(([id, entry]) => !seen.has(id) && entry.status === "completed")
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([, entry]) => entry);

	stepState.outputs = [...ordered, ...orphaned].flatMap((entry) => entry?.outputs ?? []);

	// A cancelled fan-out is not a partial success. Without this the common case —
	// Ctrl-C with no `max_failures` set — leaves `failed` at just the handful that
	// were in flight, the step is marked completed, and the main loop then skips it
	// forever on resume: the items that never ran are silently lost.
	if (options.signal?.aborted === true) {
		stepState.status = "failed";
		stepState.error = {
			code: "EXTERNAL_ABORT",
			message: `cancelled after ${completed} of ${items.length} item(s)`,
		};
		return;
	}

	if (failed === 0) {
		stepState.status = "completed";
		delete stepState.pendingFeedback;
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
	// Consumed: the feedback has been folded into this attempt's prompts. Left in
	// place it would also disable `cache:` for this step for the rest of the run.
	delete stepState.pendingFeedback;
}

/**
 * Move aside whatever a failed fan-out item managed to write.
 *
 * A stage that blew its turn budget mid-revision leaves a truncated file behind.
 * The declared-output contract already refuses to call the item successful, but
 * the file itself stays in the workspace, where nothing can tell it from a
 * finished artifact. Moving it under the run's attempts directory keeps it
 * available for inspection without letting it pass as a result.
 */
function quarantineFailedOutputs(
	layout: RunLayout,
	stepId: string,
	attempt: number,
	outputs: readonly string[],
): string[] {
	const moved: string[] = [];
	for (const relative of outputs) {
		const source = layout.artifact(relative);
		const extension = path.extname(relative);
		const base = relative.slice(0, relative.length - extension.length);
		const target = contain(
			layout.attemptsDir,
			path.join(stepId, `${base}.failed-attempt${attempt}${extension}`),
			"archive",
		);
		try {
			if (!fs.existsSync(source)) continue;
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.renameSync(source, target);
			moved.push(relative);
		} catch {
			// Best effort. A partial artifact left in place is bad; failing the whole
			// fan-out because one could not be moved would be worse.
		}
	}
	return moved;
}

/**
 * Expand `${...}` in a fan-out's source.
 *
 * The loader validates every other template but never looked at this one, so
 * `foreach: "${vars.dir}/text/*.md"` loaded cleanly and then matched nothing —
 * or, with `optional: true`, skipped the whole analysis stage in silence.
 */
function interpolateSource(source: ForeachSource, scope: TemplateScope): ForeachSource {
	switch (source.kind) {
		case "glob":
			return { kind: "glob", pattern: interpolate(source.pattern, scope) };
		case "json":
			return {
				kind: "json",
				file: interpolate(source.file, scope),
				...(source.path !== undefined ? { path: source.path } : {}),
			};
		case "items":
			return source;
	}
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
