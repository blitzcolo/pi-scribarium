import { afterEach, describe, expect, it } from "vitest";

import { createPoliteFetcher, type Fetcher } from "../../src/search/http.js";

/** No host spacing and no real sleeping: the point is ordering, not wall clock. */
const FAST = {
	intervals: new Map([["example.org", 0]]),
	sleep: async () => {},
};

/** Both variables these tests set, restored together so none leaks into another. */
const TOUCHED = ["SEMANTIC_SCHOLAR_API_KEY", "SCRIBARIUM_CONTACT_EMAIL"] as const;
const original = new Map(TOUCHED.map((name) => [name, process.env[name]]));

afterEach(() => {
	for (const name of TOUCHED) {
		const value = original.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
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

	it("identifies itself by name and version", async () => {
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
	});
});

/**
 * Who gets told what.
 *
 * Both of these were once attached to every request, so a run that downloaded a
 * hundred PDFs handed the user's address — and their API key — to every
 * publisher server it touched. Neither host had asked for either.
 */
describe("what is sent to whom", () => {
	function capturing(): { fetch: Fetcher; headers: Map<string, Headers> } {
		const headers = new Map<string, Headers>();
		return {
			headers,
			fetch: async (url, init) => {
				headers.set(new URL(url).host, new Headers(init?.headers));
				return new Response("ok");
			},
		};
	}

	const EVERYWHERE = {
		sleep: async () => {},
		intervals: new Map([
			["api.semanticscholar.org", 0],
			["api.openalex.org", 0],
			["export.arxiv.org", 0],
			["arxiv.org", 0],
			["cdn.publisher.example", 0],
		]),
	};

	it("sends the Semantic Scholar key to Semantic Scholar and nowhere else", async () => {
		process.env["SEMANTIC_SCHOLAR_API_KEY"] = "secret-key";
		const { fetch, headers } = capturing();
		const polite = createPoliteFetcher({ fetch, ...EVERYWHERE });

		await polite("https://api.semanticscholar.org/graph/v1/paper/search?query=x");
		await polite("https://cdn.publisher.example/paper.pdf");
		await polite("https://api.openalex.org/works?search=x");
		await polite("https://arxiv.org/pdf/2301.04567");

		expect(headers.get("api.semanticscholar.org")?.get("x-api-key")).toBe("secret-key");
		// A credential reaching a third party is a different class of problem from
		// a contact address reaching one.
		expect(headers.get("cdn.publisher.example")?.get("x-api-key")).toBeNull();
		expect(headers.get("api.openalex.org")?.get("x-api-key")).toBeNull();
		expect(headers.get("arxiv.org")?.get("x-api-key")).toBeNull();
	});

	it("offers the contact address only to the endpoints that asked for one", async () => {
		process.env["SCRIBARIUM_CONTACT_EMAIL"] = "someone@example.org";
		const { fetch, headers } = capturing();
		const polite = createPoliteFetcher({ fetch, ...EVERYWHERE });

		await polite("https://export.arxiv.org/api/query?search_query=x");
		await polite("https://api.openalex.org/works?search=x");
		await polite("https://cdn.publisher.example/paper.pdf");
		// The same organisation as the API host, but this endpoint never asked.
		await polite("https://arxiv.org/pdf/2301.04567");

		expect(headers.get("export.arxiv.org")?.get("user-agent")).toContain("mailto:someone@");
		expect(headers.get("api.openalex.org")?.get("user-agent")).toContain("mailto:someone@");
		expect(headers.get("cdn.publisher.example")?.get("user-agent")).not.toContain("mailto:");
		expect(headers.get("arxiv.org")?.get("user-agent")).not.toContain("mailto:");
	});

	it("sends no contact address when none is configured", async () => {
		delete process.env["SCRIBARIUM_CONTACT_EMAIL"];
		const { fetch, headers } = capturing();
		const polite = createPoliteFetcher({ fetch, ...EVERYWHERE });

		await polite("https://api.openalex.org/works?search=x");

		expect(headers.get("api.openalex.org")?.get("user-agent")).not.toContain("mailto:");
	});

	// A variable left set to whitespace should read as unset, not produce
	// `(mailto:)` in a header.
	it("treats a blank contact address as unset", async () => {
		process.env["SCRIBARIUM_CONTACT_EMAIL"] = "   ";
		const { fetch, headers } = capturing();
		const polite = createPoliteFetcher({ fetch, ...EVERYWHERE });

		await polite("https://api.openalex.org/works?search=x");

		expect(headers.get("api.openalex.org")?.get("user-agent")).not.toContain("mailto");
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

	it("still spaces two requests to one host apart", async () => {
		const polite = createPoliteFetcher({
			fetch: async () => new Response("ok"),
			intervals: new Map([["example.org", 80]]),
		});

		const started = Date.now();
		await polite("https://example.org/a");
		await polite("https://example.org/b");

		// The wait moved from after one request to before the next; it must not have
		// gone missing in the move.
		expect(Date.now() - started).toBeGreaterThanOrEqual(70);
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

/**
 * Both waits in this file are awaited by somebody, so a timer that does not hold
 * the event loop open strands whoever is awaiting it.
 *
 * That is not a slow path or a late resolution. With no socket in flight —
 * exactly the state between two of an agent's tool calls — node finds nothing
 * left to do, drains the loop, and kills the run with "Detected unsettled
 * top-level await" and exit 13, in the middle of a stage that was working. It
 * escaped the whole suite because every other test here sets an interval of 0 or
 * injects its own `sleep`, and vitest's own handles keep the loop alive anyway.
 *
 * `getActiveResourcesInfo` reports only resources that are keeping the loop
 * alive, so an `unref`'d timer is invisible to it — which is precisely the
 * distinction being asserted.
 */
describe("waits hold the event loop open", () => {
	const activeTimeouts = (): number =>
		process.getActiveResourcesInfo().filter((resource) => resource === "Timeout").length;

	/** Drains the microtask queue, so a pending `await` has reached its timer. */
	const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

	it("while spacing a second request to one host", async () => {
		const polite = createPoliteFetcher({
			fetch: async () => new Response("ok"),
			intervals: new Map([["example.org", 60]]),
		});
		await polite("https://example.org/a");

		const before = activeTimeouts();
		const second = polite("https://example.org/b");
		await settle();

		expect(activeTimeouts()).toBeGreaterThan(before);
		await second;
	});

	it("while backing off after a 429", async () => {
		let attempt = 0;
		const polite = createPoliteFetcher({
			intervals: new Map([["example.org", 0]]),
			fetch: async () => {
				attempt += 1;
				return attempt === 1
					? new Response("slow down", { status: 429, headers: { "retry-after": "0.06" } })
					: new Response("ok");
			},
		});

		const before = activeTimeouts();
		const pending = polite("https://example.org/a");
		await settle();

		expect(activeTimeouts()).toBeGreaterThan(before);
		expect((await pending).status).toBe(200);
	});
});
