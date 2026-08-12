/**
 * Minimal argument parsing.
 *
 * Hand-rolled rather than pulled from a dependency: the surface is a handful of
 * `--flag value` pairs and positionals, and pi's own CLI does the same.
 */

export interface ParsedArgs {
	command: string | undefined;
	positionals: string[];
	flags: ReadonlyMap<string, string | true>;
	/**
	 * Every value seen for each flag, in order. `flags` keeps only the last, which
	 * is what callers want for `--workspace`; repeatable flags such as `--var`
	 * would otherwise silently lose all but the final occurrence.
	 */
	repeated: ReadonlyMap<string, string[]>;
}

/**
 * Flags that never take a value.
 *
 * Without this list a boolean flag swallows the token after it, which is not an
 * error and so acts on the wrong thing silently: `run --quiet paper.yaml` ran
 * the default pipeline rather than the named one, and `approve -y run-123`
 * approved whichever run happened to be latest.
 */
export const BOOLEAN_FLAGS: readonly string[] = [
	"force",
	"force-pipeline",
	"help",
	"h",
	"json",
	"quiet",
	"q",
	"strict",
	"version",
	"v",
	"yes",
	"y",
];

/** Spellings of `false` accepted for an explicit `--flag=false`. */
const FALSEY = new Set(["false", "0", "no", "off"]);

export function parseArgs(
	argv: readonly string[],
	booleans: readonly string[] = BOOLEAN_FLAGS,
): ParsedArgs {
	const isBoolean = new Set(booleans);
	const flags = new Map<string, string | true>();
	const repeated = new Map<string, string[]>();
	const positionals: string[] = [];

	const record = (name: string, value: string | true): void => {
		flags.set(name, value);
		if (typeof value === "string") {
			const seen = repeated.get(name);
			if (seen === undefined) repeated.set(name, [value]);
			else seen.push(value);
		}
	};
	let sawSeparator = false;

	for (let i = 0; i < argv.length; i++) {
		const token = argv[i];
		if (token === undefined) continue;

		if (sawSeparator) {
			positionals.push(token);
			continue;
		}
		if (token === "--") {
			sawSeparator = true;
			continue;
		}

		// Long and short flags behave identically: a flag takes the following
		// token as its value unless that token is itself a flag, or the flag is a
		// known boolean. Keeping the two forms uniform avoids a `-w /tmp` that
		// silently parses as a boolean plus a stray positional; knowing which
		// flags are boolean avoids the mirror-image bug, where `--quiet paper.yaml`
		// ate the positional and ran the default pipeline instead.
		// A flag is a dash followed by a letter. Anything else beginning with a
		// dash is a value: review feedback is written as a markdown list, so
		// `-m "- first point"` is the common case, and negative numbers likewise.
		if (/^--?[A-Za-z]/.test(token)) {
			const body = token.startsWith("--") ? token.slice(2) : token.slice(1);
			const equals = body.indexOf("=");
			if (equals !== -1) {
				record(body.slice(0, equals), body.slice(equals + 1));
				continue;
			}
			const next = argv[i + 1];
			if (!isBoolean.has(body) && next !== undefined && !/^--?[A-Za-z]/.test(next)) {
				record(body, next);
				i++;
			} else {
				record(body, true);
			}
			continue;
		}

		positionals.push(token);
	}

	const [command, ...rest] = positionals;
	return {
		...(command !== undefined ? { command } : { command: undefined }),
		positionals: rest,
		flags,
		repeated,
	};
}

export function flagString(args: ParsedArgs, ...names: string[]): string | undefined {
	for (const name of names) {
		const value = args.flags.get(name);
		if (typeof value === "string") return value;
	}
	return undefined;
}

/**
 * Whether a boolean flag is set.
 *
 * `--yes=false` reads as an explicit refusal, so it must not enable the flag —
 * it used to, which meant `run --yes=false` auto-approved every gate and spent
 * the whole pipeline unattended.
 */
export function flagBoolean(args: ParsedArgs, ...names: string[]): boolean {
	return names.some((name) => {
		const value = args.flags.get(name);
		if (value === undefined) return false;
		return value === true || !FALSEY.has(value.trim().toLowerCase());
	});
}

/**
 * A value-taking flag that was given without one.
 *
 * `--workspace` with nothing after it parses as boolean `true`, and `flagString`
 * then reports it as absent — so the command silently fell back to the default
 * workspace, model, or output directory instead of saying the flag was empty.
 */
export function flagsMissingValues(args: ParsedArgs, ...names: string[]): string[] {
	return names.filter((name) => args.flags.get(name) === true);
}

/** All values given for a repeatable flag, in order. */
export function flagAll(args: ParsedArgs, name: string): string[] {
	return args.repeated.get(name) ?? [];
}

/**
 * Ids from `--keep`, which is both repeatable and comma-separated.
 *
 * Three outcomes, not two: `undefined` when the flag is absent, which means
 * approve the whole list; the ids when there are any; and an empty array when
 * the flag was given with nothing usable behind it. The caller must not collapse
 * that last case into either of the others — read as "keep everything" it
 * approves what the reviewer was cutting down, and read as "keep nothing" it
 * deletes all of it.
 */
export function keepIds(args: ParsedArgs): string[] | undefined {
	const given = flagAll(args, "keep");
	if (given.length === 0) return undefined;
	return given
		.flatMap((value) => value.split(","))
		.map((id) => id.trim())
		.filter((id) => id.length > 0);
}
