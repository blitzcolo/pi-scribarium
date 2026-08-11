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

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

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

export interface PoliteFetcherOptions {
	/** Underlying transport. Defaults to global `fetch`; tests pass their own. */
	fetch?: Fetcher;
	userAgent?: string;
	maxRetries?: number;
	/** Overridable so tests do not spend real seconds proving backoff works. */
	sleep?: (ms: number) => Promise<void>;
	/** Per-host minimum spacing; defaults to the table above. */
	intervals?: ReadonlyMap<string, number>;
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
	const userAgent = options.userAgent ?? defaultUserAgent();

	/** Tail of the request chain per host; awaiting it is waiting your turn. */
	const queues = new Map<string, Promise<void>>();

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

		try {
			return await attempt(url, init);
		} finally {
			// Space the *next* request from the end of this one rather than sleeping
			// before each: back-to-back small requests are what a host notices.
			setTimeout(release, interval).unref?.();
		}
	};

	async function attempt(url: string, init?: RequestInit): Promise<Response> {
		let lastError: unknown;

		for (let tries = 0; tries <= maxRetries; tries += 1) {
			if (tries > 0) {
				await sleep(Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (tries - 1)));
			}

			let response: Response;
			try {
				response = await transport(url, withDefaults(init, userAgent));
			} catch (cause) {
				// Connection-level failures are worth another go; a caller that has
				// exhausted them gets the last error as a value, not a throw.
				lastError = cause;
				continue;
			}

			if (!isRetryable(response.status)) return response;
			lastError = new Error(`HTTP ${response.status}`);

			const after = retryAfterMs(response);
			if (after !== undefined && tries < maxRetries) {
				await sleep(Math.min(MAX_BACKOFF_MS, after));
			}
		}

		throw lastError instanceof Error ? lastError : new Error(String(lastError));
	}
}

function withDefaults(init: RequestInit | undefined, userAgent: string): RequestInit {
	const headers = new Headers(init?.headers);
	if (!headers.has("user-agent")) headers.set("user-agent", userAgent);
	if (!headers.has("accept")) headers.set("accept", "application/json, application/atom+xml, */*");

	const key = process.env["SEMANTIC_SCHOLAR_API_KEY"];
	if (key !== undefined && key !== "" && !headers.has("x-api-key")) headers.set("x-api-key", key);

	return {
		...init,
		headers,
		signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	};
}

/**
 * A contact address is what the polite pools ask for in exchange for their
 * higher rate limits, and it is how a host reaches a human when a client
 * misbehaves.
 */
function defaultUserAgent(): string {
	const mailto = process.env["SCRIBARIUM_MAILTO"];
	const contact = mailto !== undefined && mailto !== "" ? ` (mailto:${mailto})` : "";
	return `pi-scribarium/0.2.0${contact}`;
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

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms).unref?.();
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
