import * as fs from "node:fs";
import * as path from "node:path";

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
			return fromGlob(source.pattern, workspace);
		case "json":
			return fromJson(source.file, source.path, workspace);
		case "items":
			return source.values.map((value, index) => toItem(value, index));
	}
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

/** Filesystem-safe id. Matches how ingest names extracted documents. */
function slug(value: string): string {
	const cleaned = value
		.normalize("NFKD")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return cleaned.length > 0 ? cleaned : "item";
}
