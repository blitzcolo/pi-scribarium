import { describe, expect, it } from "vitest";

import { parseAgentFile } from "../../src/agents/parse.js";
import { AgentRegistry } from "../../src/agents/registry.js";
import { parsePipeline, placeholders } from "../../src/pipeline/load.js";

const FILE = "/pipelines/paper.yaml";

function registry(...names: string[]): AgentRegistry {
	return AgentRegistry.fromDefinitions(
		names.map((name) =>
			parseAgentFile(
				`---\nname: ${name}\ndescription: ${name} agent\n---\n\nBody for ${name}.\n`,
				`/agents/${name}.md`,
				"shipped",
			),
		),
	);
}

const MINIMAL = `
name: demo
steps:
  - id: outline
    agent: outliner
    input: Write an outline for \${vars.topic}.
    output: outline/outline.md
`;

describe("parsePipeline", () => {
	it("parses a minimal sequential pipeline", () => {
		const spec = parsePipeline(`vars:\n  topic: emulation\n${MINIMAL}`, FILE, registry("outliner"));

		expect(spec.name).toBe("demo");
		expect(spec.vars["topic"]).toBe("emulation");
		expect(spec.steps).toHaveLength(1);
		expect(spec.steps[0]?.kind).toBe("agent");
		expect(spec.steps[0]?.outputs).toEqual(["outline/outline.md"]);
		// The verbatim source is retained so the run can freeze it for resume.
		expect(spec.source).toContain("id: outline");
	});

	it("applies defaults to agent steps and lets a step override them", () => {
		const spec = parsePipeline(
			`
defaults:
  model: provider/base
  max_turns: 10
steps:
  - id: a
    agent: outliner
  - id: b
    agent: outliner
    model: provider/special
    max_turns: 3
`,
			FILE,
			registry("outliner"),
		);

		expect(spec.steps[0]).toMatchObject({ model: "provider/base", maxTurns: 10 });
		expect(spec.steps[1]).toMatchObject({ model: "provider/special", maxTurns: 3 });
	});

	it("parses builtin steps with their options", () => {
		const spec = parsePipeline(
			`
steps:
  - id: ingest
    builtin: ingest
    with:
      from: corpus
    output: corpus/text
`,
			FILE,
		);

		expect(spec.steps[0]).toMatchObject({
			kind: "builtin",
			run: "ingest",
			with: { from: "corpus" },
		});
	});

	describe("diagnostics", () => {
		it("reports a YAML syntax error with a position", () => {
			expect(() => parsePipeline("steps:\n  - id: a\n   bad indent\n", FILE)).toThrow(
				new RegExp(`${FILE.replace(/\//g, "\\/")}:\\d+:\\d+`),
			);
		});

		it("names an unknown agent and lists what is available", () => {
			expect(() => parsePipeline(MINIMAL, FILE, registry("reviewer"))).toThrow(
				/unknown agent "outliner"[\s\S]*Known agents: reviewer/,
			);
		});

		it("rejects a duplicate step id", () => {
			const source = `
steps:
  - id: dup
    agent: outliner
  - id: dup
    agent: outliner
`;
			expect(() => parsePipeline(source, FILE, registry("outliner"))).toThrow(
				/duplicate step id "dup"/,
			);
		});

		it("rejects an unknown step key rather than ignoring it", () => {
			const source = `
steps:
  - id: a
    agent: outliner
    tools: read
`;
			expect(() => parsePipeline(source, FILE, registry("outliner"))).toThrow(
				/unknown step key "tools"/,
			);
		});

		it("requires exactly one of agent or builtin", () => {
			expect(() => parsePipeline("steps:\n  - id: a\n", FILE)).toThrow(
				/must set exactly one of "agent" or "builtin"/,
			);
			expect(() =>
				parsePipeline(
					"steps:\n  - id: a\n    agent: outliner\n    builtin: ingest\n",
					FILE,
					registry("outliner"),
				),
			).toThrow(/exactly one/);
		});

		it("rejects a step that is both a gate and an agent", () => {
			const source = "steps:\n  - id: a\n    agent: outliner\n    gate: Approve\n    output: x.md\n";
			// `gate` wins the shape check, so the stray `agent` is the giveaway that
			// the author meant two separate steps.
			expect(() => parsePipeline(source, FILE, registry("outliner"))).not.toThrow();
		});

		it("rejects a placeholder that will never resolve", () => {
			const source = `
steps:
  - id: a
    agent: outliner
    input: Use \${vars.missing} please.
`;
			expect(() => parsePipeline(source, FILE, registry("outliner"))).toThrow(
				/references \$\{vars\.missing\}, which is not in scope/,
			);
		});

		it("allows referencing an earlier step's outputs but not a later one's", () => {
			const ok = `
steps:
  - id: first
    agent: outliner
    output: a.md
  - id: second
    agent: outliner
    input: Read \${steps.first.outputs}.
`;
			expect(() => parsePipeline(ok, FILE, registry("outliner"))).not.toThrow();

			const backwards = `
steps:
  - id: first
    agent: outliner
    input: Read \${steps.second.outputs}.
  - id: second
    agent: outliner
`;
			expect(() => parsePipeline(backwards, FILE, registry("outliner"))).toThrow(/not in scope/);
		});

		it("rejects an unsupported pipeline version", () => {
			expect(() => parsePipeline("version: 99\nsteps: []\n", FILE)).toThrow(
				/unsupported pipeline version 99/,
			);
		});

		it("requires a non-empty steps list", () => {
			expect(() => parsePipeline("name: x\n", FILE)).toThrow(/non-empty "steps" list/);
		});

		it("rejects a malformed step id", () => {
			expect(() =>
				parsePipeline("steps:\n  - id: Bad_Id\n    agent: outliner\n", FILE, registry("outliner")),
			).toThrow(/lowercase and hyphenated/);
		});
	});
});

describe("placeholders", () => {
	it("extracts every reference", () => {
		expect(placeholders("a ${vars.x} b ${output} c")).toEqual(["vars.x", "output"]);
		expect(placeholders("none here")).toEqual([]);
	});
});

describe("model roles", () => {
	const source = `
vars:
  bulk: ""
  judgement: ""
steps:
  - id: cheap
    agent: outliner
    model: \${vars.bulk}
  - id: careful
    agent: outliner
    model: \${vars.judgement}
`;

	// A pipeline names a role, not a provider, so the same file runs on whatever
	// the reader has configured.
	it("leaves an empty role unset so the session default applies", () => {
		const spec = parsePipeline(source, FILE, registry("outliner"));
		for (const step of spec.steps) {
			expect("model" in step ? step.model : undefined).toBeUndefined();
		}
	});

	it("resolves a role from vars, including --var overrides", () => {
		const spec = parsePipeline(source, FILE, registry("outliner"), {
			bulk: "deepseek/deepseek-v4-flash",
			judgement: "kimi-coding/k3-256k",
		});
		expect(spec.steps[0]).toMatchObject({ model: "deepseek/deepseek-v4-flash" });
		expect(spec.steps[1]).toMatchObject({ model: "kimi-coding/k3-256k" });
	});

	it("rejects a model role that is not a defined var", () => {
		expect(() =>
			parsePipeline(
				"vars:\n  a: x\nsteps:\n  - id: s\n    agent: outliner\n    model: ${vars.nope}\n",
				FILE,
				registry("outliner"),
			),
		).toThrow(/"model" may only reference \$\{vars\.\*\}.*is not defined/s);
	});
});

describe("foreach steps", () => {
	const base = (extra: string) => `
steps:
  - id: analyze
    agent: outliner
    foreach: "corpus/text/*.md"
    output: analysis/\${item.id}.md
${extra}
`;

	it("parses a glob fan-out with defaults", () => {
		const spec = parsePipeline(base(""), FILE, registry("outliner"));
		expect(spec.steps[0]).toMatchObject({
			kind: "foreach",
			source: { kind: "glob", pattern: "corpus/text/*.md" },
			concurrency: 4,
		});
	});

	it("parses json and inline item sources", () => {
		const json = parsePipeline(
			`steps:\n  - id: w\n    agent: outliner\n    foreach:\n      json: outline/sections.json\n      path: sections\n    output: draft/\${item.id}.md\n`,
			FILE,
			registry("outliner"),
		);
		expect(json.steps[0]).toMatchObject({
			source: { kind: "json", file: "outline/sections.json", path: "sections" },
		});

		const inline = parsePipeline(
			`steps:\n  - id: w\n    agent: outliner\n    foreach:\n      items: [{id: a}, {id: b}]\n    output: x/\${item.id}.md\n`,
			FILE,
			registry("outliner"),
		);
		expect(inline.steps[0]).toMatchObject({ source: { kind: "items" } });
	});

	// "Every declared output is newer than its source" is vacuously true when
	// nothing is declared, so this would report every item cached and run none.
	it("refuses cache on a step that declares no output", () => {
		expect(() =>
			parsePipeline(
				`steps:\n  - id: w\n    agent: outliner\n    foreach: "corpus/text/*.md"\n    cache: true\n`,
				FILE,
				registry("outliner"),
			),
		).toThrow(/cache requires at least one output/);
	});

	it("honours parallel and max_failures, and caps concurrency", () => {
		const spec = parsePipeline(base("    parallel: 6\n    max_failures: 2"), FILE, registry("outliner"));
		expect(spec.steps[0]).toMatchObject({ concurrency: 6, maxFailures: 2 });

		expect(() => parsePipeline(base("    parallel: 99"), FILE, registry("outliner"))).toThrow(
			/parallel is capped at 8/,
		);
	});

	// Without an ${item.*} reference every item writes the same path and N
	// concurrent sessions race on one file, last writer winning, silently.
	it("refuses a fan-out output that every item would share", () => {
		const source = `
steps:
  - id: analyze
    agent: outliner
    foreach: "corpus/*.md"
    output: analysis/all.md
`;
		expect(() => parsePipeline(source, FILE, registry("outliner"))).toThrow(
			/a foreach output must reference \$\{item\.\*\}/,
		);
	});

	it("allows ${item.*} inside a fan-out but not in a plain agent step", () => {
		expect(() =>
			parsePipeline(base("    input: Analyse \${item.path}."), FILE, registry("outliner")),
		).not.toThrow();

		const plain = `
steps:
  - id: a
    agent: outliner
    input: Analyse \${item.path}.
`;
		expect(() => parsePipeline(plain, FILE, registry("outliner"))).toThrow(/not in scope/);
	});
});
