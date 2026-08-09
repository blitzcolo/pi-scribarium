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

export function parseArgs(argv: readonly string[]): ParsedArgs {
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
		// token as its value unless that token is itself a flag. Keeping the two
		// forms uniform avoids a `-w /tmp` that silently parses as a boolean plus
		// a stray positional. The cost is that a boolean short flag must not be
		// written immediately before a positional (`-q writer`); every documented
		// invocation puts positionals first.
		if (token.startsWith("-") && token.length > 1) {
			const body = token.startsWith("--") ? token.slice(2) : token.slice(1);
			const equals = body.indexOf("=");
			if (equals !== -1) {
				record(body.slice(0, equals), body.slice(equals + 1));
				continue;
			}
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("-")) {
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

export function flagBoolean(args: ParsedArgs, ...names: string[]): boolean {
	return names.some((name) => args.flags.get(name) !== undefined);
}

/** All values given for a repeatable flag, in order. */
export function flagAll(args: ParsedArgs, name: string): string[] {
	return args.repeated.get(name) ?? [];
}
