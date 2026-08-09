import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Workspace and run directory layout.
 *
 * ```
 * <workspace>/
 *   corpus/                     source documents
 *   corpus/text/                ingested Markdown
 *   .scribarium/agents/*.md     workspace-local agent overrides
 *   runs/
 *     latest -> 20260809T183000-3f2a
 *     20260809T183000-3f2a/
 *       pipeline.yaml           frozen copy of the spec used for this run
 *       status.json             resumable checkpoint
 *       events.jsonl            append-only audit log
 *       logs/<stepId>.md        per-step prompt and final text
 *       sessions/*.jsonl        pi session transcripts
 *       artifacts/              everything the agents produced
 * ```
 *
 * Artifacts live under the run directory rather than the workspace root so that
 * two runs never overwrite each other, and so a run can be inspected or deleted
 * as one unit.
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
	get artifactsDir(): string {
		return path.join(this.runDir, "artifacts");
	}
	get sessionsDir(): string {
		return path.join(this.runDir, "sessions");
	}
	get logsDir(): string {
		return path.join(this.runDir, "logs");
	}

	/** Absolute path for a declared artifact, e.g. `analysis/paper.md`. */
	artifact(relativePath: string): string {
		return path.join(this.artifactsDir, relativePath);
	}

	logFile(stepId: string, itemId?: string): string {
		const name = itemId === undefined ? `${stepId}.md` : `${stepId}.${itemId}.md`;
		return path.join(this.logsDir, name);
	}

	ensure(): void {
		for (const dir of [this.runDir, this.artifactsDir, this.sessionsDir, this.logsDir]) {
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
