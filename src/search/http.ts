/**
 * The one HTTP client in this project.
 *
 * Everything network-facing goes through a `Fetcher`, which is an injectable
 * function rather than a direct call to global `fetch`. That is the seam the
 * tests use: a scripted fetcher serves fixtures, and a step that is supposed to
 * be offline can be asserted to have made zero requests. It is the same trade
 * the scripted model provider makes — replace the wire, run everything else for
 * real.
 */

import { VERSION } from "../version.js";

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Hosts that asked to be told who is calling, and are therefore the only ones
 * told.
 *
 * OpenAlex and Crossref-style APIs offer a higher rate limit to clients that
 * identify themselves, and arXiv asks API users to do the same. None of that
 * extends to the publisher servers a PDF is downloaded from: they did not ask,
 * have no use for it, and a contact address sent to several dozen third parties
 * is not what someone setting one variable expects to happen.
 *
 * Deliberately not including `arxiv.org` — the PDF host — even though it is the
 * same organisation as `export.arxiv.org`. The rule is "the endpoint that asked",
 * and keeping it that literal is what makes it easy to check.
 */
const CONTACT_HOSTS: ReadonlySet<string> = new Set([
	"api.openalex.org",
	"api.semanticscholar.org",
	"export.arxiv.org",
]);

/** The one host the Semantic Scholar credential may ever be sent to. */
const SEMANTIC_SCHOLAR_HOST = "api.semanticscholar.org";

/**
 * Minimum spacing between requests to one host.
 *
 * arXiv asks for one request every three seconds and means it; Semantic
 * Scholar's unauthenticated pool is roughly one per second and answers 429 well
 * before that on a bad day; OpenAlex is generous but still deserves a polite
 * floor. Publisher PDF hosts get the default — we hit each at most once, but a
 * hundred downloads in a burst looks like a scrape.
 */
const HOST_INTERVALS: ReadonlyMap<string, number> = new Map([
	["export.arxiv.org", 3100],
	["arxiv.org", 1500],
	["api.semanticscholar.org", 1100],
	["api.openalex.org", 250],
]);

const DEFAULT_INTERVAL_MS = 1500;

/**
 * Ceiling on a single backoff wait.
 *
 * Rate limits reset on windows measured in seconds; an uncapped exponential
 * backoff turns a busy afternoon into an overnight run that looks like a hang.
 * The same reasoning caps the SDK's provider retries in `run-stage.ts`.
 */
const MAX_BACKOFF_MS = 60_000;

/** A request that never answers should fail the paper, not the run. */
const REQUEST_TIMEOUT_MS = 60_000;

const DEFAULT_MAX_RETRIES = 4;

/**
 * Something the caller should hear about while a request is being retried.
 *
 * Rate limiting is the reason this exists. A backoff of up to a minute is
 * indistinguishable from a hang unless it is announced, and the same trap has
 * already been documented one layer up for the model client's own retries
 * (CLAUDE.md gotcha #21): a 429 storm that is silently absorbed looks like the
 * tool being slow, and the operator's natural response — kill it and start
 * again — makes it strictly worse.
 */
export interface FetchNotice {
	kind: "retry" | "rate-limited";
	url: string;
	/** 1-based index of the retry about to be made. */
	attempt: number;
	maxRetries: number;
	waitMs: number;
	reason: string;
}

export interface PoliteFetcherOptions {
	/** Underlying transport. Defaults to global `fetch`; tests pass their own. */
	fetch?: Fetcher;
	userAgent?: string;
	maxRetries?: number;
	/** Overridable so tests do not spend real seconds proving backoff works. */
	sleep?: (ms: number) => Promise<void>;
	/** Per-host minimum spacing; defaults to the table above. */
	intervals?: ReadonlyMap<string, number>;
	/** Told about every retry and every rate-limit wait. */
	onNotice?: (notice: FetchNotice) => void;
}

/**
 * Serialize per host, space requests out, and retry what is worth retrying.
 *
 * Serialization is per host rather than global so three backends still work in
 * parallel — the arXiv floor of one request per three seconds would otherwise
 * set the pace for everything.
 */
export function createPoliteFetcher(options: PoliteFetcherOptions = {}): Fetcher {
	const transport = options.fetch ?? ((url, init) => globalThis.fetch(url, init));
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const sleep = options.sleep ?? defaultSleep;
	const intervals = options.intervals ?? HOST_INTERVALS;

	/** Tail of the request chain per host; awaiting it is waiting your turn. */
	const queues = new Map<string, Promise<void>>();
	/** Earliest wall-clock time the next request to a host may start. */
	const readyAt = new Map<string, number>();

	return async function politeFetch(url: string, init?: RequestInit): Promise<Response> {
		const host = hostOf(url);
		const interval = intervals.get(host) ?? DEFAULT_INTERVAL_MS;

		const previous = queues.get(host) ?? Promise.resolve();
		let release!: () => void;
		const turn = new Promise<void>((resolve) => {
			release = resolve;
		});
		queues.set(
			host,
			previous.then(() => turn),
		);
		await previous;

		// Space this request from the end of the previous one — back-to-back small
		// requests are what a host notices — but wait for it *here*, on the way in,
		// rather than arming a timer on the way out.
		//
		// The other arrangement deadlocked the process. Releasing the next caller
		// from a `setTimeout` meant that timer had to be unref'd, or a run would sit
		// idle for the interval after its final request; but unref'd it no longer
		// held the event loop open, and between two tool calls there is no socket in
		// flight to hold it either. Node found nothing left to do while the second
		// request was still awaiting its turn, drained the loop, and killed the run
		// mid-stage with "Detected unsettled top-level await" and exit 13. Waiting on
		// entry means the delay exists only while somebody needs it, so it can stay
		// ref'd and there is no trailing timer to suppress.
		const earliest = readyAt.get(host);
		const remaining = earliest === undefined ? 0 : earliest - Date.now();
		if (remaining > 0) await sleep(remaining);

		try {
			return await attempt(url, host, init);
		} finally {
			readyAt.set(host, Date.now() + interval);
			release();
		}
	};

	async function attempt(url: string, host: string, init?: RequestInit): Promise<Response> {
		let lastError: unknown;
		/** Set when the previous response asked for a specific wait. */
		let requestedWaitMs: number | undefined;

		for (let tries = 0; tries <= maxRetries; tries += 1) {
			if (tries > 0) {
				// A server-supplied Retry-After beats our own guess: it knows when its
				// window resets and we do not.
				const backoff = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (tries - 1));
				const wait = requestedWaitMs ?? backoff;
				options.onNotice?.({
					kind: requestedWaitMs === undefined ? "retry" : "rate-limited",
					url,
					attempt: tries,
					maxRetries,
					waitMs: wait,
					reason: lastError instanceof Error ? lastError.message : String(lastError),
				});
				requestedWaitMs = undefined;
				await sleep(wait);
			}

			let response: Response;
			try {
				response = await transport(url, withDefaults(init, host, options.userAgent));
			} catch (cause) {
				// Connection-level failures are worth another go; a caller that has
				// exhausted them gets the last error as a value, not a throw.
				lastError = cause;
				continue;
			}

			if (!isRetryable(response.status)) return response;
			lastError = new Error(`HTTP ${response.status}`);
			requestedWaitMs = retryAfterMs(response);
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
}

function withDefaults(
	init: RequestInit | undefined,
	host: string,
	override: string | undefined,
): RequestInit {
	const headers = new Headers(init?.headers);
	if (!headers.has("user-agent")) headers.set("user-agent", userAgentFor(host, override));
	if (!headers.has("accept")) headers.set("accept", "application/json, application/atom+xml, */*");

	// Scoped to the one host that issued it. Set on every request, as it first
	// was, the key travelled to each publisher server a PDF is downloaded from —
	// dozens of third parties receiving a credential they never asked for and
	// cannot be expected to protect. A leaked key is a different class of problem
	// from a leaked contact address, so this is the narrower rule of the two.
	if (host === SEMANTIC_SCHOLAR_HOST && !headers.has("x-api-key")) {
		const key = env("SEMANTIC_SCHOLAR_API_KEY");
		if (key !== undefined) headers.set("x-api-key", key);
	}

	return {
		...init,
		headers,
		signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	};
}

/**
 * `pi-scribarium/<version>`, plus a contact address for the hosts that asked.
 *
 * The address is what the polite pools trade a higher rate limit for, and it is
 * how a host reaches a human when a client misbehaves. It is not a secret, but
 * it is personal data, and it goes only to the endpoints whose published terms
 * request it — never to a publisher's download server.
 */
function userAgentFor(host: string, override: string | undefined): string {
	if (override !== undefined) return override;

	const email = CONTACT_HOSTS.has(host) ? env("SCRIBARIUM_CONTACT_EMAIL") : undefined;
	return email === undefined
		? `pi-scribarium/${VERSION}`
		: `pi-scribarium/${VERSION} (mailto:${email})`;
}

/** An unset variable and one set to blank or whitespace mean the same thing. */
function env(name: string): string | undefined {
	const value = process.env[name]?.trim();
	return value === undefined || value === "" ? undefined : value;
}

function isRetryable(status: number): boolean {
	return status === 429 || status === 408 || (status >= 500 && status < 600);
}

/** `Retry-After` is either delta-seconds or an HTTP date. Both appear in the wild. */
function retryAfterMs(response: Response): number | undefined {
	const header = response.headers.get("retry-after");
	if (header === null) return undefined;

	const seconds = Number.parseFloat(header);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);

	const date = Date.parse(header);
	if (Number.isFinite(date)) return Math.max(0, date - Date.now());

	return undefined;
}

function hostOf(url: string): string {
	try {
		return new URL(url).host;
	} catch {
		return url;
	}
}

/**
 * Deliberately not `unref`'d.
 *
 * Every caller is awaiting this, so a timer that does not hold the event loop
 * open lets the process exit out from under the wait. That is not a hang that
 * resolves late — node reports "Detected unsettled top-level await" and leaves
 * with exit 13, so a rate-limit backoff would end the run instead of surviving it.
 */
function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/** Read a response body as text, or explain why it could not be read. */
export async function readText(response: Response, what: string): Promise<string> {
	if (!response.ok) {
		throw new Error(`${what}: HTTP ${response.status} ${response.statusText}`.trimEnd());
	}
	try {
		return await response.text();
	} catch (cause) {
		throw new Error(`${what}: could not read response body (${String(cause)})`);
	}
}

/** Read a response body as JSON, or explain why it could not be parsed. */
export async function readJson<T>(response: Response, what: string): Promise<T> {
	const body = await readText(response, what);
	try {
		return JSON.parse(body) as T;
	} catch {
		// The first line is usually an HTML error page or a rate-limit notice, and
		// quoting it is far more useful than "unexpected token < in JSON".
		const head = body.trim().split("\n", 1)[0] ?? "";
		throw new Error(`${what}: response was not JSON (${head.slice(0, 120)})`);
	}
}
