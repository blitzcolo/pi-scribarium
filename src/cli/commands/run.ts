import * as fs from "node:fs";
import * as path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AgentRegistry } from "../../agents/registry.js";
import { selectGate } from "../../gates/select.js";
import { initialRunState, runPipeline } from "../../pipeline/engine.js";
import { loadPipeline } from "../../pipeline/load.js";
import { readRunDefaults } from "../../runtime/defaults.js";
import { preflightModels } from "../../runtime/model.js";
import { buildUsageReport, formatUsageReport } from "../../report/usage.js";
import { UsageError } from "../../util/errors.js";
import { hashPipeline, newRunId, RunLayout } from "../../workspace/layout.js";
import { RunStateStore } from "../../workspace/run-state.js";
import { EXIT_AWAITING_GATE, formatFailures, makeReporter } from "./run-shared.js";

export interface RunCommandOptions {
	workspace: string;
	agentDir: string;
	pipelinePath?: string;
	modelOverride?: string;
	/** Approve every gate without asking. For CI and unattended re-runs. */
	autoApprove: boolean;
	/** Force "file" or "interactive"; defaults to TTY detection. */
	gateMode?: string;
	/** `--var k=v` overrides, applied over the pipeline's own vars. */
	vars: Record<string, string>;
	quiet: boolean;
}

/** Default pipeline lookup order, all relative to the workspace. */
const DEFAULT_PIPELINES = ["pipeline.yaml", "pipelines/paper.yaml"];

export async function commandRun(options: RunCommandOptions): Promise<number> {
	const { workspace, agentDir } = options;
	const pipelinePath = resolvePipeline(options);

	const registry = AgentRegistry.load({ cwd: workspace, workspaceDir: workspace, agentDir });
	for (const diagnostic of registry.diagnostics) {
		process.stderr.write(`warning: ${diagnostic.filePath}: ${diagnostic.message}\n`);
	}

	// Loading validates the whole spec, including agent names and every template
	// reference, before a single model call is made.
	const spec = loadPipeline(pipelinePath, registry, options.vars);

	const defaults = readRunDefaults(workspace, agentDir);
	const fallbackModel = options.modelOverride ?? defaults.modelRef;
	const modelRuntime = await ModelRuntime.create();

	const refs = new Set<string>();
	for (const step of spec.steps) {
		if (step.kind !== "agent") continue;
		const ref = registry.get(step.agent).modelRef ?? step.model ?? fallbackModel;
		if (ref !== undefined) refs.add(ref);
	}
	await preflightModels(modelRuntime, [...refs]);

	const layout = new RunLayout(workspace, newRunId());
	layout.ensure();
	// Freeze the spec: resume must replay what this run actually agreed to, not
	// whatever the file says later.
	fs.writeFileSync(layout.pipelineCopy, spec.source, "utf-8");
	layout.markLatest();

	const state = RunStateStore.create(
		layout,
		initialRunState({ spec, layout, pipelineHash: hashPipeline(spec.source) }),
	);

	process.stdout.write(`run ${layout.runId}  ${spec.name}  (${spec.steps.length} steps)\n\n`);

	const reporter = makeReporter(options.quiet);
	const controller = new AbortController();
	const onSigint = (): void => {
		process.stderr.write("\ninterrupted; stopping (resume this run to continue)\n");
		controller.abort();
	};
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

		if (final.status === "awaiting_gate") {
			process.stdout.write(
				`\nWaiting for review. Inspect the artifacts, then:\n` +
					`  scribarium approve ${layout.runId}\n` +
					`  scribarium reject  ${layout.runId} -m "what to change"\n` +
					`  scribarium resume  ${layout.runId}\n`,
			);
			return EXIT_AWAITING_GATE;
		}
		if (final.status === "completed") {
			process.stdout.write(`\nArtifacts are in ${workspace}\n`);
			return 0;
		}
		process.stderr.write(`\nRun ${final.status}. Inspect ${layout.runDir}\n`);
		return final.status === "aborted" ? 130 : 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

function resolvePipeline(options: RunCommandOptions): string {
	if (options.pipelinePath !== undefined) {
		const explicit = path.resolve(options.workspace, options.pipelinePath);
		if (!fs.existsSync(explicit)) throw new UsageError(`Pipeline not found: ${explicit}`);
		return explicit;
	}
	for (const candidate of DEFAULT_PIPELINES) {
		const resolved = path.join(options.workspace, candidate);
		if (fs.existsSync(resolved)) return resolved;
	}
	throw new UsageError(
		`No pipeline given and none found in ${options.workspace} ` +
			`(looked for ${DEFAULT_PIPELINES.join(", ")}). Pass one explicitly.`,
	);
}
