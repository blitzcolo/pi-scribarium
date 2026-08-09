#!/usr/bin/env node
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";

import { AgentRegistry } from "../agents/registry.js";
import { collectCorpusInputs, ingestCorpus } from "../ingest/pdf.js";
import { preflightModels } from "../runtime/model.js";
import { runStage } from "../runtime/run-stage.js";
import { PreflightError, ScribariumError, UsageError } from "../util/errors.js";
import { VERSION } from "../version.js";
import { flagBoolean, flagString, parseArgs, type ParsedArgs } from "./args.js";

const HELP = `scholarly ${VERSION} — multi-agent orchestration for academic writing

Usage: scholarly <command> [options]

Commands:
  agents                    List discovered agent definitions
  validate                  Check every agent's model reference and credentials
  ingest <paths...>         Convert a PDF/text corpus to Markdown
  run-agent <name>          Run a single agent to completion
  help, version

Common options:
  --workspace <dir>         Workspace root (default: cwd)
  --agent-dir <dir>         pi config dir (default: ~/.pi/agent)

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
	const command = args.command ?? (flagBoolean(args, "version", "v") ? "version" : "help");

	switch (command) {
		case "help":
			process.stdout.write(HELP);
			return 0;
		case "version":
			process.stdout.write(`${VERSION}\n`);
			return 0;
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

	// Agents without a `model:` fall back to whatever model the session picks,
	// so an empty ref list must not be mistaken for a working setup: with no
	// credentials at all, every stage would fail at its first prompt.
	const pinnedAll = registry.list().every((agent) => agent.modelRef !== undefined);
	if (!pinnedAll) {
		const available = await modelRuntime.getAvailable();
		if (available.length === 0) {
			throw new PreflightError(
				"No model is available. Some agents do not pin a `model:` and would fall back " +
					"to the session default, but no provider has usable credentials.\n" +
					"Run `pi auth login <provider>`, or set the provider's API key.",
			);
		}
		process.stdout.write(`  ok  ${available.length} model(s) available for unpinned agents\n`);
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
		process.stderr.write(`No .pdf, .md, or .txt files found in ${targets.join(", ")}\n`);
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

	const modelRuntime = await ModelRuntime.create();
	if (agent.modelRef !== undefined) {
		await preflightModels(modelRuntime, [agent.modelRef]);
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
