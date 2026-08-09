import * as fs from "node:fs";
import * as path from "node:path";

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

import { AgentDefinitionError } from "../util/errors.js";
import { parseAgentFile } from "./parse.js";
import { shippedAgentsDir } from "./shipped.js";

export { shippedAgentsDir } from "./shipped.js";
import type { AgentDefinition, AgentSource } from "./types.js";

export interface Diagnostic {
	filePath: string;
	message: string;
}

export interface DiscoverOptions {
	/** Workspace root; `<workspace>/.scribarium/agents` wins over everything. */
	workspaceDir?: string;
	/** Directory to search upward from for a project-level `.pi/agents`. */
	cwd: string;
	/** pi's global config dir. Defaults to `getAgentDir()`. */
	agentDir?: string;
	/** Include the definitions bundled with this package. Default: true. */
	includeShipped?: boolean;
}

export interface DiscoverResult {
	agents: AgentDefinition[];
	/** Files that could not be loaded. Discovery never throws for these. */
	diagnostics: Diagnostic[];
	/** The directories actually searched, in precedence order (lowest first). */
	searched: Array<{ dir: string; source: AgentSource }>;
}

/**
 * Walk upward from `cwd` looking for the nearest `.pi/agents` directory, the
 * same way pi's own subagent example locates project agents.
 */
export function findProjectAgentsDir(cwd: string): string | null {
	let current = path.resolve(cwd);
	for (;;) {
		const candidate = path.join(current, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

/**
 * Discover agent definitions from every known location.
 *
 * Precedence, lowest to highest: shipped -> pi user -> pi project -> workspace.
 * A later definition with the same `name` replaces an earlier one, matching
 * pi's own dedupe-by-name behaviour.
 *
 * Individual bad files become diagnostics rather than exceptions, so one broken
 * file in a shared `~/.pi/agent/agents` cannot take the whole tool down.
 */
export function discoverAgents(options: DiscoverOptions): DiscoverResult {
	const agentDir = options.agentDir ?? getAgentDir();
	const searched: Array<{ dir: string; source: AgentSource }> = [];

	if (options.includeShipped !== false) {
		searched.push({ dir: shippedAgentsDir(), source: "shipped" });
	}
	searched.push({ dir: path.join(agentDir, "agents"), source: "user" });

	const projectDir = findProjectAgentsDir(options.cwd);
	if (projectDir !== null) searched.push({ dir: projectDir, source: "project" });

	if (options.workspaceDir !== undefined) {
		searched.push({
			dir: path.join(options.workspaceDir, ".scribarium", "agents"),
			source: "workspace",
		});
	}

	const byName = new Map<string, AgentDefinition>();
	const diagnostics: Diagnostic[] = [];

	for (const { dir, source } of searched) {
		for (const { definition, diagnostic } of loadDirectory(dir, source)) {
			if (diagnostic !== undefined) diagnostics.push(diagnostic);
			if (definition !== undefined) byName.set(definition.name, definition);
		}
	}

	const agents = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
	return { agents, diagnostics, searched };
}

function* loadDirectory(
	dir: string,
	source: AgentSource,
): Generator<{ definition?: AgentDefinition; diagnostic?: Diagnostic }> {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return; // missing or unreadable directory is not an error
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch (cause) {
			yield { diagnostic: { filePath, message: `could not be read: ${String(cause)}` } };
			continue;
		}

		try {
			yield { definition: parseAgentFile(content, filePath, source) };
		} catch (error) {
			yield {
				diagnostic: {
					filePath,
					message: error instanceof AgentDefinitionError ? error.message : String(error),
				},
			};
		}
	}
}

function isDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}
