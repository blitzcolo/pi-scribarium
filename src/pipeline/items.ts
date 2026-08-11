import * as fs from "node:fs";
import * as path from "node:path";

import { slug } from "../util/slug.js";
import { PipelineError } from "./load.js";
import type { ForeachItem, ForeachSource } from "./schema.js";

/**
 * Resolve a fan-out source into concrete items.
 *
 * Every item carries a stable `id` used for its artifact path, its log file, and
 * its entry in `status.json`. Ids must be stable across runs or resume could not
 * tell which items had already completed.
 */
export function resolveItems(source: ForeachSource, workspace: string): ForeachItem[] {
	switch (source.kind) {
		case "glob":
			return assertDistinctIds(fromGlob(source.pattern, workspace));
		case "json":
			return assertDistinctIds(fromJson(source.file, source.path, workspace));
		case "items":
			return assertDistinctIds(source.values.map((value, index) => toItem(value, index)));
	}
}

/**
 * Refuse a fan-out whose items share an id.
 *
 * The loader already rejects an output that does not mention `${item.*}`,
 * because otherwise every item writes one path and N concurrent sessions race on
 * it. Two items with the same id reintroduce exactly that race, and quietly: the
 * id is slugged from a filename stem, so `a/x.md` and `b/x.md`, or `Smith 2020.md`
 * beside `smith-2020.md`, collide. Only one survives in `status.json`, and on
 * resume the loser looks already done.
 *
 * Refusing beats disambiguating. A generated suffix depends on iteration order,
 * so adding one file would silently rebind every later id — and ids have to be
 * stable across runs or neither resume nor `cache:` can match an output to its
 * source.
 */
function assertDistinctIds(items: ForeachItem[]): ForeachItem[] {
	const seen = new Map<string, ForeachItem>();
	for (const item of items) {
		const first = seen.get(item.id);
		if (first !== undefined) {
			throw new PipelineError(
				`Fan-out items collide on id "${item.id}": ${describe(first)} and ${describe(item)} ` +
					`would write the same output path and race on it. Rename one, or give the ` +
					`items explicit distinct ids.`,
			);
		}
		seen.set(item.id, item);
	}
	return items;
}

function describe(item: ForeachItem): string {
	return item.path ?? `item ${item.index + 1}`;
}

function fromGlob(pattern: string, workspace: string): ForeachItem[] {
	// Sorted so item order — and therefore ids — do not depend on directory
	// iteration order, which varies between filesystems.
	const matches = fs
		.globSync(pattern, { cwd: workspace })
		.map((match) => match.replaceAll("\\", "/"))
		.sort();

	return matches.map((relativePath, index) => {
		const stem = path.basename(relativePath, path.extname(relativePath));
		return { id: slug(stem), index, path: relativePath, stem };
	});
}

function fromJson(file: string, jsonPath: string | undefined, workspace: string): ForeachItem[] {
	const resolved = path.resolve(workspace, file);
	let parsed: unknown;
	try {
		parsed = JSON.parse(fs.readFileSync(resolved, "utf-8"));
	} catch (cause) {
		throw new PipelineError(`Cannot read fan-out items from ${resolved}: ${String(cause)}`);
	}

	let value: unknown = parsed;
	if (jsonPath !== undefined) {
		for (const key of jsonPath.split(".").filter((k) => k.length > 0)) {
			value = (value as Record<string, unknown> | undefined)?.[key];
		}
	}

	if (!Array.isArray(value)) {
		throw new PipelineError(
			`Fan-out source ${file}${jsonPath === undefined ? "" : ` (path "${jsonPath}")`} ` +
				"must be a JSON array",
		);
	}
	return value.map((entry, index) => toItem(entry as Record<string, unknown>, index));
}

function toItem(value: Record<string, unknown> | string | number, index: number): ForeachItem {
	if (typeof value === "string" || typeof value === "number") {
		return { id: slug(String(value)), index, stem: String(value) };
	}
	const explicit = value["id"];
	const id = typeof explicit === "string" && explicit.length > 0 ? slug(explicit) : `item-${index + 1}`;
	return { ...value, id, index };
}
