import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The pi SDK must not be reachable through *static* imports from the CLI entry
 * point.
 *
 * It is roughly 20 000 files. Resolving them costs about 0.4 s on a local disk
 * and, measured on a WSL2 9p mount, over twenty — and a static import makes
 * every command pay it, `--help` included. Half the command surface touches no
 * model at all.
 *
 * Asserted by walking the import graph rather than by timing anything: a timing
 * test would be flaky on a fast disk and would not say what broke. The failure
 * message names the exact chain, because the leak is always transitive — the
 * regression this was written for ran `main` → `init` → `agents/discover` →
 * SDK, over a function that was pure path arithmetic.
 *
 * Reads `src/` rather than `dist/` so it does not depend on a build having run.
 */

const SDK = "@earendil-works/pi-coding-agent";
const SRC = path.resolve(process.cwd(), "src");

/** Commands that legitimately load the SDK, reached only via `await import()`. */
const LAZY_ENTRY_POINTS = ["cli/commands/run.ts", "cli/commands/resume.ts", "agents/registry.ts"];

function staticImports(file: string): string[] {
	const source = fs.readFileSync(file, "utf-8");
	const specifiers: string[] = [];

	for (const match of source.matchAll(/^\s*(?:import|export)\s+([^;]*?)\s*from\s*["']([^"']+)["']/gm)) {
		// `import type` is erased at compile time and costs nothing at runtime.
		if (/^type\b/.test(match[1] as string)) continue;
		specifiers.push(match[2] as string);
	}
	// Side-effect imports: `import "./x.js"`.
	for (const match of source.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) {
		specifiers.push(match[1] as string);
	}
	return specifiers;
}

/** NodeNext specifiers end in `.js`; the file on disk is `.ts`. */
function resolveSource(fromFile: string, specifier: string): string | null {
	const base = path.resolve(path.dirname(fromFile), specifier);
	for (const candidate of [base.replace(/\.js$/, ".ts"), base, `${base}.ts`]) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
	}
	return null;
}

/** The first static path from `entry` to the SDK, or null. */
function pathToSdk(entry: string): string[] | null {
	const queue: Array<{ file: string; chain: string[] }> = [
		{ file: entry, chain: [path.relative(SRC, entry)] },
	];
	const seen = new Set<string>();

	while (queue.length > 0) {
		const { file, chain } = queue.shift() as { file: string; chain: string[] };
		if (seen.has(file)) continue;
		seen.add(file);

		for (const specifier of staticImports(file)) {
			if (specifier === SDK) return [...chain, SDK];
			if (!specifier.startsWith(".")) continue;
			const resolved = resolveSource(file, specifier);
			if (resolved === null) continue;
			queue.push({ file: resolved, chain: [...chain, path.relative(SRC, resolved)] });
		}
	}
	return null;
}

describe("CLI startup cost", () => {
	it("does not statically reach the pi SDK from the entry point", () => {
		const chain = pathToSdk(path.join(SRC, "cli", "main.ts"));

		expect(
			chain,
			chain === null
				? ""
				: "The SDK is statically reachable from the CLI entry point, which costs every " +
					"command — including --help — a full SDK load.\n  " +
					chain.join("\n    -> ") +
					"\nMove the offending import behind `await import(...)` in the branch that needs it.",
		).toBeNull();
	});

	// Guards the walker itself: if it could not find a known-reachable chain it
	// would report success for every input, and this file would be worthless.
	it.each(LAZY_ENTRY_POINTS)("still detects the SDK behind %s", (entry) => {
		expect(pathToSdk(path.join(SRC, entry))).not.toBeNull();
	});

	// `import type` is erased by the compiler, so excluding it is correct — but
	// only as long as the entry point really does use it that way.
	it("permits a type-only import of an SDK-touching module", () => {
		const main = fs.readFileSync(path.join(SRC, "cli", "main.ts"), "utf-8");
		expect(main).toContain("import type { RunStageResult }");
	});
});
