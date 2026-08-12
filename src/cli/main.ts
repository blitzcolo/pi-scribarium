#!/usr/bin/env node
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { commandDecide } from "./commands/decide.js";
import { commandEvents, commandReport, commandStatus } from "./commands/inspect.js";
import { commandInit } from "./commands/init.js";
import { commandRedo } from "./commands/redo.js";
import { collectCorpusInputs, formatPageRanges, ingestCorpus } from "../ingest/pdf.js";
import { PreflightError, ScribariumError, UsageError } from "../util/errors.js";
import { assertDepthAllowed } from "../util/safety.js";
import { VERSION } from "../version.js";
import {
	flagAll,
	keepIds,
	flagBoolean,
	flagsMissingValues,
	flagString,
	parseArgs,
	type ParsedArgs,
} from "./args.js";
// Type-only: erased at compile time, so it costs nothing at runtime.
import type { RunStageResult } from "../runtime/run-stage.js";

/**
 * Anything reaching the pi SDK is imported at the point of use, never here.
 *
 * The SDK is ~20 000 files. Resolving them costs about 0.4 s on a local disk
 * and, measured on a WSL2 9p mount, over twenty — and a top-level import makes
 * every command pay it, including `--help`. Roughly half the command surface
 * (init, status, report, events, redo, ingest, approve, reject) touches no
 * model at all and now loads none of it.
 *
 * The rule is mechanical: if a module transitively imports
 * `@earendil-works/pi-coding-agent`, reach it through `await import(...)` inside
 * the branch that needs it. `test/integration/cli-startup.test.ts` fails if a
 * static import creeps back in.
 */

const HELP = `scribarium ${VERSION} — multi-agent orchestration for academic writing

Usage: scribarium <command> [options]

Commands:
  init <dir>                Scaffold a workspace for one paper
  run [pipeline]            Run a pipeline end to end
  resume [runId]            Continue a run that stopped at a gate or a failure
  redo <step> [runId]       Re-open a finished step (and everything after it)
  approve [runId] [step]    Approve a pending gate (--keep to prune its list first)
  reject  [runId] [step]    Reject a gate and regenerate (-m "what to change")
  status [runId]            Where a run got to (defaults to the latest run)
  report [runId]            Token and cost accounting per step
  events [runId]            Append-only log of what happened
  agents                    List discovered agent definitions
  validate                  Check every agent's model reference and credentials
  ingest [paths...]         Extract text from corpus/, references/, source/
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

approve options:
  --keep <id,id>            Keep only these entries of the gate's list and delete
                            the rest (repeatable). Only for a gate with select:.

reject options:
  -m, --message <text>      Feedback folded into the regenerated step's prompt
  --target <stepId>         Regenerate this step instead of the gate's on_reject

Exit codes: 0 ok · 1 failed · 2 usage/config · 3 preflight · 10 awaiting gate · 130 interrupted

status / report options:
  --json                    Machine-readable output

ingest options:
  --out <dir>               Output directory; only with explicit paths
  --force                   Re-extract even when the output is current

  With no paths, every input directory is extracted to its own text/ subdir.
  source/ extracts PDFs only — its text files are read where they are.

run-agent options:
  --input <file>            File whose contents become the task prompt
  --task <text>             Task prompt given inline
  --session-dir <dir>       Persist the session transcript as JSONL
  --quiet                   Do not stream assistant text to stdout
`;

/**
 * Exit quietly when the reader goes away.
 *
 * `scribarium agents | head`, or quitting a pager, closes stdout while we are
 * still writing to it. Node surfaces that as an unhandled EPIPE and crashes with
 * a stack trace, which looks like a failure of the command rather than the
 * normal end of a pipeline.
 */
function ignoreBrokenPipe(): void {
	for (const stream of [process.stdout, process.stderr]) {
		stream.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "EPIPE") process.exit(0);
			throw error;
		});
	}
}

/** Every flag that takes a value, so one given without one is an error. */
const VALUE_FLAGS = [
	"agent-dir",
	"gate-mode",
	"input",
	"keep",
	"m",
	"message",
	"model",
	"out",
	"session-dir",
	"target",
	"task",
	"var",
	"w",
	"workspace",
];

async function main(argv: readonly string[]): Promise<number> {
	const args = parseArgs(argv);

	// A value flag with nothing after it parses as boolean true, and flagString
	// then reports it as absent — so `run --workspace` silently ran against the
	// current directory rather than saying the flag was empty.
	const empty = flagsMissingValues(args, ...VALUE_FLAGS);
	if (empty.length > 0) {
		throw new UsageError(`${empty.map((name) => `--${name}`).join(", ")} needs a value.`);
	}

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
			const { workspace, agentDir } = await resolveContext(args);
			const pipeline = args.positionals[0];
			const modelOverride = flagString(args, "model", "m");
			const gateMode = requireGateMode(flagString(args, "gate-mode"));
			const { commandRun } = await import("./commands/run.js");
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
			const { workspace, agentDir } = await resolveContext(args);
			const runId = args.positionals[0];
			const modelOverride = flagString(args, "model", "m");
			const gateMode = requireGateMode(flagString(args, "gate-mode"));
			const { commandResume } = await import("./commands/resume.js");
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
			const stepId = args.positionals[0];
			if (stepId === undefined) throw new UsageError("redo requires a step id.");
			const runId = args.positionals[1];
			const feedback = flagString(args, "message", "m");
			return commandRedo({
				workspace: resolveWorkspace(args),
				stepId,
				...(runId !== undefined ? { runId } : {}),
				...(feedback !== undefined ? { feedback } : {}),
			});
		}
		case "approve": {
			const keep = parseKeepFlags(args);
			return commandDecide(resolveWorkspace(args), args.positionals[0], args.positionals[1], {
				kind: "approve",
				...(keep !== undefined ? { keep } : {}),
			});
		}
		case "reject": {
			const feedback = flagString(args, "message", "m");
			if (feedback === undefined) {
				throw new UsageError('reject requires -m "what to change".');
			}
			const target = flagString(args, "target");
			return commandDecide(resolveWorkspace(args), args.positionals[0], args.positionals[1], {
				kind: "reject",
				feedback,
				...(target !== undefined ? { target } : {}),
			});
		}
		case "status":
			return commandStatus(resolveWorkspace(args), args.positionals[0], flagBoolean(args, "json"));
		case "report":
		case "cost":
			return commandReport(resolveWorkspace(args), args.positionals[0], flagBoolean(args, "json"));
		case "events":
			return commandEvents(resolveWorkspace(args), args.positionals[0]);
		case "agents":
			return await commandAgents(args);
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

/**
 * `--keep` given with nothing usable behind it is a mistake worth stopping on:
 * both readings are wrong. "Keep everything" approves the list the reviewer was
 * cutting down, and "keep nothing" deletes all of it.
 */
function parseKeepFlags(args: ParsedArgs): string[] | undefined {
	const ids = keepIds(args);
	if (ids !== undefined && ids.length === 0) {
		throw new UsageError(
			"--keep expects one or more ids, e.g. --keep ip-1,ip-3. Omit it to approve everything.",
		);
	}
	return ids;
}

/** Pure path resolution — no SDK, so the cheap commands stay cheap. */
/**
 * An unknown `--gate-mode` used to fall through to TTY autodetection, so
 * `--gate-mode=fiel` blocked on an interactive prompt in a run its author
 * intended to be unattended.
 */
function requireGateMode(mode: string | undefined): string | undefined {
	if (mode === undefined || mode === "file" || mode === "interactive") return mode;
	throw new UsageError(`Unknown --gate-mode "${mode}". Use "file" or "interactive".`);
}

function resolveWorkspace(args: ParsedArgs): string {
	return path.resolve(flagString(args, "workspace", "w") ?? process.cwd());
}

/**
 * pi's config directory.
 *
 * `getAgentDir()` is a one-line function, but it reads pi's own notion of where
 * its config lives, and reimplementing that here would silently diverge the day
 * upstream changes it. So it is loaded lazily instead of copied — an explicit
 * `--agent-dir` skips the import entirely.
 */
async function resolveAgentDir(args: ParsedArgs): Promise<string> {
	const explicit = flagString(args, "agent-dir");
	if (explicit !== undefined) return explicit;
	const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
	return getAgentDir();
}

async function resolveContext(args: ParsedArgs): Promise<{ workspace: string; agentDir: string }> {
	return { workspace: resolveWorkspace(args), agentDir: await resolveAgentDir(args) };
}

async function loadRegistry(args: ParsedArgs) {
	const { workspace, agentDir } = await resolveContext(args);
	const { AgentRegistry } = await import("../agents/registry.js");
	return AgentRegistry.load({ cwd: workspace, workspaceDir: workspace, agentDir });
}

async function commandAgents(args: ParsedArgs): Promise<number> {
	const registry = await loadRegistry(args);
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
	const registry = await loadRegistry(args);

	for (const diagnostic of registry.diagnostics) {
		process.stderr.write(`error: ${diagnostic.filePath}: ${diagnostic.message}\n`);
	}
	if (registry.diagnostics.length > 0) return 2;

	const refs = registry.modelRefs();
	process.stdout.write(
		`Loaded ${registry.list().length} agent(s); checking ${refs.length} pinned model reference(s).\n`,
	);

	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { preflightModels } = await import("../runtime/model.js");
	const modelRuntime = await ModelRuntime.create();
	await preflightModels(modelRuntime, refs);
	for (const ref of refs) process.stdout.write(`  ok  ${ref}\n`);

	// Agents without a `model:` resolve through the configured default, so an
	// empty ref list must not be mistaken for a working setup: with no default
	// and no credentials, every stage would fail at its first prompt.
	const { workspace, agentDir } = await resolveContext(args);
	const pinnedAll = registry.list().every((agent) => agent.modelRef !== undefined);
	if (!pinnedAll) {
		const { readRunDefaults } = await import("../runtime/defaults.js");
		const fallback = flagString(args, "model", "m") ?? readRunDefaults(workspace, agentDir).modelRef;
		if (fallback !== undefined) {
			await preflightModels(modelRuntime, [fallback]);
			process.stdout.write(`  ok  ${fallback} (default for unpinned agents)\n`);
		} else if ((await modelRuntime.getAvailable()).length === 0) {
			throw new PreflightError(
				"No model is available. Some agents do not pin a `model:`, no default is " +
					"configured, and no provider has usable credentials.\n" +
					"Set a provider API key (environment variable, or ~/.pi/agent/auth.json) and " +
					"give ~/.pi/agent/settings.json a defaultProvider and defaultModel.",
			);
		}
	}

	process.stdout.write("All agents resolve to an available model.\n");
	return 0;
}

/**
 * Named directories, mirroring the shipped pipeline's ingest steps.
 *
 * `source/` extracts PDFs only: its text files are already readable where they
 * are, and copying them into `source/text/` would show a writing agent the same
 * material twice.
 */
const WORKSPACE_INGESTS: ReadonlyArray<{
	dir: string;
	only?: ReadonlySet<string>;
	required: boolean;
}> = [
	{ dir: "corpus", required: true },
	{ dir: "references", required: false },
	{ dir: "source", only: new Set([".pdf"]), required: false },
];

async function commandIngest(args: ParsedArgs): Promise<number> {
	// Ingest is deterministic and model-free, so it must not drag the SDK in.
	const workspace = resolveWorkspace(args);
	const force = flagBoolean(args, "force");

	const explicit = args.positionals.length > 0;
	const targets = explicit
		? [
				{
					inputs: collectCorpusInputs(
						args.positionals.map((t) => path.resolve(workspace, t)),
					),
					outDir: path.resolve(workspace, flagString(args, "out") ?? path.join(workspace, "corpus", "text")),
					label: args.positionals.join(", "),
					required: true,
				},
			]
		: WORKSPACE_INGESTS.map((entry) => ({
				inputs: collectCorpusInputs([path.join(workspace, entry.dir)], entry.only),
				outDir: path.join(workspace, entry.dir, "text"),
				label: `${entry.dir}/`,
				required: entry.required,
			}));

	let failed = 0;
	let ingested = 0;

	for (const target of targets) {
		if (target.inputs.length === 0) {
			if (target.required) {
				process.stderr.write(`No .pdf, .md, .txt, or .tex files found in ${target.label}\n`);
				return 2;
			}
			continue;
		}

		if (targets.length > 1) process.stdout.write(`${target.label}\n`);

		const result = await ingestCorpus({
			inputs: target.inputs,
			outDir: target.outDir,
			force,
			onProgress: (file) => {
				const label = path.basename(file.sourcePath);
				if (file.status === "failed") {
					process.stderr.write(`  fail  ${label}: ${file.error}\n`);
					return;
				}
				const pages = file.totalPages !== undefined ? ` (${file.totalPages}p` : "";
				// A full-page figure looks exactly like a scanned page, so this is
				// a note rather than a warning — but the pages an analysis will be
				// blind to should not be discoverable only by opening the output.
				const gaps =
					file.textlessPages !== undefined && file.textlessPages.length > 0
						? `, no text on p${formatPageRanges(file.textlessPages)}`
						: "";
				process.stdout.write(
					`  ${file.status.padEnd(9)} ${label}${pages}${pages === "" ? "" : `${gaps})`}\n`,
				);
			},
		});

		failed += result.failed;
		ingested += result.succeeded;
		if (targets.length > 1) {
			process.stdout.write(`  -> ${result.succeeded} in ${path.relative(workspace, target.outDir)}\n`);
		}
	}

	process.stdout.write(
		`\n${ingested} document(s) ready` + (failed > 0 ? `, ${failed} failed\n` : "\n"),
	);
	return failed > 0 ? 1 : 0;
}

async function commandRunAgent(args: ParsedArgs): Promise<number> {
	const [name] = args.positionals;
	if (name === undefined) {
		process.stderr.write("run-agent requires an agent name.\n");
		return 2;
	}

	const { workspace, agentDir } = await resolveContext(args);
	const agent = (await loadRegistry(args)).get(name);
	const task = await resolveTask(args, workspace);

	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const { readRunDefaults } = await import("../runtime/defaults.js");
	const { preflightModels } = await import("../runtime/model.js");
	const { runStage } = await import("../runtime/run-stage.js");

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

function formatSummary(result: RunStageResult): string {
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

ignoreBrokenPipe();

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
