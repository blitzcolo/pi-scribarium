import * as fs from "node:fs";
import * as path from "node:path";

import type { GateDecisionRecord } from "../gates/types.js";
import type { StageErrorCode, StageUsage } from "../runtime/run-stage.js";
import { ScribariumError } from "../util/errors.js";
import { redactSecrets } from "../util/safety.js";
import type { RunLayout } from "./layout.js";

export const RUN_STATE_VERSION = 1;

export type RunStatus = "running" | "awaiting_gate" | "completed" | "failed" | "aborted";
export type StepStatus =
	| "pending"
	| "running"
	| "completed"
	| "failed"
	| "skipped"
	| "awaiting";

export interface StepError {
	code: StageErrorCode | "MISSING_OUTPUT" | "BUILTIN_ERROR";
	message: string;
}

export interface StepState {
	type: string;
	status: StepStatus;
	attempts: number;
	startedAt?: string;
	endedAt?: string;
	/** Artifact paths, relative to the run's artifacts dir. */
	outputs: string[];
	turns?: number;
	usage?: StageUsage;
	model?: string;
	sessionFile?: string;
	error?: StepError;
	/** Populated for fan-out steps. */
	items?: Record<string, { status: StepStatus; outputs?: string[]; error?: StepError }>;
	/** Gate steps: every decision taken, in order. */
	decisions?: GateDecisionRecord[];
	/** Feedback to fold into the next run of this step, set by a rejection. */
	pendingFeedback?: string;
}

export interface RunState {
	schemaVersion: number;
	runId: string;
	workspace: string;
	pipelinePath: string;
	pipelineHash: string;
	createdAt: string;
	updatedAt: string;
	status: RunStatus;
	vars: Record<string, string>;
	cursor: { stepIndex: number; stepId?: string };
	steps: Record<string, StepState>;
	usageTotal: StageUsage;
}

export function emptyUsage(): StageUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 };
}

export function addUsage(target: StageUsage, delta: StageUsage): StageUsage {
	return {
		input: target.input + delta.input,
		output: target.output + delta.output,
		cacheRead: target.cacheRead + delta.cacheRead,
		cacheWrite: target.cacheWrite + delta.cacheWrite,
		total: target.total + delta.total,
		cost: target.cost + delta.cost,
	};
}

export class RunStateError extends ScribariumError {
	readonly exitCode = 2;
}

/**
 * The resumable checkpoint.
 *
 * `status.json` is rewritten in full at every boundary rather than appended to,
 * because resume needs one coherent snapshot, not a log to replay. Writes go to
 * a temp file in the same directory and are then renamed, so a process killed
 * mid-write leaves the previous complete state rather than a truncated file —
 * `rename` is atomic within a filesystem, `writeFile` is not.
 *
 * The append-only narrative lives in `events.jsonl` instead.
 */
export class RunStateStore {
	constructor(readonly layout: RunLayout) {}

	static create(layout: RunLayout, init: Omit<RunState, "schemaVersion" | "updatedAt">): RunState {
		const state: RunState = { schemaVersion: RUN_STATE_VERSION, updatedAt: init.createdAt, ...init };
		new RunStateStore(layout).save(state);
		return state;
	}

	save(state: RunState): void {
		state.updatedAt = new Date().toISOString();
		const target = this.layout.statusFile;
		fs.mkdirSync(path.dirname(target), { recursive: true });

		// Same directory, so the rename cannot cross a filesystem boundary.
		const temp = `${target}.${process.pid}.tmp`;
		fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
		fs.renameSync(temp, target);
	}

	load(): RunState {
		let raw: string;
		try {
			raw = fs.readFileSync(this.layout.statusFile, "utf-8");
		} catch {
			throw new RunStateError(
				`No run state at ${this.layout.statusFile}. Check the run id, or start a new run.`,
			);
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (cause) {
			throw new RunStateError(`Run state at ${this.layout.statusFile} is not valid JSON: ${String(cause)}`);
		}

		const state = parsed as RunState;
		if (state.schemaVersion !== RUN_STATE_VERSION) {
			throw new RunStateError(
				`Run ${state.runId} was written by an incompatible version ` +
					`(schema ${state.schemaVersion}, expected ${RUN_STATE_VERSION}).`,
			);
		}
		return state;
	}

	exists(): boolean {
		return fs.existsSync(this.layout.statusFile);
	}
}

/** One line of the append-only audit log. */
export interface RunEvent {
	at: string;
	type: string;
	[key: string]: unknown;
}

/**
 * Append-only run log.
 *
 * Separate from `status.json` on purpose: the checkpoint answers "where do I
 * resume", the log answers "what happened, in order". Appends are line-atomic
 * for the sizes involved, so a killed process truncates at most the final line,
 * and readers can skip unparseable trailing lines.
 */
export class EventLog {
	constructor(private readonly file: string) {}

	append(type: string, fields: Record<string, unknown> = {}): void {
		const entry: RunEvent = { at: new Date().toISOString(), type, ...fields };
		try {
			fs.mkdirSync(path.dirname(this.file), { recursive: true });
			// Redacted here rather than at each call site: the log is what users
			// paste into issues, and a provider error can quote the request.
			fs.appendFileSync(this.file, `${redactSecrets(JSON.stringify(entry))}\n`, "utf-8");
		} catch {
			// The audit log must never take a run down.
		}
	}

	read(): RunEvent[] {
		let raw: string;
		try {
			raw = fs.readFileSync(this.file, "utf-8");
		} catch {
			return [];
		}
		const events: RunEvent[] = [];
		for (const line of raw.split("\n")) {
			if (line.trim().length === 0) continue;
			try {
				events.push(JSON.parse(line) as RunEvent);
			} catch {
				// A partial final line from a killed process; ignore it.
			}
		}
		return events;
	}
}
