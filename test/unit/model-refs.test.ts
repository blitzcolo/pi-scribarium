import { describe, expect, it } from "vitest";

import { parseAgentFile } from "../../src/agents/parse.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { collectModelRefs } from "../../src/cli/commands/run-shared.js";
import { parsePipeline } from "../../src/pipeline/load.js";

const FILE = "/pipelines/paper.yaml";

function registry(...agents: Array<{ name: string; model?: string }>): AgentRegistry {
	return AgentRegistry.fromDefinitions(
		agents.map(({ name, model }) =>
			parseAgentFile(
				`---\nname: ${name}\ndescription: ${name} agent\n` +
					`${model === undefined ? "" : `model: ${model}\n`}---\n\nBody.\n`,
				`/agents/${name}.md`,
				"shipped",
			),
		),
	);
}

describe("collectModelRefs", () => {
	// The regression this exists for: `run` filtered on `kind === "agent"` and so
	// preflighted nothing a fan-out used, while `resume` checked both. A fan-out is
	// where a wrong model costs the most — the shipped pipeline runs its two
	// fan-outs on a different provider from everything else, so a missing key got
	// past preflight and surfaced only after ingest, once per item.
	it("covers fan-out steps, not just plain agent steps", () => {
		const source = `
vars:
  bulk: cheap/fast
  judgement: smart/slow
steps:
  - id: analyze
    agent: analyst
    model: \${vars.bulk}
    foreach: "corpus/text/*.md"
    input: Analyse \${item.path}.
    output: analysis/\${item.id}.md
  - id: profile
    agent: profiler
    model: \${vars.judgement}
    output: analysis/profile.md
`;
		const spec = parsePipeline(source, FILE, registry({ name: "analyst" }, { name: "profiler" }));

		expect(collectModelRefs(spec, registry({ name: "analyst" }, { name: "profiler" })).sort()).toEqual([
			"cheap/fast",
			"smart/slow",
		]);
	});

	it("prefers the agent's own pin, then the step, then the run-wide fallback", () => {
		const source = `
steps:
  - id: pinned
    agent: pinned-agent
    model: step/model
    output: a.md
  - id: from-step
    agent: plain
    model: step/model
    output: b.md
  - id: from-fallback
    agent: plain
    output: c.md
`;
		const agents = () => registry({ name: "pinned-agent", model: "agent/pinned" }, { name: "plain" });
		const spec = parsePipeline(source, FILE, agents());

		expect(collectModelRefs(spec, agents(), "fallback/model").sort()).toEqual([
			"agent/pinned",
			"fallback/model",
			"step/model",
		]);
	});

	it("skips builtin and gate steps, which need no model", () => {
		const source = `
steps:
  - id: ingest
    builtin: ingest
    with:
      from: corpus
  - id: approve
    gate: Approve
`;
		const spec = parsePipeline(source, FILE, registry());
		expect(collectModelRefs(spec, registry(), "fallback/model")).toEqual([]);
	});
});
