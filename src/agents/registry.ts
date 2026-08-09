import { UnknownAgentError } from "../util/errors.js";
import { discoverAgents, type Diagnostic, type DiscoverOptions, type DiscoverResult } from "./discover.js";
import type { AgentDefinition } from "./types.js";

/** Name-indexed view over the discovered agent definitions. */
export class AgentRegistry {
	private readonly byName: ReadonlyMap<string, AgentDefinition>;

	private constructor(
		agents: readonly AgentDefinition[],
		readonly diagnostics: readonly Diagnostic[],
		readonly searched: DiscoverResult["searched"],
	) {
		this.byName = new Map(agents.map((agent) => [agent.name, agent]));
	}

	static load(options: DiscoverOptions): AgentRegistry {
		const { agents, diagnostics, searched } = discoverAgents(options);
		return new AgentRegistry(agents, diagnostics, searched);
	}

	static fromDefinitions(agents: readonly AgentDefinition[]): AgentRegistry {
		return new AgentRegistry(agents, [], []);
	}

	/** @throws {UnknownAgentError} with near-miss suggestions. */
	get(name: string): AgentDefinition {
		const found = this.byName.get(name);
		if (found === undefined) throw new UnknownAgentError(name, this.names());
		return found;
	}

	has(name: string): boolean {
		return this.byName.has(name);
	}

	list(): readonly AgentDefinition[] {
		return [...this.byName.values()];
	}

	names(): readonly string[] {
		return [...this.byName.keys()];
	}

	/** Distinct model references across all agents, for a single preflight pass. */
	modelRefs(): readonly string[] {
		const refs = new Set<string>();
		for (const agent of this.byName.values()) {
			if (agent.modelRef !== undefined) refs.add(agent.modelRef);
		}
		return [...refs];
	}
}
