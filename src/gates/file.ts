import * as fs from "node:fs";
import * as path from "node:path";

import type { RunLayout } from "../workspace/layout.js";
import type { GateDecision, GateHandler, GateRequest } from "./types.js";

/** Where a pending gate's request and decision live. */
export function gateRequestFile(layout: RunLayout, stepId: string): string {
	return path.join(layout.runDir, "gates", `${stepId}.request.json`);
}

export function gateDecisionFile(layout: RunLayout, stepId: string): string {
	return path.join(layout.runDir, "gates", `${stepId}.decision.json`);
}

/**
 * Headless gate.
 *
 * Writes what a reviewer needs to decide, then defers. The run exits 10 and the
 * decision arrives later through `scribarium approve` / `reject`, which is what
 * makes the pipeline usable from CI or a long unattended batch: the process does
 * not sit holding a session open waiting for a human who may be asleep.
 */
export function createFileGate(layout: RunLayout): GateHandler {
	return async (request: GateRequest) => {
		const decision = readDecision(layout, request.step.id);
		if (decision !== undefined) {
			// Consume it. A rejection rewinds to an earlier step and comes back
			// through this gate; leaving the decision in place would re-reject the
			// regenerated work forever without ever asking the reviewer again.
			clearDecision(layout, request.step.id);
			return decision;
		}

		const file = gateRequestFile(layout, request.step.id);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			`${JSON.stringify(
				{
					runId: request.runId,
					stepId: request.step.id,
					title: request.step.title,
					artifacts: request.artifacts.map((a) => ({
						path: a.path,
						absolutePath: a.absolutePath,
						bytes: a.bytes,
						exists: a.exists,
					})),
					onReject: request.step.onReject ?? null,
					usageSoFar: request.usageSoFar,
					howToRespond: {
						approve: `scribarium approve ${request.runId} ${request.step.id}`,
						reject: `scribarium reject ${request.runId} ${request.step.id} -m "what to change"`,
						thenResume: `scribarium resume ${request.runId}`,
					},
				},
				null,
				2,
			)}\n`,
			"utf-8",
		);
		return "defer";
	};
}

/** Read a decision recorded by `approve` / `reject`, if one is waiting. */
export function readDecision(layout: RunLayout, stepId: string): GateDecision | undefined {
	try {
		const raw = fs.readFileSync(gateDecisionFile(layout, stepId), "utf-8");
		const parsed = JSON.parse(raw) as GateDecision;
		if (parsed.kind === "approve" || parsed.kind === "skip" || parsed.kind === "abort") {
			return parsed;
		}
		if (parsed.kind === "reject" && typeof parsed.feedback === "string") return parsed;
		return undefined;
	} catch {
		return undefined;
	}
}

export function writeDecision(layout: RunLayout, stepId: string, decision: GateDecision): void {
	const file = gateDecisionFile(layout, stepId);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, `${JSON.stringify(decision, null, 2)}\n`, "utf-8");
}

/** Clear a consumed decision so a later re-run of the same gate asks again. */
export function clearDecision(layout: RunLayout, stepId: string): void {
	fs.rmSync(gateDecisionFile(layout, stepId), { force: true });
	fs.rmSync(gateRequestFile(layout, stepId), { force: true });
}

/** Approves every gate without asking. For CI and unattended re-runs. */
export const autoApproveGate: GateHandler = async () => ({ kind: "approve" });
