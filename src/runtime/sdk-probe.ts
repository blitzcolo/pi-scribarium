/**
 * Compile-time probe: proves the SDK's published types resolve for consumers.
 *
 * The SDK ships .d.ts files whose relative imports carry `.ts` extensions
 * (34 of them in index.d.ts alone), which is unusual and could break consumer
 * builds. This file imports the exact symbols the orchestrator depends on, so
 * `npm run typecheck` fails loudly if an upstream release changes their shape.
 *
 * It is intentionally kept in the build (not the test tree): it is the cheapest
 * possible drift detector. See CLAUDE.md, "SDK gotchas".
 */

import {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	parseFrontmatter,
	resolveCliModel,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type AgentSessionEvent,
	type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

/** A resolved model, derived rather than imported: the docs disagree on whether
 * `getModel` lives in `@earendil-works/pi-ai` or `@earendil-works/pi-ai/compat`,
 * so we never import it directly. */
export type StageModel = NonNullable<ReturnType<ModelRuntime["getModel"]>>;

/** The events the turn budget and telemetry depend on. */
export type StageEventType = AgentSessionEvent["type"];

export type {
	AgentSession,
	AgentSessionEvent,
	ResourceLoader,
};

export {
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	ModelRuntime,
	parseFrontmatter,
	resolveCliModel,
	SessionManager,
	SettingsManager,
};
