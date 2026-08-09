import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Where this package keeps the definitions it ships.
 *
 * Its own module, and deliberately so: this is pure path arithmetic, but it
 * used to live in `discover.ts`, which imports the pi SDK. `init` needs only
 * this function, so importing it there dragged twenty thousand files of agent
 * runtime into a command that scaffolds directories. Keeping it separate is
 * what lets `init` — and the startup-cost test — stay honest.
 */
export function shippedAgentsDir(): string {
	// dist/agents/shipped.js -> package root
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..", "agents");
}

/** Where this package keeps the pipelines it ships. */
export function shippedPipelinesDir(): string {
	return path.resolve(shippedAgentsDir(), "..", "pipelines");
}
