import * as fs from "node:fs";
import * as path from "node:path";

import { collectCorpusInputs, ingestCorpus } from "../ingest/pdf.js";
import type { BuiltinStepSpec } from "./schema.js";

export interface BuiltinContext {
	workspace: string;
	/** Absolute path the step's declared outputs resolve to. */
	resolveOutput: (relativePath: string) => string;
	onProgress?: (message: string) => void;
}

export interface BuiltinResult {
	ok: boolean;
	summary: string;
	error?: string;
}

/**
 * Deterministic, non-LLM pipeline steps.
 *
 * These exist so the parts of the pipeline that do not need judgement are not
 * paid for per token, and produce identical output every run. Corpus ingest is
 * the M1 case; the M4 citation checker joins it, deliberately as a builtin so
 * verification cannot be talked out of a finding by a model.
 */
export async function runBuiltin(
	step: BuiltinStepSpec,
	ctx: BuiltinContext,
): Promise<BuiltinResult> {
	switch (step.run) {
		case "ingest":
			return await runIngest(step, ctx);
		case "assemble":
			return assembleSections(step, ctx);
	}
}

/**
 * Concatenate independently drafted sections into one document, in the order the
 * outline declared.
 *
 * Deterministic on purpose. Ordering and concatenation need no judgement, and
 * paying a model to do it would also let it quietly drop or reword a section on
 * the way through.
 */
function assembleSections(step: BuiltinStepSpec, ctx: BuiltinContext): BuiltinResult {
	const sectionsFile = path.resolve(
		ctx.workspace,
		typeof step.with["sections"] === "string" ? step.with["sections"] : "outline/sections.json",
	);
	const fromDir = path.resolve(
		ctx.workspace,
		typeof step.with["from"] === "string" ? step.with["from"] : "draft",
	);
	const target = path.resolve(
		ctx.workspace,
		typeof step.with["out"] === "string" ? step.with["out"] : "draft/paper.md",
	);

	let sections: Array<{ id?: unknown; title?: unknown }>;
	try {
		const parsed = JSON.parse(fs.readFileSync(sectionsFile, "utf-8")) as {
			sections?: Array<{ id?: unknown; title?: unknown }>;
		};
		sections = parsed.sections ?? [];
	} catch (cause) {
		return {
			ok: false,
			summary: "could not read the section list",
			error: `${sectionsFile}: ${String(cause)}`,
		};
	}
	if (sections.length === 0) {
		return { ok: false, summary: "no sections", error: `${sectionsFile} lists no sections` };
	}

	const parts: string[] = [];
	const missing: string[] = [];

	for (const section of sections) {
		const id = typeof section.id === "string" ? section.id : undefined;
		if (id === undefined) continue;
		const file = path.join(fromDir, `${id}.md`);
		try {
			parts.push(fs.readFileSync(file, "utf-8").trim());
		} catch {
			// A missing section is recorded in the document rather than skipped:
			// a silent gap would read as a deliberate omission to whoever reviews it.
			missing.push(id);
			const title = typeof section.title === "string" ? section.title : id;
			parts.push(`## ${title}

SECTION MISSING: ${id} was not drafted.`);
		}
	}

	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${parts.join("\n\n")}\n`, "utf-8");

	return {
		ok: true,
		summary:
			`assembled ${sections.length - missing.length}/${sections.length} section(s) into ` +
			path.relative(ctx.workspace, target) +
			(missing.length > 0 ? ` (missing: ${missing.join(", ")})` : ""),
	};
}

async function runIngest(step: BuiltinStepSpec, ctx: BuiltinContext): Promise<BuiltinResult> {
	const from = typeof step.with["from"] === "string" ? step.with["from"] : "corpus";
	const force = step.with["force"] === true;

	const sourceDir = path.resolve(ctx.workspace, from);
	// Ingest writes into the workspace rather than the run's artifact directory:
	// extracted text is an expensive, reusable property of the corpus, not of a
	// single run, and re-extracting it per run would be pure waste.
	const outDir = path.resolve(
		ctx.workspace,
		typeof step.with["out"] === "string" ? step.with["out"] : path.join(from, "text"),
	);

	const inputs = collectCorpusInputs([sourceDir]);
	if (inputs.length === 0) {
		return {
			ok: false,
			summary: "no source documents found",
			error: `No .pdf, .md, .txt, or .tex files found under ${sourceDir}`,
		};
	}

	const result = await ingestCorpus({
		inputs,
		outDir,
		force,
		onProgress: (file) => {
			const label = path.basename(file.sourcePath);
			ctx.onProgress?.(
				file.status === "failed" ? `  fail  ${label}: ${file.error}` : `  ${file.status.padEnd(9)} ${label}`,
			);
		},
	});

	const failures = result.files.filter((file) => file.status === "failed");
	return {
		ok: failures.length === 0,
		summary: `${result.succeeded} document(s) ready in ${path.relative(ctx.workspace, outDir)}`,
		...(failures.length > 0
			? {
					error: `${failures.length} document(s) failed: ${failures
						.map((f) => `${path.basename(f.sourcePath)} (${f.error})`)
						.join("; ")}`,
				}
			: {}),
	};
}
