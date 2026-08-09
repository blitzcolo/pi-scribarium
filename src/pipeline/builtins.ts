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
	}
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
