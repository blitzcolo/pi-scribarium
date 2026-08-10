/** Hard ceiling on concurrent sessions, matching pi's own subagent example. */
export const MAX_CONCURRENCY = 8;
export const DEFAULT_CONCURRENCY = 4;

export type Settled<T> = { ok: true; value: T } | { ok: false; error: Error };

export interface MapPoolOptions<T> {
	/** Stop scheduling new work once this many items have failed. */
	maxFailures?: number;
	/** External cancellation. */
	signal?: AbortSignal;
	/** Called as each item settles, in completion order — used to checkpoint. */
	onSettled?: (index: number, result: Settled<T>) => void;
	/** Called when an item is about to start. */
	onStart?: (index: number) => void;
}

/**
 * Run `fn` over `items` with bounded concurrency.
 *
 * Failures are values, not exceptions. `fn` is wrapped inside each worker, so a
 * rejection is recorded against its own item and never reaches `Promise.all` —
 * one unreadable paper out of thirty must not discard the other twenty-nine,
 * which have already been paid for.
 *
 * Results are returned in input order regardless of completion order, so a
 * reducer sees a stable list.
 */
export async function mapPool<I, O>(
	items: readonly I[],
	concurrency: number,
	fn: (item: I, index: number, signal: AbortSignal) => Promise<O>,
	options: MapPoolOptions<O> = {},
): Promise<Array<Settled<O>>> {
	const results = new Array<Settled<O>>(items.length);
	if (items.length === 0) return results;

	const limit = Math.max(1, Math.min(concurrency, items.length, MAX_CONCURRENCY));

	// An internal controller lets maxFailures cancel work already in flight,
	// rather than merely declining to schedule more.
	const internal = new AbortController();
	const signal =
		options.signal === undefined
			? internal.signal
			: AbortSignal.any([options.signal, internal.signal]);

	let next = 0;
	let failures = 0;

	const worker = async (): Promise<void> => {
		for (;;) {
			// Stop scheduling on either abort: the internal one a spent failure
			// budget raises, and an external cancel. Work already in flight is
			// wound down through the signal handed to `fn`, but nothing new may
			// start — a cancelled run that keeps launching sessions bills the user
			// for every item they asked it not to run.
			if (signal.aborted) return;

			const index = next++;
			if (index >= items.length) return;

			options.onStart?.(index);
			let settled: Settled<O>;
			try {
				settled = { ok: true, value: await fn(items[index] as I, index, signal) };
			} catch (error) {
				settled = { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
			}

			results[index] = settled;
			options.onSettled?.(index, settled);

			if (!settled.ok && options.maxFailures !== undefined && ++failures >= options.maxFailures) {
				internal.abort();
				return;
			}
		}
	};

	await Promise.all(Array.from({ length: limit }, worker));

	// Items never started because the run was cut short still need a value.
	for (let i = 0; i < results.length; i++) {
		if (results[i] === undefined) {
			results[i] = { ok: false, error: new Error("cancelled before starting") };
		}
	}
	return results;
}
