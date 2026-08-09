import { resolveCliModel, type ModelRuntime } from "@earendil-works/pi-coding-agent";

import { PreflightError, StageConfigError } from "../util/errors.js";
import type { ThinkingLevelName } from "../agents/types.js";

/**
 * A resolved model. Derived rather than imported: the SDK's peers are nested
 * under its own shrinkwrap and are not resolvable from our project root, and
 * the docs disagree about whether `getModel` lives in `@earendil-works/pi-ai`
 * or `@earendil-works/pi-ai/compat`. See CLAUDE.md gotcha #6.
 */
export type StageModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

export interface ResolvedStageModel {
	model: StageModel;
	/** Present when the reference carried a `:level` suffix. */
	thinkingLevel?: ThinkingLevelName;
	warning?: string;
}

/**
 * Resolve one `provider/model[:thinking]` reference.
 *
 * `resolveCliModel` is synchronous and understands the whole reference syntax,
 * including fuzzy id matching and thinking-level suffixes, so it is a better
 * seam than splitting the string ourselves and calling `getModel`.
 */
export function resolveStageModel(
	modelRuntime: ModelRuntime,
	modelRef: string,
): ResolvedStageModel {
	const result = resolveCliModel({ cliModel: modelRef, modelRuntime });

	if (result.error !== undefined) {
		throw new StageConfigError(`model "${modelRef}": ${result.error}`);
	}
	if (result.model === undefined) {
		throw new StageConfigError(
			`model "${modelRef}" did not match any model from a configured provider`,
		);
	}

	return {
		model: result.model,
		...(result.thinkingLevel !== undefined
			? { thinkingLevel: result.thinkingLevel as ThinkingLevelName }
			: {}),
		...(result.warning !== undefined ? { warning: result.warning } : {}),
	};
}

/**
 * Validate every model reference a run will need, before any stage starts.
 *
 * Without this, a missing credential surfaces partway through a fan-out — after
 * real money has been spent — instead of immediately. Fails on the first
 * problem with an actionable message.
 */
export async function preflightModels(
	modelRuntime: ModelRuntime,
	modelRefs: readonly string[],
): Promise<void> {
	const wanted = new Map<string, StageModel>();
	for (const ref of new Set(modelRefs)) {
		const { model } = resolveStageModel(modelRuntime, ref);
		wanted.set(`${model.provider}/${model.id}`, model);
	}

	const byProvider = new Map<string, StageModel[]>();
	for (const model of wanted.values()) {
		const bucket = byProvider.get(model.provider);
		if (bucket === undefined) byProvider.set(model.provider, [model]);
		else bucket.push(model);
	}

	for (const [providerId, models] of byProvider) {
		if (!modelRuntime.hasConfiguredAuth(providerId)) {
			throw new PreflightError(
				`No credentials configured for provider "${providerId}".\n` +
					`Set the provider's API key environment variable (\`pi --help\` lists them), ` +
					`or add an entry to ~/.pi/agent/auth.json:\n` +
					`  { "${providerId}": { "type": "api_key", "key": "..." } }\n` +
					`Check it with: pi auth check --provider ${providerId}`,
			);
		}

		const available = new Set((await modelRuntime.getAvailable(providerId)).map((m) => m.id));
		const missing = models.filter((m) => !available.has(m.id));
		if (missing.length > 0) {
			throw new PreflightError(
				`Provider "${providerId}" is authenticated but does not offer ` +
					`${missing.map((m) => `"${m.id}"`).join(", ")}. ` +
					"Check the model id, or your plan's model access.",
			);
		}
	}
}
