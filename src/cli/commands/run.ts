import * as fs from "node:fs";
import * as path from "node:path";

import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AgentRegistry } from "../../agents/registry.js";
import { initialRunState, runPipeline, type PipelineEvent } from "../../pipeline/engine.js";
import { loadPipeline } from "../../pipeline/load.js";
import { readRunDefaults } from "../../runtime/defaults.js";
import { preflightModels } from "../../runtime/model.js";
import { buildUsageReport, formatUsageReport } from "../../report/usage.js";
import { UsageError } from "../../util/errors.js";
import { hashPipeline, newRunId, RunLayout } from "../../workspace/layout.js";
import { RunStateStore, type RunState } from "../../workspace/run-state.js";

export interface RunCommandOptions {
	workspace: string;
	agentDir: string;
	pipelinePath?: string;
	modelOverride?: string;
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

	const reporter = new ProgressReporter(options.quiet);
	const controller = new AbortController();
	const onSigint = (): void => {
		process.stderr.write("\ninterrupted; finishing the current step then stopping\n");
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
			signal: controller.signal,
			...(fallbackModel !== undefined ? { defaultModelRef: fallbackModel } : {}),
			...(defaults.thinking !== undefined ? { defaultThinking: defaults.thinking } : {}),
			onEvent: (event) => reporter.handle(event),
		});

		process.stdout.write(`\n${formatUsageReport(buildUsageReport(final))}`);
		const failures = formatFailures(final, layout);
		if (failures !== "") process.stderr.write(failures);

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

/**
 * Render pipeline progress.
 *
 * On a TTY a fan-out redraws one line in place, because thirty papers would
 * otherwise scroll the interesting parts of the run off screen. When output is
 * piped to a file there is no cursor to move, so each transition gets its own
 * line instead.
 */
class ProgressReporter {
	private readonly tty = process.stdout.isTTY === true;
	private fanoutLine = false;

	constructor(private readonly quiet: boolean) {}

	handle(event: PipelineEvent): void {
		switch (event.type) {
			case "step_start":
				this.endFanoutLine();
				process.stdout.write(`[${event.index + 1}/${event.total}] ${event.stepId} (${event.kind})\n`);
				break;

			case "fanout_start":
				process.stdout.write(
					`      ${event.total} items, ${event.concurrency} at a time\n`,
				);
				break;

			case "fanout_progress": {
				const done = event.completed + event.failed;
				const line =
					`      ${done}/${event.total} done` +
					(event.failed > 0 ? `, ${event.failed} failed` : "") +
					`  (${event.itemId})`;
				if (this.tty) {
					process.stdout.write(`\r\u001b[2K${line}`);
					this.fanoutLine = true;
				} else if (event.error !== undefined || done === event.total) {
					process.stdout.write(`${line}\n`);
				}
				// A failure is worth a line of its own even mid-fan-out.
				if (event.error !== undefined) {
					this.endFanoutLine();
					process.stderr.write(`      ! ${event.itemId}: ${event.error}\n`);
				}
				break;
			}

			case "step_end":
				this.endFanoutLine();
				process.stdout.write(
					event.status === "completed"
						? `      ${event.stepId}: ok\n`
						: `      ${event.stepId}: ${event.status} — ${event.error ?? ""}\n`,
				);
				break;

			case "log":
				this.endFanoutLine();
				process.stdout.write(`${event.message}\n`);
				break;

			case "stage":
				// Per-tool chatter is noise during a fan-out; it belongs to one item
				// among many and the progress line already says which.
				if (this.quiet || this.fanoutLine) break;
				if (event.event.type === "tool") process.stdout.write(`      · ${event.event.tool}\n`);
				else if (event.event.type === "steer") process.stdout.write("      · wrapping up (turn budget)\n");
				else if (event.event.type === "warn") process.stderr.write(`      ! ${event.event.message}\n`);
				break;
		}
	}

	private endFanoutLine(): void {
		if (!this.fanoutLine) return;
		process.stdout.write("\n");
		this.fanoutLine = false;
	}
}

/** List every failed item so a partial run is actionable, not just "27/30". */
function formatFailures(state: RunState, layout: RunLayout): string {
	const lines: string[] = [];
	for (const [stepId, step] of Object.entries(state.steps)) {
		for (const [itemId, item] of Object.entries(step.items ?? {})) {
			if (item.status !== "failed") continue;
			lines.push(
				`  ${stepId}/${itemId}  ${item.error?.code ?? "FAILED"}: ${item.error?.message ?? ""}`,
				`      log: ${layout.logFile(stepId, itemId)}`,
			);
		}
		if (step.status === "failed" && step.items === undefined) {
			lines.push(`  ${stepId}  ${step.error?.code ?? "FAILED"}: ${step.error?.message ?? ""}`);
		}
	}
	return lines.length === 0 ? "" : `\nFailures:\n${lines.join("\n")}\n`;
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
