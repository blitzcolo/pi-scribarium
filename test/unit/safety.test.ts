import { describe, expect, it } from "vitest";

import {
	assertDepthAllowed,
	childEnv,
	currentDepth,
	DEPTH_VAR,
	MAX_DEPTH_VAR,
	RecursionError,
	redactSecrets,
} from "../../src/util/safety.js";

describe("recursion guard", () => {
	it("allows a top-level run", () => {
		expect(() => assertDepthAllowed({})).not.toThrow();
		expect(currentDepth({})).toBe(0);
	});

	// An agent granted the bash tool can invoke scholarly, which would recurse
	// and keep paying for itself.
	it("refuses once the depth limit is reached", () => {
		expect(() => assertDepthAllowed({ [DEPTH_VAR]: "3" })).toThrow(RecursionError);
		expect(() => assertDepthAllowed({ [DEPTH_VAR]: "3" })).toThrow(/already 3 level/);
	});

	it("honours an explicit limit", () => {
		expect(() => assertDepthAllowed({ [DEPTH_VAR]: "1", [MAX_DEPTH_VAR]: "1" })).toThrow();
		expect(() => assertDepthAllowed({ [DEPTH_VAR]: "1", [MAX_DEPTH_VAR]: "5" })).not.toThrow();
	});

	it("increments depth for a child process", () => {
		expect(childEnv({})[DEPTH_VAR]).toBe("1");
		expect(childEnv({ [DEPTH_VAR]: "2" })[DEPTH_VAR]).toBe("3");
	});

	it("treats a malformed depth as zero rather than failing open", () => {
		expect(currentDepth({ [DEPTH_VAR]: "not-a-number" })).toBe(0);
		expect(currentDepth({ [DEPTH_VAR]: "-4" })).toBe(0);
	});
});

describe("secret redaction", () => {
	it.each([
		["sk-kimi-cgCRko1EwvgtIYr19LYCwSp1xbAeLFyb", "sk-[REDACTED]"],
		["sk-ccbb70bbef264cf486d48f392e8a8927", "sk-[REDACTED]"],
	])("redacts a provider key", (secret, expected) => {
		expect(redactSecrets(`Authorization failed for ${secret}`)).toContain(expected);
		expect(redactSecrets(`key ${secret} here`)).not.toContain(secret);
	});

	it("redacts bearer tokens and long hex blobs", () => {
		expect(redactSecrets("Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe("Bearer [REDACTED]");
		expect(redactSecrets(`hash ${"a".repeat(40)}`)).toBe("hash [REDACTED]");
	});

	it("redacts a value by its key name whatever it looks like", () => {
		expect(redactSecrets('{"apiKey": "shortish-but-secret"}')).toBe('{"apiKey": "[REDACTED]"}');
		expect(redactSecrets("api_key = 'another-secret-value'")).toContain("[REDACTED]");
	});

	it("leaves ordinary prose alone", () => {
		const prose =
			"We train on 1.2 million profiles [Hersbach 2020] and report RMSE of 0.41 K.";
		expect(redactSecrets(prose)).toBe(prose);
	});

	it("does not mangle a DOI or an ordinary identifier", () => {
		const text = "DOI 10.1234/jae.2024.441 and commit a1b2c3d";
		expect(redactSecrets(text)).toBe(text);
	});
});
