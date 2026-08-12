import * as fs from "node:fs";

import { archiveAttempt } from "./regenerate.js";
import type { GateSelectSpec } from "../pipeline/schema.js";
import { ScribariumError } from "../util/errors.js";
import { slug } from "../util/slug.js";
import type { RunLayout } from "../workspace/layout.js";

/**
 * Pruning a gate's list.
 *
 * The reviewer keeps a subset and the rest are deleted before the run
 * continues. Deliberately deterministic: dropping entries from a JSON array by
 * id is not judgement, and handing it to a model would cost money, take time,
 * and put the surviving entries at risk of being reworded on the way through.
 * The same reasoning keeps searching and downloading in builtins rather than
 * agents.
 *
 * Reading is best-effort and writing is strict. A malformed list must still let
 * the reviewer reject — the gate is exactly where a bad artifact should be
 * catchable — but it must never be silently half-filtered.
 */

export interface SelectableItem {
	id: string;
	/** First human-readable field found, for the terminal listing. */
	label?: string;
}

/**
 * A keep list that cannot be applied.
 *
 * Exit code 2 — this is a usage error, not a failed stage: the reviewer typed
 * something the list does not contain, and the fix is to type it again.
 */
export class KeepError extends ScribariumError {
	readonly exitCode = 2;
}

/**
 * List what a gate's `select:` points at, for display.
 *
 * Returns nothing rather than throwing when the file is missing or malformed:
 * the reviewer still needs the gate to open so they can look at it and reject.
 */
export function readSelectable(absoluteFile: string, jsonPath?: string): SelectableItem[] {
	let array: unknown[];
	try {
		array = locateArray(JSON.parse(fs.readFileSync(absoluteFile, "utf-8")), jsonPath);
	} catch {
		return [];
	}

	const items: SelectableItem[] = [];
	for (const entry of array) {
		const id = idOf(entry);
		if (id === undefined) continue;
		const label = labelOf(entry);
		items.push({ id, ...(label !== undefined ? { label } : {}) });
	}
	return items;
}

export interface ApplyKeepOptions {
	layout: RunLayout;
	stepId: string;
	select: GateSelectSpec;
	/** Interpolated path of the list file, relative to the workspace. */
	relativeFile: string;
	/** Ids the reviewer chose to keep. */
	keep: readonly string[];
	/** Gate attempt number, so the archive lands beside other superseded work. */
	attempt: number;
}

export interface KeepResult {
	kept: string[];
	dropped: string[];
	/** Absolute path the unfiltered list was archived to, when anything changed. */
	archivedTo?: string;
}

/**
 * Rewrite the list to the kept entries, archiving the original first.
 *
 * Order comes from the file, never from the order the reviewer typed: the ids
 * end up as fan-out item ids and artifact paths, and a list whose order depended
 * on how someone typed a comma-separated flag would produce a different prompt
 * from the same decision.
 */
export function applyKeep(options: ApplyKeepOptions): KeepResult {
	const { layout, relativeFile, select, keep } = options;
	const absolute = layout.artifact(relativeFile);

	let document: unknown;
	try {
		document = JSON.parse(fs.readFileSync(absolute, "utf-8"));
	} catch (cause) {
		throw new KeepError(`Cannot read the list to prune at ${relativeFile}: ${String(cause)}`);
	}

	let array: unknown[];
	try {
		array = locateArray(document, select.path);
	} catch (cause) {
		throw new KeepError(String(cause instanceof Error ? cause.message : cause));
	}

	// Every entry needs an id, not just the kept ones: without one there is no way
	// to say "keep this", so silently dropping it would delete work the reviewer
	// was never offered the chance to save.
	const anonymous = array.filter((entry) => idOf(entry) === undefined).length;
	if (anonymous > 0) {
		throw new KeepError(
			`${relativeFile} has ${anonymous} entr${anonymous === 1 ? "y" : "ies"} without a string ` +
				`"id", so they cannot be selected by id. Prune this file by hand instead.`,
		);
	}

	// Ids are matched the way the fan-out will slug them, so two that fold together
	// would make "keep this one" ambiguous — and would be refused a step later by
	// the fan-out's own distinct-id check anyway.
	const byKey = new Map<string, string>();
	for (const entry of array) {
		const id = idOf(entry) as string;
		const key = normalize(id);
		const first = byKey.get(key);
		if (first !== undefined) {
			throw new KeepError(
				`${relativeFile} has two entries whose ids are indistinguishable once slugged: ` +
					`"${first}" and "${id}" both become "${key}". Rename one.`,
			);
		}
		byKey.set(key, id);
	}

	const requested = new Set<string>();
	const unknown: string[] = [];
	for (const raw of keep) {
		// Slugging an empty string yields the fallback id, so blanks are dropped
		// before normalization rather than after — `--keep ip-1,` must not be a typo
		// for some unrelated entry.
		if (raw.trim() === "") continue;
		const key = normalize(raw);
		if (!byKey.has(key)) {
			unknown.push(raw);
			continue;
		}
		requested.add(key);
	}

	if (unknown.length > 0) {
		// Listing what is available is the whole point: a typo that silently kept
		// nothing would drop every candidate the reviewer meant to save.
		const available = array.map((entry) => idOf(entry) as string).join(", ");
		throw new KeepError(
			`Unknown id${unknown.length === 1 ? "" : "s"} ${unknown.map((u) => `"${u}"`).join(", ")} ` +
				`in ${relativeFile}. Available: ${available}`,
		);
	}

	if (requested.size === 0) {
		throw new KeepError(
			`Keeping nothing would leave the run with an empty list at ${relativeFile}. ` +
				`Reject the gate to regenerate, or quit.`,
		);
	}

	const kept = array.filter((entry) => requested.has(normalize(idOf(entry) as string)));
	const dropped = array
		.filter((entry) => !requested.has(normalize(idOf(entry) as string)))
		.map((entry) => idOf(entry) as string);

	if (dropped.length === 0) {
		return { kept: kept.map((entry) => idOf(entry) as string), dropped: [] };
	}

	// Archived before the overwrite, for the same reason a rejected step's output
	// is: a decision made once should not be the only copy of the work it discards.
	const [archived] = archiveAttempt(layout, options.stepId, [relativeFile], options.attempt);

	writeArray(absolute, document, select.path, kept);

	return {
		kept: kept.map((entry) => idOf(entry) as string),
		dropped,
		...(archived !== undefined ? { archivedTo: archived.archivedTo } : {}),
	};
}

/** Ids are compared the way the fan-out will slug them, so `IP-1` matches `ip-1`. */
function normalize(id: string): string {
	return slug(id.trim());
}

function locateArray(document: unknown, jsonPath: string | undefined): unknown[] {
	let value = document;
	for (const key of segments(jsonPath)) {
		value = (value as Record<string, unknown> | undefined)?.[key];
	}
	if (!Array.isArray(value)) {
		throw new Error(
			`Expected a JSON array${jsonPath === undefined ? "" : ` at path "${jsonPath}"`}`,
		);
	}
	return value;
}

function writeArray(
	absolute: string,
	document: unknown,
	jsonPath: string | undefined,
	value: unknown[],
): void {
	const keys = segments(jsonPath);
	let next: unknown = document;

	if (keys.length === 0) {
		next = value;
	} else {
		let parent = document as Record<string, unknown>;
		for (const key of keys.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
		// Sibling keys are preserved: the file may carry a version, a direction, or
		// anything else a later step reads.
		parent[keys[keys.length - 1] as string] = value;
	}

	fs.writeFileSync(absolute, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

function segments(jsonPath: string | undefined): string[] {
	return jsonPath === undefined ? [] : jsonPath.split(".").filter((key) => key.length > 0);
}

function idOf(entry: unknown): string | undefined {
	if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
	const id = (entry as Record<string, unknown>)["id"];
	return typeof id === "string" && id.trim().length > 0 ? id.trim() : undefined;
}

function labelOf(entry: unknown): string | undefined {
	const record = entry as Record<string, unknown>;
	for (const key of ["title", "name", "summary"]) {
		const value = record[key];
		if (typeof value === "string" && value.trim().length > 0) return value.trim();
	}
	return undefined;
}
