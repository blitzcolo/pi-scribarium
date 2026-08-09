import * as fs from "node:fs";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AgentRegistry } from "../../agents/registry.js";
import { selectGate } from "../../gates/select.js";
import { writeDecision } from "../../gates/file.js";
import type { GateDecision } from "../../gates/types.js";
import { runPipeline } from "../../pipeline/engine.js";
import { parsePipeline } from "../../pipeline/load.js";
import { readRunDefaults } from "../../runtime/defaults.js";
import { preflightModels } from "../../runtime/model.js";
import { buildUsageReport, formatUsageReport } from "../../report/usage.js";
import { UsageError } from "../../util/errors.js";
import { findLatestRun, hashPipeline, RunLayout } from "../../workspace/layout.js";
import { RunStateStore } from "../../workspace/run-state.js";
import { EXIT_AWAITING_GATE, makeReporter, formatFailures } from "./run-shared.js";

export interface ResumeOptions {
	workspace: string;
	agentDir: string;
	runId?: string;
	modelOverride?: string;
	forcePipeline: boolean;
	autoApprove: boolean;
	/** Force "file" or "interactive"; defaults to TTY detection. */
	gateMode?: string;
	quiet: boolean;
}

/**
 * Continue a run that stopped at a gate, a failure, or a kill.
 *
 * The pipeline replayed is the copy frozen into the run directory, not whatever
 * the source file says now — resuming must continue the run that was actually
 * started. When the two disagree the difference is reported rather than silently
 * applied, because a spec edited mid-run can invalidate the steps already done.
 */
export async function commandResume(options: ResumeOptions): Promise<number> {
	const { workspace, agentDir } = options;
	const runId = options.runId ?? findLatestRun(workspace);
	if (runId === undefined) throw new UsageError(`No runs found in ${workspace}.`);

	const layout = new RunLayout(workspace, runId);
	const store = new RunStateStore(layout);
	const state = store.load();

	if (state.status === "completed") {
		process.stdout.write(`Run ${runId} already completed. Nothing to resume.\n`);
		return 0;
	}

	const frozen = fs.readFileSync(layout.pipelineCopy, "utf-8");
	const live = readIfPresent(state.pipelinePath);
	if (live !== undefined && hashPipeline(live) !== state.pipelineHash) {
		if (!options.forcePipeline) {
			process.stderr.write(
				`The pipeline has changed since run ${runId} started.\n` +
					`  frozen copy: ${layout.pipelineCopy}\n` +
					`  current:     ${state.pipelinePath}\n\n` +
					"Resuming would mix steps produced by two different specs. Re-run from " +
					"scratch, or pass --force-pipeline to adopt the new spec for the " +
					"remaining steps.\n",
			);
			return 2;
		}
		process.stderr.write("warning: adopting the edited pipeline for the remaining steps\n");
	}

	const source = options.forcePipeline && live !== undefined ? live : frozen;
	const registry = AgentRegistry.load({ cwd: workspace, workspaceDir: workspace, agentDir });
	// Vars are taken from the run, so resume cannot silently change them.
	const spec = parsePipeline(source, state.pipelinePath, registry, state.vars);

	const defaults = readRunDefaults(workspace, agentDir);
	const fallbackModel = options.modelOverride ?? defaults.modelRef;
	const modelRuntime = await ModelRuntime.create();

	const refs = new Set<string>();
	for (const step of spec.steps) {
		if (step.kind !== "agent" && step.kind !== "foreach") continue;
		const ref = registry.get(step.agent).modelRef ?? step.model ?? fallbackModel;
		if (ref !== undefined) refs.add(ref);
	}
	await preflightModels(modelRuntime, [...refs]);

	const done = Object.values(state.steps).filter((s) => s.status === "completed").length;
	process.stdout.write(`resuming ${runId}  (${done} step(s) already complete)\n\n`);

	const reporter = makeReporter(options.quiet);
	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.on("SIGINT", onSigint);

	try {
		const final = await runPipeline({
			spec,
			layout,
			state,
			registry,
			modelRuntime,
			agentDir,
			gate: selectGate(layout, { autoApprove: options.autoApprove, ...(options.gateMode !== undefined ? { mode: options.gateMode } : {}) }),
			signal: controller.signal,
			...(fallbackModel !== undefined ? { defaultModelRef: fallbackModel } : {}),
			...(defaults.thinking !== undefined ? { defaultThinking: defaults.thinking } : {}),
			onEvent: (event) => reporter.handle(event),
		});

		process.stdout.write(`\n${formatUsageReport(buildUsageReport(final))}`);
		const failures = formatFailures(final, layout);
		if (failures !== "") process.stderr.write(failures);

		if (final.status === "awaiting_gate") return EXIT_AWAITING_GATE;
		if (final.status === "completed") return 0;
		return final.status === "aborted" ? 130 : 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

function readIfPresent(file: string): string | undefined {
	try {
		return fs.readFileSync(file, "utf-8");
	} catch {
		return undefined;
	}
}
