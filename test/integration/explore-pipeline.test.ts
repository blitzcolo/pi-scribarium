import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AgentRegistry } from "../../src/agents/registry.js";
import { initialRunState, runPipeline } from "../../src/pipeline/engine.js";
import { loadPipeline } from "../../src/pipeline/load.js";
import { shippedPipelinesDir } from "../../src/agents/shipped.js";
import { hashPipeline, newRunId, RunLayout } from "../../src/workspace/layout.js";
import { RunStateStore, type RunState } from "../../src/workspace/run-state.js";
import { bodyPage, minimalPdf } from "../helpers/minimal-pdf.js";
import { scriptedFetcher, type ScriptedRoute } from "../helpers/scripted-fetch.js";
import {
	createScriptedRuntime,
	SCRIPTED_MODEL_REF,
	type Script,
	type ScriptContext,
	type ScriptStep,
} from "../helpers/scripted-provider.js";

/**
 * The shipped explore pipeline, run end to end against scripted models and
 * scripted HTTP.
 *
 * Everything but the two wires is real: the gates, the fan-outs, the mtime
 * cache, the builtins writing and reading each other's files, PDF extraction.
 * That is the point — the parts of this pipeline most likely to be wrong are
 * the seams between stages, and mocking a stage would hide exactly those.
 */

let root: string;
let workspace: string;
let agentDir: string;
let layout: RunLayout;
let registry: AgentRegistry;

const NAME = "demo";
const DIR = `explore/${NAME}`;

beforeEach(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "scribarium-explore-"));
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "pi-agent");
	fs.mkdirSync(path.join(workspace, "source"), { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	layout = new RunLayout(workspace, newRunId());
	layout.ensure();

	fs.writeFileSync(
		path.join(workspace, "source", "our-work.pdf"),
		minimalPdf([bodyPage("Our prior work on thermal-visible registration, with a 4k-image dataset.")]),
	);

	// The real shipped agent definitions, so a prompt or tool-list mistake in
	// agents/*.md fails here rather than on a paid run.
	registry = AgentRegistry.load({ cwd: os.tmpdir(), agentDir: os.tmpdir() });
});

afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------- fixtures

const CANDIDATES = {
	candidates: [
		{
			id: "ip-1",
			title: "Cross-modal alignment without paired annotations",
			rationale: "Builds on our registration work.",
			queries: ["cross modal alignment without pairs"],
		},
		{
			id: "ip-2",
			title: "Nighttime detection under fog",
			rationale: "Uses our thermal dataset.",
			queries: ["nighttime detection fog thermal"],
		},
	],
};

function s2(papers: Array<Record<string, unknown>>): string {
	return JSON.stringify({ data: papers });
}

const EMPTY_ARXIV = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>';
const EMPTY_OPENALEX = JSON.stringify({ results: [] });

/** Passes the PDF magic check and the size floor, and extracts to real text. */
function paperPdf(text: string): Uint8Array {
	const pdf = minimalPdf([bodyPage(text)]);
	// The fetch builtin refuses anything under min_pdf_bytes as an interstitial.
	return pdf.byteLength >= 10_000
		? pdf
		: new Uint8Array([...pdf, ...new Uint8Array(10_000 - pdf.byteLength)]);
}

const ROUTES: ScriptedRoute[] = [
	{ match: "export.arxiv.org", body: EMPTY_ARXIV },
	{ match: "api.openalex.org", body: EMPTY_OPENALEX },
	{
		// Round 1: one open-access paper and one behind a paywall.
		match: (url) => url.includes("api.semanticscholar.org") && url.includes("paper/search"),
		body: s2([
			{
				paperId: "s2-open",
				title: "Unpaired Cross-Modal Alignment",
				year: 2023,
				venue: "CVPR",
				citationCount: 120,
				abstract: "We align modalities without paired supervision.",
				externalIds: { DOI: "10.1/open" },
				authors: [{ name: "Ada Lovelace" }],
				openAccessPdf: { url: "https://example.org/open.pdf" },
			},
			{
				paperId: "s2-closed",
				title: "Detection In Fog",
				year: 2022,
				venue: "ICCV",
				citationCount: 60,
				abstract: "A study of detection under fog, behind a paywall.",
				externalIds: { DOI: "10.1/closed" },
				authors: [{ name: "Grace Hopper" }],
			},
		]),
	},
	{
		// Round 2: the follow-up reference, looked up by DOI.
		match: (url) => url.includes("api.semanticscholar.org") && url.includes("paper/DOI"),
		body: JSON.stringify({
			paperId: "s2-followup",
			title: "The Foundational Alignment Paper",
			year: 2019,
			venue: "NeurIPS",
			citationCount: 900,
			abstract: "The method everyone extends.",
			externalIds: { DOI: "10.5/foundational" },
			authors: [{ name: "Alan Turing" }],
			openAccessPdf: { url: "https://example.org/foundational.pdf" },
		}),
	},
	{ match: "example.org/open.pdf", body: paperPdf("Unpaired alignment. We do not handle fog.") },
	{ match: "example.org/foundational.pdf", body: paperPdf("The foundational alignment method.") },
];

/**
 * One script driving every agent in the pipeline, dispatching on the prompt.
 *
 * Matching on the task text rather than on a turn counter keeps the script
 * stable when steps are reordered, and makes each branch readable as "what this
 * stage is expected to produce".
 */
function script(): { run: Script; analysed: string[] } {
	const answered = new Set<string>();
	/** Every paper the model was actually asked to analyse, including repeats. */
	const analysed: string[] = [];

	const run = (ctx: ScriptContext): ScriptStep => {
		const task = ctx.lastUserText;
		const write = (file: string, content: string): ScriptStep => ({
			toolCalls: [{ name: "write", args: { path: file, content } }],
		});

		// Each stage writes once, then reports done on its next turn. Keyed on the
		// task rather than on `ctx.turn`, which counts across the whole run — one
		// runtime serves every stage — and would have made every stage after the
		// first report done without writing anything.
		if (answered.has(task)) return { text: "done" };
		answered.add(task);

		if (task.includes("Propose 5-10 candidate")) {
			return {
				toolCalls: [
					{ name: "write", args: { path: `${DIR}/candidates.md`, content: "# Candidates\n\nip-1, ip-2\n" } },
					{ name: "write", args: { path: `${DIR}/candidates.json`, content: JSON.stringify(CANDIDATES) } },
					{ name: "write", args: { path: `${DIR}/assets.md`, content: "A 4k thermal-visible dataset and a registration method.\n" } },
				],
			};
		}

		if (task.includes("Probe each candidate")) {
			return write(
				`${DIR}/queries.json`,
				JSON.stringify({
					version: 1,
					queries: [
						{ kind: "query", point: "ip-1", query: "cross modal alignment without pairs" },
						{ kind: "query", point: "ip-2", query: "nighttime detection fog thermal" },
					],
				}),
			);
		}

		if (task.includes("Analyse the paper at")) {
			const stem = /refs\/text\/(.+?)\.md/.exec(task)?.[1] ?? "unknown";
			analysed.push(stem);
			const abstractOnly = stem.includes("hopper");
			return write(
				`${DIR}/cards/${stem}.md`,
				[
					"---",
					`title: Card for ${stem}`,
					"year: 2023",
					"venue: CVPR",
					"citation_count: 120",
					`evidence_level: ${abstractOnly ? "abstract_only" : "full_text"}`,
					`related_points: [${abstractOnly ? "ip-2" : "ip-1"}]`,
					"followups:",
					...(abstractOnly
						? []
						: [
								'  - { title: "The Foundational Alignment Paper", doi: "10.5/foundational", reason: "the method being extended" }',
							]),
					"---",
					"",
					"## Problem setting & method",
					"Alignment under stated conditions.",
					"",
					"## Overlap with our candidates",
					"### ip-1",
					"- **Covers:** the unpaired case.",
					"- **Does not cover:** fog; the authors state they do not handle it.",
				].join("\n"),
			);
		}

		if (task.includes("Your evidence packet")) {
			const point = /Candidate (ip-\d+)/.exec(task)?.[1] ?? "ip-1";
			return write(
				`${DIR}/verdicts/${point}.md`,
				`---\nverdict: partially-done\nconfidence: medium\n---\n\n## Prior work\n\nFor ${point}.\n`,
			);
		}

		if (task.includes("Rank the candidates")) {
			return write(`${DIR}/report.md`, "# Report\n\nip-1 recommended.\n");
		}

		return { text: "unrecognised task" };
	};

	return { run, analysed };
}

async function run(
	options: { autoApprove?: boolean; state?: RunState; routes?: readonly ScriptedRoute[] } = {},
) {
	const source = fs.readFileSync(path.join(shippedPipelinesDir(), "explore.yaml"), "utf-8");
	const spec = loadPipeline(path.join(shippedPipelinesDir(), "explore.yaml"), registry, {
		name: NAME,
		direction: "红外与可见光融合的弱监督检测",
		bulk: SCRIPTED_MODEL_REF,
		judgement: SCRIPTED_MODEL_REF,
	});
	const driver = script();
	const scripted = await createScriptedRuntime(agentDir, driver.run);
	const { fetch, requests } = scriptedFetcher(options.routes ?? ROUTES);

	const state =
		options.state ??
		RunStateStore.create(layout, initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }));

	/**
	 * Peak simultaneously-running sessions, per step.
	 *
	 * An item is in flight from its first stage event until the fan-out reports it
	 * settled. Counting through the public event stream rather than by
	 * instrumenting the pool measures what a user is actually billed for.
	 */
	const active = new Map<string, Set<string>>();
	const peak = new Map<string, number>();
	const mark = (stepId: string, itemId: string, starting: boolean): void => {
		const live = active.get(stepId) ?? new Set<string>();
		active.set(stepId, live);
		if (starting) live.add(itemId);
		else live.delete(itemId);
		peak.set(stepId, Math.max(peak.get(stepId) ?? 0, live.size));
	};

	const final = await runPipeline({
		spec,
		layout,
		state,
		registry,
		modelRuntime: scripted.runtime,
		agentDir,
		fetcher: fetch,
		gate: async () => ({ kind: "approve" }),
		onEvent: (event) => {
			if (event.type === "stage" && event.itemId !== undefined) {
				mark(event.stepId, event.itemId, true);
			}
			if (event.type === "fanout_progress") mark(event.stepId, event.itemId, false);
		},
	});

	return { final, requests, scripted, analysed: driver.analysed, peak };
}

const read = (relative: string) => fs.readFileSync(path.join(workspace, relative), "utf-8");
const exists = (relative: string) => fs.existsSync(path.join(workspace, relative));

describe("the shipped explore pipeline", () => {
	it("runs end to end from a direction to a ranked report", async () => {
		const { final } = await run();

		// Name the failing step and its error: "expected completed, got failed"
		// over a nineteen-step pipeline is not a debuggable assertion.
		const failures = Object.entries(final.steps)
			.filter(([, step]) => step.status === "failed")
			.map(([id, step]) => `${id}: ${step.error?.code} ${step.error?.message}`);
		expect(failures).toEqual([]);
		expect(final.status).toBe("completed");
		for (const [id, step] of Object.entries(final.steps)) {
			expect([id, step.status]).toEqual([id, expect.stringMatching(/completed|skipped/)]);
		}

		expect(exists(`${DIR}/report.md`)).toBe(true);
		expect(read(`${DIR}/report.md`)).toContain("ip-1 recommended");
	});

	// The paywalled paper must still reach the corpus, labelled — a gap would
	// read to the judge as "nothing published on this".
	it("carries an abstract-only paper through as a labelled stub", async () => {
		await run();

		const stub = read(`${DIR}/refs/hopper-2022-detection-in-fog.md`);
		expect(stub).toContain("ABSTRACT ONLY");
		expect(exists(`${DIR}/refs/hopper-2022-detection-in-fog.pdf`)).toBe(false);
		// It was extracted like any other document, so the fan-out saw one corpus.
		expect(exists(`${DIR}/refs/text/hopper-2022-detection-in-fog.md`)).toBe(true);
	});

	it("chases a follow-up reference in round two and analyses only the new paper", async () => {
		const { analysed } = await run();

		// Round 2 found the reference the analyst named, by DOI.
		const round2 = JSON.parse(read(`${DIR}/results-round2.json`)) as { papers: unknown[] };
		expect(round2.papers).toHaveLength(1);
		expect(read(`${DIR}/followups.md`)).toContain("The Foundational Alignment Paper");
		expect(exists(`${DIR}/cards/turing-2019-the-foundational-alignment-paper.md`)).toBe(true);

		// The second pass re-globs the whole directory, but round one's cards are
		// newer than their sources, so `cache: true` skips them: every paper is
		// analysed exactly once across both rounds. Without this the second round
		// would silently re-pay for the first.
		expect(analysed).toHaveLength(3);
		expect(new Set(analysed).size).toBe(3);
	});

	it("writes an evidence packet per candidate, including the coverage counts", async () => {
		await run();

		const packet = read(`${DIR}/evidence/ip-1.md`);
		expect(packet).toContain("# Evidence for ip-1");
		expect(packet).toContain("read in full text");
		expect(packet).toContain("Do not open the full papers");

		// ip-2's only evidence was the abstract-only paper.
		expect(read(`${DIR}/evidence/ip-2.md`)).toContain("from the abstract only");
	});

	it("merges the verdicts and keeps every candidate in the report input", async () => {
		await run();

		const merged = read(`${DIR}/verdicts-merged.md`);
		expect(merged).toContain("For ip-1");
		expect(merged).toContain("For ip-2");
	});

	// The tool allowlist is the only containment this project has, so the
	// negative case is worth asserting directly.
	it("touches the network only from the search and fetch stages", async () => {
		const { requests } = await run();

		expect(requests.length).toBeGreaterThan(0);
		for (const url of requests) {
			expect(url).toMatch(/arxiv\.org|semanticscholar\.org|openalex\.org|example\.org/);
		}
	});

	// A hundred papers must not mean a hundred live sessions. The pool bounds it
	// at the step's `parallel:`, under a hard ceiling of 8 — otherwise a large
	// corpus would open sessions until the provider rate-limited the run into a
	// retry storm, and bill for all of them.
	it("runs a bounded number of sessions however large the corpus", async () => {
		const many = Array.from({ length: 24 }, (_, index) => ({
			paperId: `bulk-${index}`,
			title: `Bulk Paper Number ${index}`,
			year: 2020,
			venue: "Venue",
			citationCount: 100 - index,
			// Abstract-only, so the run costs no downloads and still analyses 24 papers.
			abstract: `Abstract of paper ${index}.`,
			externalIds: { DOI: `10.9/bulk-${index}` },
			authors: [{ name: `Author${index} Surname${index}` }],
		}));

		const { final, peak } = await run({
			routes: [
				{ match: "export.arxiv.org", body: EMPTY_ARXIV },
				{ match: "api.openalex.org", body: EMPTY_OPENALEX },
				{ match: "api.semanticscholar.org", body: s2(many) },
			],
		});

		expect(final.status).toBe("completed");
		expect(Object.keys(final.steps["analyze"]?.items ?? {})).toHaveLength(24);

		// explore.yaml asks for 4 in the analysis fan-outs and 3 in the judging one.
		expect(peak.get("analyze")).toBeLessThanOrEqual(4);
		expect(peak.get("judge")).toBeLessThanOrEqual(3);
		// And it really did run them concurrently, rather than passing by serialising.
		expect(peak.get("analyze")).toBeGreaterThan(1);
	});

	it("stops at the first gate when the reviewer defers", async () => {
		const source = fs.readFileSync(path.join(shippedPipelinesDir(), "explore.yaml"), "utf-8");
		const spec = loadPipeline(path.join(shippedPipelinesDir(), "explore.yaml"), registry, {
			name: NAME,
			bulk: SCRIPTED_MODEL_REF,
			judgement: SCRIPTED_MODEL_REF,
		});
		const scripted = await createScriptedRuntime(agentDir, script().run);
		const { fetch, requests } = scriptedFetcher(ROUTES);
		const state = RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }),
		);

		const final = await runPipeline({
			spec,
			layout,
			state,
			registry,
			modelRuntime: scripted.runtime,
			agentDir,
			fetcher: fetch,
			gate: async () => "defer",
		});

		expect(final.status).toBe("awaiting_gate");
		// The candidates exist, and nothing has been spent on searching for them.
		expect(exists(`${DIR}/candidates.json`)).toBe(true);
		expect(requests).toEqual([]);
	});

	// Pruning is editing the JSON, and every later stage re-reads it — so a
	// deleted candidate has to disappear from the search, the analysis and the
	// report together, not just from the gate's display.
	it("honours a candidate deleted at the gate", async () => {
		const source = fs.readFileSync(path.join(shippedPipelinesDir(), "explore.yaml"), "utf-8");
		const spec = loadPipeline(path.join(shippedPipelinesDir(), "explore.yaml"), registry, {
			name: NAME,
			bulk: SCRIPTED_MODEL_REF,
			judgement: SCRIPTED_MODEL_REF,
		});
		const scripted = await createScriptedRuntime(agentDir, script().run);
		const { fetch } = scriptedFetcher(ROUTES);
		const state = RunStateStore.create(
			layout,
			initialRunState({ spec, layout, pipelineHash: hashPipeline(source) }),
		);

		const final = await runPipeline({
			spec,
			layout,
			state,
			registry,
			modelRuntime: scripted.runtime,
			agentDir,
			fetcher: fetch,
			gate: async (request) => {
				if (request.step.id === "prune-candidates") {
					fs.writeFileSync(
						path.join(workspace, DIR, "candidates.json"),
						JSON.stringify({ candidates: [CANDIDATES.candidates[0]] }),
					);
				}
				return { kind: "approve" };
			},
		});

		expect(final.status).toBe("completed");
		expect(exists(`${DIR}/verdicts/ip-1.md`)).toBe(true);
		expect(exists(`${DIR}/verdicts/ip-2.md`)).toBe(false);
		expect(exists(`${DIR}/evidence/ip-2.md`)).toBe(false);
	});
});
