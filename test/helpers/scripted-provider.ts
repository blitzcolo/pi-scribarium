import * as path from "node:path";

import {
	calculateCost,
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

/**
 * An in-process model provider driven by a script.
 *
 * This is the test seam for the whole orchestrator. `ModelRuntime.registerProvider`
 * accepts a `streamSimple` callback that replaces only the network call, so
 * everything above it runs for real: the agent loop, the built-in tools writing
 * real files, session persistence, usage and cost accounting, the turn budget,
 * retries, and compaction. No network, no credentials, no cost.
 *
 * Note: `baseUrl` is required by `validateExtensionProvider` whenever a provider
 * defines custom models, even though `streamSimple` means it is never contacted.
 * An unroutable placeholder is used, and a test that accidentally bypasses
 * `streamSimple` will fail on connection refused rather than reach a real API.
 */

export const SCRIPTED_PROVIDER_ID = "scribarium-scripted";
export const SCRIPTED_MODEL_ID = "scripted";
export const SCRIPTED_MODEL_REF = `${SCRIPTED_PROVIDER_ID}/${SCRIPTED_MODEL_ID}`;

/** One assistant turn. */
export interface ScriptStep {
	/** Assistant text, streamed as deltas. */
	text?: string;
	/** Tool calls to emit. The agent executes them and asks for another turn. */
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
	/** Fail this turn. Surfaces via the message stream, not a prompt() rejection. */
	error?: string;
	/** Override reported token usage for this turn. */
	usage?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
}

export interface ScriptContext {
	/**
	 * 1-based index of this assistant turn across the whole runtime.
	 *
	 * Not per session: one runtime serves every stage of a pipeline run, so a
	 * script driving several stages cannot use this to mean "first turn of this
	 * stage" — key off `lastUserText` or `messageCount` for that.
	 */
	turn: number;
	systemPrompt: string;
	/** Text of the most recent user message, if any. */
	lastUserText: string;
	messageCount: number;
	/** Tool names advertised to the model — the effective allowlist. */
	toolNames: string[];
}

export type Script = (context: ScriptContext) => ScriptStep;

export interface ScriptedRuntime {
	runtime: ModelRuntime;
	modelRef: string;
	/** System prompts observed, one per request — used for hermeticity assertions. */
	systemPrompts: string[];
	/** Every request's context, for asserting what the agent was actually told. */
	requests: ScriptContext[];
	turns: number;
}

export async function createScriptedRuntime(
	dir: string,
	script: Script,
): Promise<ScriptedRuntime> {
	const runtime = await ModelRuntime.create({
		authPath: path.join(dir, "auth.json"),
		modelsPath: path.join(dir, "models.json"),
		allowModelNetwork: false,
	});

	const state: ScriptedRuntime = {
		runtime,
		modelRef: SCRIPTED_MODEL_REF,
		systemPrompts: [],
		requests: [],
		turns: 0,
	};

	runtime.registerProvider(SCRIPTED_PROVIDER_ID, {
		name: "Scribarium Scripted",
		// Never contacted; `streamSimple` intercepts. Required by validation.
		baseUrl: "http://127.0.0.1:9/scripted",
		api: "openai-completions",
		apiKey: "$SCRIBARIUM_SCRIPTED_KEY",
		models: [
			{
				id: SCRIPTED_MODEL_ID,
				name: "Scripted",
				reasoning: false,
				input: ["text"],
				// Non-zero so cost reporting is genuinely exercised.
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 8192,
			},
		],
		streamSimple: (model, context) => runScript(model, context, script, state),
	});

	await runtime.setRuntimeApiKey(SCRIPTED_PROVIDER_ID, "scripted-test-key");
	return state;
}

function runScript(
	model: Model<Api>,
	context: Context,
	script: Script,
	state: ScriptedRuntime,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	const scriptContext: ScriptContext = {
		turn: ++state.turns,
		systemPrompt: context.systemPrompt ?? "",
		lastUserText: lastUserText(context),
		messageCount: context.messages.length,
		toolNames: (context.tools ?? []).map((tool) => (tool as { name: string }).name),
	};
	state.systemPrompts.push(scriptContext.systemPrompt);
	state.requests.push(scriptContext);

	void (async () => {
		const step = script(scriptContext);
		const usage = {
			input: step.usage?.input ?? 100,
			output: step.usage?.output ?? 50,
			cacheRead: step.usage?.cacheRead ?? 0,
			cacheWrite: step.usage?.cacheWrite ?? 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
		usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		usage.cost = calculateCost(model, usage);

		const output = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage,
			stopReason: "pending",
			timestamp: Date.now(),
		} as unknown as AssistantMessage;

		stream.push({ type: "start", partial: output });

		if (step.error !== undefined) {
			// A provider failure after acceptance: prompt() still resolves, and the
			// only signal is state.errorMessage. See CLAUDE.md gotcha #1.
			const failed = output as unknown as { stopReason: string; errorMessage?: string };
			failed.stopReason = "error";
			failed.errorMessage = step.error;
			stream.push({ type: "error", reason: "error", error: output });
			stream.end();
			return;
		}

		const content = output.content as unknown as Array<Record<string, unknown>>;

		if (step.text !== undefined && step.text.length > 0) {
			const index = content.length;
			content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: index, partial: output });
			for (const chunk of chunkText(step.text)) {
				(content[index] as { text: string }).text += chunk;
				stream.push({ type: "text_delta", contentIndex: index, delta: chunk, partial: output });
			}
			stream.push({
				type: "text_end",
				contentIndex: index,
				content: (content[index] as { text: string }).text,
				partial: output,
			});
		}

		for (const [callIndex, call] of (step.toolCalls ?? []).entries()) {
			const index = content.length;
			content.push({
				type: "toolCall",
				id: `call_${scriptContext.turn}_${callIndex}`,
				name: call.name,
				arguments: call.args,
			});
			stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
			const block = content[index] as unknown as {
				id: string;
				name: string;
				arguments: Record<string, unknown>;
			};
			stream.push({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: block as never,
				partial: output,
			});
		}

		// `toolUse` keeps the agent loop going; `stop` ends the turn.
		const reason: "stop" | "toolUse" = (step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop";
		(output as unknown as { stopReason: string }).stopReason = reason;
		stream.push({ type: "done", reason, message: output });
		stream.end();
	})();

	return stream;
}

function lastUserText(context: Context): string {
	for (let i = context.messages.length - 1; i >= 0; i--) {
		const message = context.messages[i] as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "user") continue;
		const { content } = message;
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content
				.filter((block): block is { type: "text"; text: string } => {
					const candidate = block as { type?: string; text?: unknown };
					return candidate.type === "text" && typeof candidate.text === "string";
				})
				.map((block) => block.text)
				.join("");
		}
	}
	return "";
}

/** Split into a few deltas so streaming consumers are exercised. */
function chunkText(text: string): string[] {
	const size = Math.max(1, Math.ceil(text.length / 3));
	const chunks: string[] = [];
	for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
	return chunks;
}
