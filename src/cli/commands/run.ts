import * as fs from "node:fs";
import * as path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AgentRegistry } from "../../agents/registry.js";
import { shippedPipelinesDir } from "../../agents/shipped.js";
import { onInterrupt } from "../interrupt.js";
import { selectGate } from "../../gates/select.js";
import { initialRunState, runPipeline } from "../../pipeline/engine.js";
import { loadPipeline } from "../../pipeline/load.js";
import { readRunDefaults } from "../../runtime/defaults.js";
import { preflightModels } from "../../runtime/model.js";
import { buildUsageReport, formatUsageReport } from "../../report/usage.js";
import { UsageError } from "../../util/errors.js";
import { hashPipeline, newRunId, RunLayout } from "../../workspace/layout.js";
import { RunStateStore } from "../../workspace/run-state.js";
import { collectModelRefs, EXIT_AWAITING_GATE, formatFailures, makeReporter } from "./run-shared.js";

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
	const pipelinePath = resolvePipelinePath(options.pipelinePath, workspace);

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

	await preflightModels(modelRuntime, collectModelRefs(spec, registry, fallbackModel));

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
	const releaseInterrupt = onInterrupt(controller);

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
					`  scribarium revise  ${layout.runId} -m "what to change"\n` +
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
		releaseInterrupt();
	}
}

export function resolvePipelinePath(given: string | undefined, workspace: string): string {
	if (given !== undefined) {
		for (const candidate of pipelineCandidates(given, workspace)) {
			if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
		}
		throw new UsageError(
			`Pipeline not found: ${given}\n` +
				`Looked in the workspace, the current directory, and the shipped pipelines ` +
				`(${shippedPipelineNames().join(", ")}).`,
		);
	}
	for (const candidate of DEFAULT_PIPELINES) {
		const resolved = path.join(workspace, candidate);
		if (fs.existsSync(resolved)) return resolved;
	}
	throw new UsageError(
		`No pipeline given and none found in ${workspace} ` +
			`(looked for ${DEFAULT_PIPELINES.join(", ")}). Pass one explicitly.`,
	);
}

/**
 * Where an explicitly named pipeline might be, most specific first.
 *
 * The workspace comes first because that is where a scaffolded `pipeline.yaml`
 * and any pipeline the author edited live, and those must keep winning. The
 * other two are additive: they only decide cases that would otherwise be a
 * "not found" error.
 *
 * The shipped directory is last and matters most for `explore.yaml`, which
 * `init` deliberately does not copy into a workspace — without this the only way
 * to run it would be to spell out a path inside node_modules.
 */
function pipelineCandidates(given: string, workspace: string): string[] {
	const shipped = shippedPipelinesDir();
	const bare = path.basename(given);
	const named = bare.endsWith(".yaml") || bare.endsWith(".yml") ? bare : `${bare}.yaml`;

	return [
		path.resolve(workspace, given),
		path.resolve(given),
		path.join(shipped, named),
	];
}

function shippedPipelineNames(): string[] {
	try {
		return fs
			.readdirSync(shippedPipelinesDir())
			.filter((name) => name.endsWith(".yaml"))
			.map((name) => path.basename(name, ".yaml"))
			.sort();
	} catch {
		return [];
	}
}
