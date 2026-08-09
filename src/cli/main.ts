#!/usr/bin/env node
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AgentRegistry } from "../agents/registry.js";
import { commandEvents, commandReport, commandStatus } from "./commands/inspect.js";
import { commandRun } from "./commands/run.js";
import { commandInit } from "./commands/init.js";
import { commandRedo } from "./commands/redo.js";
import { commandDecide, commandResume } from "./commands/resume.js";
import { collectCorpusInputs, ingestCorpus } from "../ingest/pdf.js";
import { readRunDefaults } from "../runtime/defaults.js";
import { preflightModels } from "../runtime/model.js";
import { runStage } from "../runtime/run-stage.js";
import { PreflightError, ScribariumError, UsageError } from "../util/errors.js";
import { assertDepthAllowed } from "../util/safety.js";
import { VERSION } from "../version.js";
import { flagAll, flagBoolean, flagString, parseArgs, type ParsedArgs } from "./args.js";

const HELP = `scholarly ${VERSION} — multi-agent orchestration for academic writing

Usage: scholarly <command> [options]

Commands:
  init <dir>                Scaffold a workspace for one paper
  run [pipeline]            Run a pipeline end to end
  resume [runId]            Continue a run that stopped at a gate or a failure
  redo <step> [runId]       Re-open a finished step (and everything after it)
  approve [runId] [step]    Approve a pending gate
  reject  [runId] [step]    Reject a gate and regenerate (-m "what to change")
  status [runId]            Where a run got to (defaults to the latest run)
  report [runId]            Token and cost accounting per step
  events [runId]            Append-only log of what happened
  agents                    List discovered agent definitions
  validate                  Check every agent's model reference and credentials
  ingest <paths...>         Convert a PDF/text corpus to Markdown
  run-agent <name>          Run a single agent to completion
  help, version

Common options:
  --workspace <dir>         Workspace root (default: cwd)
  --agent-dir <dir>         pi config dir (default: ~/.pi/agent)
  --model <provider/model>  Override the model for agents that do not pin one

run / resume options:
  --var key=value           Override a pipeline var (repeatable)
  --yes, -y                 Approve every gate without asking
  --quiet                   Do not print per-tool progress
  --gate-mode <mode>        file | interactive (default: interactive on a TTY)
  --force-pipeline          (resume) adopt an edited pipeline for remaining steps

redo options:
  -m, --message <text>      Feedback folded into the re-opened step's prompt

reject options:
  -m, --message <text>      Feedback folded into the regenerated step's prompt
  --target <stepId>         Regenerate this step instead of the gate's on_reject

Exit codes: 0 ok · 1 failed · 2 usage/config · 3 preflight · 10 awaiting gate · 130 interrupted

status / report options:
  --json                    Machine-readable output

ingest options:
  --out <dir>               Output directory (default: <workspace>/corpus/text)
  --force                   Re-extract even when the output is current

run-agent options:
  --input <file>            File whose contents become the task prompt
  --task <text>             Task prompt given inline
  --session-dir <dir>       Persist the session transcript as JSONL
  --quiet                   Do not stream assistant text to stdout
`;

async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);
	// Cheap commands are exempt; only the ones that would spend money recurse.
	if (["run", "resume", "run-agent"].includes(args.command ?? "")) assertDepthAllowed();
	const command = args.command ?? (flagBoolean(args, "version", "v") ? "version" : "help");

	switch (command) {
		case "help":
			process.stdout.write(HELP);
			return 0;
		case "version":
			process.stdout.write(`${VERSION}\n`);
			return 0;
		case "init": {
			const target = args.positionals[0];
			if (target === undefined) throw new UsageError("init requires a directory.");
			return commandInit(target, flagBoolean(args, "force"));
		}
		case "run": {
			const { workspace, agentDir } = resolveContext(args);
			const pipeline = args.positionals[0];
			const modelOverride = flagString(args, "model", "m");
			const gateMode = flagString(args, "gate-mode");
			return await commandRun({
				workspace,
				agentDir,
				quiet: flagBoolean(args, "quiet"),
				autoApprove: flagBoolean(args, "yes", "y"),
				vars: parseVarFlags(args),
				...(gateMode !== undefined ? { gateMode } : {}),
				...(pipeline !== undefined ? { pipelinePath: pipeline } : {}),
				...(modelOverride !== undefined ? { modelOverride } : {}),
			});
		}
		case "resume": {
			const { workspace, agentDir } = resolveContext(args);
			const runId = args.positionals[0];
			const modelOverride = flagString(args, "model", "m");
			const gateMode = flagString(args, "gate-mode");
			return await commandResume({
				workspace,
				agentDir,
				forcePipeline: flagBoolean(args, "force-pipeline"),
				autoApprove: flagBoolean(args, "yes", "y"),
				quiet: flagBoolean(args, "quiet"),
				...(gateMode !== undefined ? { gateMode } : {}),
				...(runId !== undefined ? { runId } : {}),
				...(modelOverride !== undefined ? { modelOverride } : {}),
			});
		}
		case "redo": {
			const { workspace, agentDir } = resolveContext(args);
			const stepId = args.positionals[0];
			if (stepId === undefined) throw new UsageError("redo requires a step id.");
			const runId = args.positionals[1];
			const feedback = flagString(args, "message", "m");
			return commandRedo({
				workspace,
				agentDir,
				stepId,
				...(runId !== undefined ? { runId } : {}),
				...(feedback !== undefined ? { feedback } : {}),
			});
		}
		case "approve":
			return commandDecide(resolveContext(args).workspace, args.positionals[0], args.positionals[1], {
				kind: "approve",
			});
		case "reject": {
			const feedback = flagString(args, "message", "m");
			if (feedback === undefined) {
				throw new UsageError('reject requires -m "what to change".');
			}
			const target = flagString(args, "target");
			return commandDecide(resolveContext(args).workspace, args.positionals[0], args.positionals[1], {
				kind: "reject",
				feedback,
				...(target !== undefined ? { target } : {}),
			});
		}
		case "status":
			return commandStatus(resolveContext(args).workspace, args.positionals[0], flagBoolean(args, "json"));
		case "report":
		case "cost":
			return commandReport(resolveContext(args).workspace, args.positionals[0], flagBoolean(args, "json"));
		case "events":
			return commandEvents(resolveContext(args).workspace, args.positionals[0]);
		case "agents":
			return commandAgents(args);
		case "validate":
			return await commandValidate(args);
		case "ingest":
			return await commandIngest(args);
		case "run-agent":
			return await commandRunAgent(args);
		default:
			process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
			return 2;
	}
}

/** Collect repeated `--var key=value` flags. */
function parseVarFlags(args: ParsedArgs): Record<string, string> {
	const vars: Record<string, string> = {};
	for (const value of flagAll(args, "var")) {
		const equals = value.indexOf("=");
		if (equals === -1) throw new UsageError(`--var expects key=value, got "${value}"`);
		vars[value.slice(0, equals).trim()] = value.slice(equals + 1);
	}
	return vars;
}

function resolveContext(args: ParsedArgs): { workspace: string; agentDir: string } {
	return {
		workspace: path.resolve(flagString(args, "workspace", "w") ?? process.cwd()),
		agentDir: flagString(args, "agent-dir") ?? getAgentDir(),
	};
}

function loadRegistry(args: ParsedArgs): AgentRegistry {
	const { workspace, agentDir } = resolveContext(args);
	return AgentRegistry.load({ cwd: workspace, workspaceDir: workspace, agentDir });
}

function commandAgents(args: ParsedArgs): number {
	const registry = loadRegistry(args);
	const agents = registry.list();

	if (agents.length === 0) {
		process.stdout.write("No agent definitions found.\n");
	} else {
		const width = Math.max(...agents.map((a) => a.name.length));
		for (const agent of agents) {
			const tools = agent.tools === undefined ? "default" : agent.tools.join(",") || "none";
			process.stdout.write(
				`${agent.name.padEnd(width)}  ${agent.source.padEnd(9)}  ` +
					`${agent.modelRef ?? "(default model)"}  [${tools}]\n` +
					`${" ".repeat(width)}  ${agent.description}\n`,
			);
		}
	}

	for (const diagnostic of registry.diagnostics) {
		process.stderr.write(`warning: ${diagnostic.filePath}: ${diagnostic.message}\n`);
	}

	// `--strict` turns unloadable definitions into a failure, for CI.
	return flagBoolean(args, "strict") && registry.diagnostics.length > 0 ? 2 : 0;
}

async function commandValidate(args: ParsedArgs): Promise<number> {
	const registry = loadRegistry(args);

	for (const diagnostic of registry.diagnostics) {
		process.stderr.write(`error: ${diagnostic.filePath}: ${diagnostic.message}\n`);
	}
	if (registry.diagnostics.length > 0) return 2;

	const refs = registry.modelRefs();
	process.stdout.write(
		`Loaded ${registry.list().length} agent(s); checking ${refs.length} pinned model reference(s).\n`,
	);

	const modelRuntime = await ModelRuntime.create();
	await preflightModels(modelRuntime, refs);
	for (const ref of refs) process.stdout.write(`  ok  ${ref}\n`);

	// Agents without a `model:` resolve through the configured default, so an
	// empty ref list must not be mistaken for a working setup: with no default
	// and no credentials, every stage would fail at its first prompt.
	const { workspace, agentDir } = resolveContext(args);
	const pinnedAll = registry.list().every((agent) => agent.modelRef !== undefined);
	if (!pinnedAll) {
		const fallback = flagString(args, "model", "m") ?? readRunDefaults(workspace, agentDir).modelRef;
		if (fallback !== undefined) {
			await preflightModels(modelRuntime, [fallback]);
			process.stdout.write(`  ok  ${fallback} (default for unpinned agents)\n`);
		} else if ((await modelRuntime.getAvailable()).length === 0) {
			throw new PreflightError(
				"No model is available. Some agents do not pin a `model:`, no default is " +
					"configured, and no provider has usable credentials.\n" +
					"Run `pi auth login <provider>`, or set defaultProvider/defaultModel in " +
					"~/.pi/agent/settings.json.",
			);
		}
	}

	process.stdout.write("All agents resolve to an available model.\n");
	return 0;
}

async function commandIngest(args: ParsedArgs): Promise<number> {
	const { workspace } = resolveContext(args);
	const targets = args.positionals.length > 0 ? args.positionals : [path.join(workspace, "corpus")];
	const outDir = path.resolve(flagString(args, "out") ?? path.join(workspace, "corpus", "text"));

	const inputs = collectCorpusInputs(targets.map((t) => path.resolve(workspace, t)));
	if (inputs.length === 0) {
		process.stderr.write(`No .pdf, .md, .txt, or .tex files found in ${targets.join(", ")}\n`);
		return 2;
	}

	const result = await ingestCorpus({
		inputs,
		outDir,
		force: flagBoolean(args, "force"),
		onProgress: (file) => {
			const label = path.basename(file.sourcePath);
			if (file.status === "failed") {
				process.stderr.write(`  fail  ${label}: ${file.error}\n`);
			} else {
				const pages = file.totalPages !== undefined ? ` (${file.totalPages}p)` : "";
				process.stdout.write(`  ${file.status.padEnd(9)} ${label}${pages}\n`);
			}
		},
	});

	process.stdout.write(
		`\n${result.succeeded} document(s) ready in ${outDir}` +
			(result.failed > 0 ? `, ${result.failed} failed\n` : "\n"),
	);
	return result.failed > 0 ? 1 : 0;
}

async function commandRunAgent(args: ParsedArgs): Promise<number> {
	const { workspace, agentDir } = resolveContext(args);
	const [name] = args.positionals;
	if (name === undefined) {
		process.stderr.write("run-agent requires an agent name.\n");
		return 2;
	}

	const agent = loadRegistry(args).get(name);
	const task = await resolveTask(args, workspace);

	const defaults = readRunDefaults(workspace, agentDir);
	const overrideModel = flagString(args, "model", "m");
	const modelRef = agent.modelRef ?? overrideModel ?? defaults.modelRef;

	const modelRuntime = await ModelRuntime.create();
	if (modelRef !== undefined) {
		await preflightModels(modelRuntime, [modelRef]);
	}

	const sessionDir = flagString(args, "session-dir");
	const quiet = flagBoolean(args, "quiet");
	const controller = new AbortController();
	const onSigint = (): void => controller.abort();
	process.on("SIGINT", onSigint);

	try {
		const result = await runStage({
			agent,
			prompt: task,
			cwd: workspace,
			agentDir,
			modelRuntime,
			signal: controller.signal,
			...(modelRef !== undefined ? { defaultModelRef: modelRef } : {}),
			...(defaults.thinking !== undefined ? { defaultThinking: defaults.thinking } : {}),
			...(sessionDir !== undefined ? { sessionDir: path.resolve(sessionDir) } : {}),
			onEvent: (event) => {
				if (event.type === "text" && !quiet) process.stdout.write(event.delta);
				else if (event.type === "warn") process.stderr.write(`\nwarning: ${event.message}\n`);
				else if (event.type === "steer") process.stderr.write("\n[turn budget: wrapping up]\n");
			},
		});

		process.stdout.write(`\n\n${formatSummary(result)}\n`);
		if (result.error !== undefined) {
			process.stderr.write(`${result.error.code}: ${result.error.message}\n`);
		}
		return result.status === "completed" ? 0 : 1;
	} finally {
		process.off("SIGINT", onSigint);
	}
}

async function resolveTask(args: ParsedArgs, workspace: string): Promise<string> {
	const inline = flagString(args, "task");
	if (inline !== undefined) return inline;

	const input = flagString(args, "input");
	if (input === undefined) {
		throw new UsageError("run-agent requires --task <text> or --input <file>.");
	}

	const resolved = path.resolve(workspace, input);
	const body = await fsp.readFile(resolved, "utf-8");
	return `Work on the document at ${path.relative(workspace, resolved) || resolved}.\n\n${body}`;
}

function formatSummary(result: Awaited<ReturnType<typeof runStage>>): string {
	const { usage } = result;
	return [
		`status   ${result.status}`,
		`turns    ${result.turns}${result.softWarned ? " (steered)" : ""}`,
		`tokens   in ${usage.input} · out ${usage.output} · cacheR ${usage.cacheRead} · cacheW ${usage.cacheWrite}`,
		`cost     $${usage.cost.toFixed(4)}`,
		`elapsed  ${(result.durationMs / 1000).toFixed(1)}s`,
		result.retries > 0 ? `retries  ${result.retries}` : undefined,
		result.compactions > 0 ? `compact  ${result.compactions}` : undefined,
		result.sessionFile !== undefined ? `session  ${result.sessionFile}` : undefined,
	]
		.filter((line): line is string => line !== undefined)
		.join("\n");
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	if (error instanceof ScribariumError) {
		process.stderr.write(`${error.message}\n`);
		process.exitCode = error.exitCode;
	} else {
		process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
		process.exitCode = 1;
	}
}
