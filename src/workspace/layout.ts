import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { ScribariumError } from "../util/errors.js";

/**
 * Workspace and run directory layout.
 *
 * ```
 * <workspace>/
 *   corpus/                     source documents
 *   corpus/text/                ingested Markdown
 *   analysis/ outline/ draft/   artifacts the agents produce
 *   .scribarium/agents/*.md     workspace-local agent overrides
 *   runs/
 *     latest -> 20260809T183000-3f2a
 *     20260809T183000-3f2a/
 *       pipeline.yaml           frozen copy of the spec used for this run
 *       status.json             resumable checkpoint
 *       events.jsonl            append-only audit log
 *       logs/<stepId>.md        per-step prompt and final text
 *       sessions/*.jsonl        pi session transcripts
 *       attempts/               artifacts superseded by a re-run (M3)
 * ```
 *
 * Artifacts live in the workspace, not under the run directory: a workspace is
 * one paper being worked on, so `draft/intro.md` means the same file across
 * runs. The run directory holds only what is genuinely per-run.
 */
export class RunLayout {
	readonly runDir: string;

	constructor(
		readonly workspace: string,
		readonly runId: string,
	) {
		this.runDir = path.join(workspace, "runs", runId);
	}

	get statusFile(): string {
		return path.join(this.runDir, "status.json");
	}
	get eventsFile(): string {
		return path.join(this.runDir, "events.jsonl");
	}
	get pipelineCopy(): string {
		return path.join(this.runDir, "pipeline.yaml");
	}
	/**
	 * Archive of superseded artifacts, written when a step is re-run (M3).
	 * Live artifacts stay in the workspace, not here.
	 */
	get attemptsDir(): string {
		return path.join(this.runDir, "attempts");
	}
	get sessionsDir(): string {
		return path.join(this.runDir, "sessions");
	}
	get logsDir(): string {
		return path.join(this.runDir, "logs");
	}

	/**
	 * Absolute path for a declared artifact, e.g. `analysis/paper.md`.
	 *
	 * Artifacts live in the **workspace**, not under the run directory. A
	 * workspace is one paper being worked on, so `draft/intro.md` should mean the
	 * same file across runs — that is what makes iterating, and reading a
	 * previous run's output, natural. Stages therefore run with the workspace as
	 * cwd, which also lets a prompt say `corpus/text/x.md` and `analysis/x.md`
	 * without either path climbing out of a run directory. The run directory
	 * keeps what is genuinely per-run: status, events, logs, sessions, and
	 * superseded attempts.
	 */
	artifact(relativePath: string): string {
		return contain(this.workspace, relativePath, "artifact");
	}

	logFile(stepId: string, itemId?: string): string {
		const name = itemId === undefined ? `${stepId}.md` : `${stepId}.${itemId}.md`;
		return path.join(this.logsDir, name);
	}

	ensure(): void {
		for (const dir of [this.runDir, this.sessionsDir, this.logsDir]) {
			fs.mkdirSync(dir, { recursive: true });
		}
	}

	/**
	 * Point `runs/latest` at this run. Best-effort: symlinks are unavailable to
	 * unprivileged users on some Windows setups, and a missing convenience link
	 * must never fail a run.
	 */
	markLatest(): void {
		const link = path.join(this.workspace, "runs", "latest");
		try {
			fs.rmSync(link, { force: true, recursive: false });
			fs.symlinkSync(this.runId, link, "junction");
		} catch {
			try {
				fs.writeFileSync(path.join(this.workspace, "runs", "latest.txt"), `${this.runId}\n`);
			} catch {
				// Nothing more to do; `status` falls back to scanning the runs dir.
			}
		}
	}
}

/**
 * Resolve a declared path, refusing anything that leaves the workspace.
 *
 * `path.join` *normalizes* `..` rather than rejecting it, and not every path
 * reaching here is a literal from the pipeline file: a fan-out over a JSON items
 * source spreads arbitrary fields into the template scope, and only `item.id` is
 * slugged. So `output: draft/${item.stem}.md` with a stem of `../../../tmp/x`
 * wrote outside the workspace, with mkdirSync(recursive) obligingly creating the
 * path to get there. An absolute value escapes outright.
 *
 * The tool allowlist is the containment for what an *agent* does (CLAUDE.md
 * gotcha #19); this is the containment for what the orchestrator itself writes.
 */
export function contain(workspace: string, relativePath: string, what: string): string {
	const resolved = path.resolve(workspace, relativePath);
	const root = path.resolve(workspace);
	if (resolved !== root && !resolved.startsWith(root + path.sep)) {
		throw new WorkspaceEscapeError(
			`Refusing to use ${what} path "${relativePath}": it resolves to ${resolved}, ` +
				`outside the workspace ${root}.`,
		);
	}
	return resolved;
}

export class WorkspaceEscapeError extends ScribariumError {
	readonly exitCode = 2;
}

/** Sortable, collision-resistant run id: `20260809T183000-3f2a`. */
export function newRunId(now: Date = new Date()): string {
	const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
	return `${stamp}-${crypto.randomBytes(2).toString("hex")}`;
}

/** Most recent run id in a workspace, or undefined if there are none. */
export function findLatestRun(workspace: string): string | undefined {
	const runsDir = path.join(workspace, "runs");
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(runsDir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	return entries
		.filter((entry) => entry.isDirectory() && /^\d{8}T\d{6}-[0-9a-f]{4}$/.test(entry.name))
		.map((entry) => entry.name)
		.sort()
		.pop();
}

/** Stable identity for a pipeline file, so resume can detect drift. */
export function hashPipeline(source: string): string {
	return `sha256:${crypto.createHash("sha256").update(source, "utf8").digest("hex").slice(0, 16)}`;
}
