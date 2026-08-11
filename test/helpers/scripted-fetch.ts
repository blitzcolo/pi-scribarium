import type { Fetcher } from "../../src/search/http.js";

/**
 * The HTTP counterpart to `scripted-provider.ts`.
 *
 * It replaces only the wire: the adapters parse real captured responses, the
 * dedupe and cap logic runs for real, and the builtins write real files. What it
 * also buys is the negative assertion — `requests` is the complete list of URLs
 * a run touched, so a step that is supposed to be offline can be proven to have
 * made none.
 *
 * An unmatched URL throws rather than answering 404. An empty result is a
 * legitimate outcome in this domain (a follow-up reference genuinely not in an
 * index), so a forgotten route that answered 404 would look like a passing test
 * of the wrong thing.
 */

export interface ScriptedRoute {
	/** Substring, pattern, or predicate over the full URL. */
	match: string | RegExp | ((url: string) => boolean);
	status?: number;
	/** Strings and buffers are sent as-is; anything else is JSON-encoded. */
	body?: string | Uint8Array | object;
	headers?: Record<string, string>;
	/** Fail the request at the transport level, the way a dead host does. */
	networkError?: string;
}

export interface ScriptedFetch {
	fetch: Fetcher;
	/** Every URL requested, in order. */
	requests: string[];
}

export function scriptedFetcher(routes: readonly ScriptedRoute[]): ScriptedFetch {
	const requests: string[] = [];

	const fetch: Fetcher = async (url) => {
		requests.push(url);
		const route = routes.find((candidate) => matches(candidate.match, url));
		if (route === undefined) {
			throw new Error(
				`scriptedFetcher: no route for ${url}\nRoutes: ${routes
					.map((r) => String(r.match))
					.join(", ")}`,
			);
		}
		if (route.networkError !== undefined) throw new Error(route.networkError);

		const body =
			route.body === undefined
				? ""
				: typeof route.body === "string" || route.body instanceof Uint8Array
					? route.body
					: JSON.stringify(route.body);

		return new Response(body as BodyInit, {
			status: route.status ?? 200,
			headers: route.headers ?? {},
		});
	};

	return { fetch, requests };
}

function matches(match: ScriptedRoute["match"], url: string): boolean {
	if (typeof match === "string") return url.includes(match);
	if (match instanceof RegExp) return match.test(url);
	return match(url);
}

/** A fetcher that fails every request — for asserting a step never reaches the network. */
export function offlineFetcher(): ScriptedFetch {
	const requests: string[] = [];
	return {
		requests,
		fetch: async (url) => {
			requests.push(url);
			throw new Error(`offlineFetcher: this step must not make network requests (tried ${url})`);
		},
	};
}
