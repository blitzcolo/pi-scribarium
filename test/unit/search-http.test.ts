import { afterEach, describe, expect, it } from "vitest";

import { createPoliteFetcher, type Fetcher } from "../../src/search/http.js";

/** No host spacing and no real sleeping: the point is ordering, not wall clock. */
const FAST = {
	intervals: new Map([["example.org", 0]]),
	sleep: async () => {},
};

const originalKey = process.env["SEMANTIC_SCHOLAR_API_KEY"];

afterEach(() => {
	if (originalKey === undefined) delete process.env["SEMANTIC_SCHOLAR_API_KEY"];
	else process.env["SEMANTIC_SCHOLAR_API_KEY"] = originalKey;
});

function counting(responses: Array<() => Response>): { fetch: Fetcher; calls: () => number } {
	let index = 0;
	return {
		calls: () => index,
		fetch: async () => {
			const make = responses[Math.min(index, responses.length - 1)];
			index += 1;
			if (make === undefined) throw new Error("no scripted response");
			return make();
		},
	};
}

describe("createPoliteFetcher", () => {
	it("retries a 429 and returns the eventual success", async () => {
		const { fetch, calls } = counting([
			() => new Response("slow down", { status: 429 }),
			() => new Response("slow down", { status: 429 }),
			() => new Response("ok", { status: 200 }),
		]);
		const polite = createPoliteFetcher({ fetch, ...FAST });

		const response = await polite("https://example.org/a");

		expect(response.status).toBe(200);
		expect(calls()).toBe(3);
	});

	it("retries a 5xx and a transport failure", async () => {
		let attempt = 0;
		const polite = createPoliteFetcher({
			...FAST,
			fetch: async () => {
				attempt += 1;
				if (attempt === 1) throw new Error("ECONNRESET");
				if (attempt === 2) return new Response("boom", { status: 502 });
				return new Response("ok", { status: 200 });
			},
		});

		expect((await polite("https://example.org/a")).status).toBe(200);
		expect(attempt).toBe(3);
	});

	// A 404 is an answer. Retrying it would multiply every miss in a follow-up
	// lookup by the retry count, and follow-up misses are routine.
	it("does not retry a client error", async () => {
		const { fetch, calls } = counting([() => new Response("nope", { status: 404 })]);
		const polite = createPoliteFetcher({ fetch, ...FAST });

		expect((await polite("https://example.org/a")).status).toBe(404);
		expect(calls()).toBe(1);
	});

	it("gives up after maxRetries and throws the last error", async () => {
		const { fetch, calls } = counting([() => new Response("down", { status: 503 })]);
		const polite = createPoliteFetcher({ fetch, ...FAST, maxRetries: 2 });

		await expect(polite("https://example.org/a")).rejects.toThrow("HTTP 503");
		// One initial attempt plus two retries.
		expect(calls()).toBe(3);
	});

	it("waits the interval a Retry-After header asks for", async () => {
		const waits: number[] = [];
		let attempt = 0;
		const polite = createPoliteFetcher({
			intervals: FAST.intervals,
			sleep: async (ms) => {
				waits.push(ms);
			},
			fetch: async () => {
				attempt += 1;
				return attempt === 1
					? new Response("slow down", { status: 429, headers: { "retry-after": "7" } })
					: new Response("ok", { status: 200 });
			},
		});

		await polite("https://example.org/a");

		expect(waits).toContain(7000);
	});

	// Backoff without a ceiling turns a busy afternoon into an overnight run that
	// looks like a hang — the same trap the SDK's provider retries are capped for.
	it("caps the backoff wait", async () => {
		const waits: number[] = [];
		const polite = createPoliteFetcher({
			intervals: FAST.intervals,
			sleep: async (ms) => {
				waits.push(ms);
			},
			fetch: async () => new Response("down", { status: 503 }),
			maxRetries: 12,
		});

		await expect(polite("https://example.org/a")).rejects.toThrow();

		expect(Math.max(...waits)).toBeLessThanOrEqual(60_000);
	});

	it("sends a contact-bearing user agent and the API key when one is set", async () => {
		process.env["SEMANTIC_SCHOLAR_API_KEY"] = "secret-key";
		let seen: Headers | undefined;
		const polite = createPoliteFetcher({
			...FAST,
			fetch: async (_url, init) => {
				seen = new Headers(init?.headers);
				return new Response("ok");
			},
		});

		await polite("https://example.org/a");

		expect(seen?.get("user-agent")).toContain("pi-scribarium");
		expect(seen?.get("x-api-key")).toBe("secret-key");
	});

	// A silent backoff of up to a minute is indistinguishable from a hang, and the
	// operator's reasonable response — kill it and start over — makes it worse.
	// The same trap is documented one layer up for the model client's retries.
	it("announces a rate-limit wait and names the server as the cause", async () => {
		const notices: string[] = [];
		let attempt = 0;
		const polite = createPoliteFetcher({
			intervals: FAST.intervals,
			sleep: async () => {},
			onNotice: (notice) => notices.push(`${notice.kind} ${notice.waitMs} ${notice.attempt}`),
			fetch: async () => {
				attempt += 1;
				return attempt === 1
					? new Response("slow down", { status: 429, headers: { "retry-after": "30" } })
					: new Response("ok");
			},
		});

		await polite("https://example.org/a");

		// The wait is attributed to the server's own Retry-After rather than to our
		// guess, because the two call for different responses from a human.
		expect(notices).toEqual(["rate-limited 30000 1"]);
	});

	it("announces an ordinary retry with its reason", async () => {
		const notices: Array<{ kind: string; reason: string }> = [];
		let attempt = 0;
		const polite = createPoliteFetcher({
			intervals: FAST.intervals,
			sleep: async () => {},
			onNotice: (notice) => notices.push({ kind: notice.kind, reason: notice.reason }),
			fetch: async () => {
				attempt += 1;
				if (attempt === 1) throw new Error("ECONNREFUSED");
				return new Response("ok");
			},
		});

		await polite("https://example.org/a");

		expect(notices).toHaveLength(1);
		expect(notices[0]?.kind).toBe("retry");
		expect(notices[0]?.reason).toContain("ECONNREFUSED");
	});

	it("says nothing when a request succeeds first time", async () => {
		const notices: unknown[] = [];
		const polite = createPoliteFetcher({
			...FAST,
			onNotice: (notice) => notices.push(notice),
			fetch: async () => new Response("ok"),
		});

		await polite("https://example.org/a");

		expect(notices).toEqual([]);
	});

	it("serializes requests to one host", async () => {
		const order: string[] = [];
		const polite = createPoliteFetcher({
			...FAST,
			fetch: async (url) => {
				order.push(`start ${url}`);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(`end ${url}`);
				return new Response("ok");
			},
		});

		await Promise.all([polite("https://example.org/a"), polite("https://example.org/b")]);

		// Interleaved starts would mean the per-host floor is not being honored.
		expect(order).toEqual([
			"start https://example.org/a",
			"end https://example.org/a",
			"start https://example.org/b",
			"end https://example.org/b",
		]);
	});
});
