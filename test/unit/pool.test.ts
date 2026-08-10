import { describe, expect, it } from "vitest";

import { MAX_CONCURRENCY, mapPool, type Settled } from "../../src/pipeline/pool.js";

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tracks how many calls are in flight at once. */
function concurrencyProbe() {
	let active = 0;
	let peak = 0;
	return {
		get peak() {
			return peak;
		},
		async run<T>(work: () => Promise<T>): Promise<T> {
			active++;
			peak = Math.max(peak, active);
			try {
				return await work();
			} finally {
				active--;
			}
		},
	};
}

function values<T>(results: Array<Settled<T>>): Array<T | undefined> {
	return results.map((r) => (r.ok ? r.value : undefined));
}

describe("mapPool", () => {
	it("returns results in input order regardless of completion order", async () => {
		const items = [30, 10, 20, 0];
		const results = await mapPool(items, 4, async (ms, index) => {
			await tick(ms);
			return index;
		});

		expect(values(results)).toEqual([0, 1, 2, 3]);
	});

	it("never exceeds the requested concurrency", async () => {
		const probe = concurrencyProbe();
		await mapPool(Array.from({ length: 20 }, (_, i) => i), 3, (i) =>
			probe.run(async () => {
				await tick(5);
				return i;
			}),
		);

		expect(probe.peak).toBe(3);
	});

	it("clamps concurrency to the hard ceiling", async () => {
		const probe = concurrencyProbe();
		await mapPool(Array.from({ length: 40 }, (_, i) => i), 999, (i) =>
			probe.run(async () => {
				await tick(2);
				return i;
			}),
		);

		expect(probe.peak).toBe(MAX_CONCURRENCY);
	});

	// The point of the pool: one unreadable paper out of thirty must not discard
	// the twenty-nine that have already been paid for.
	it("isolates a failing item and completes the rest", async () => {
		const results = await mapPool([0, 1, 2, 3, 4], 2, async (i) => {
			if (i === 2) throw new Error("item 2 exploded");
			return i * 10;
		});

		expect(results.filter((r) => r.ok)).toHaveLength(4);
		expect(results[2]?.ok).toBe(false);
		expect(results[2]?.ok === false ? results[2].error.message : "").toBe("item 2 exploded");
		expect(values(results)).toEqual([0, 10, undefined, 30, 40]);
	});

	it("wraps a non-Error rejection", async () => {
		const results = await mapPool([1], 1, async () => {
			throw "just a string";
		});
		expect(results[0]?.ok === false ? results[0].error.message : "").toBe("just a string");
	});

	it("reports each settle as it happens, for checkpointing", async () => {
		const settled: Array<[number, boolean]> = [];
		await mapPool([0, 1, 2], 1, async (i) => {
			if (i === 1) throw new Error("nope");
			return i;
		}, { onSettled: (index, result) => settled.push([index, result.ok]) });

		expect(settled).toEqual([
			[0, true],
			[1, false],
			[2, true],
		]);
	});

	describe("maxFailures", () => {
		it("stops scheduling further work once the budget is spent", async () => {
			const started: number[] = [];
			const results = await mapPool(
				Array.from({ length: 20 }, (_, i) => i),
				1,
				async (i) => {
					throw new Error(`fail ${i}`);
				},
				{ maxFailures: 3, onStart: (index) => started.push(index) },
			);

			expect(started).toHaveLength(3);
			// Items never attempted still carry a value rather than a hole.
			expect(results).toHaveLength(20);
			expect(results.every((r) => !r.ok)).toBe(true);
			expect(results[19]?.ok === false ? results[19].error.message : "").toMatch(/cancelled/);
		});

		// The failure that dominates in practice — a stage that ran and reported it
		// never wrote its declared output — resolves rather than throws, so a budget
		// that only counted rejections would run every item before giving up.
		it("counts a failure the item reported rather than threw", async () => {
			const started: number[] = [];
			await mapPool(
				Array.from({ length: 20 }, (_, i) => i),
				1,
				async (i) => ({ failed: true, i }),
				{
					maxFailures: 3,
					isFailure: (value) => value.failed,
					onStart: (index) => started.push(index),
				},
			);

			expect(started).toHaveLength(3);
		});

		it("does not trip while failures stay under budget", async () => {
			const results = await mapPool([0, 1, 2, 3], 2, async (i) => {
				if (i === 0) throw new Error("only one");
				return i;
			}, { maxFailures: 3 });

			expect(results.filter((r) => r.ok)).toHaveLength(3);
		});
	});

	it("hands running work a signal and starts nothing after an external abort", async () => {
		const controller = new AbortController();
		const observed: boolean[] = [];

		const pending = mapPool([0, 1], 1, async (_item, _index, signal) => {
			observed.push(signal.aborted);
			await tick(5);
			return 1;
		}, { signal: controller.signal });

		controller.abort();
		const results = await pending;

		// The first item started before the abort and is left to wind down through
		// the signal. The second must never start: a cancelled run that keeps
		// launching sessions bills the user for work they asked it to stop.
		expect(observed).toEqual([false]);
		expect(results[1]?.ok === false ? results[1].error.message : "").toMatch(/cancelled/);
	});

	// The observer checkpoints to disk, so a throw there is real and must surface.
	// It must not surface by rejecting a worker mid-loop, though: that leaves the
	// siblings running detached, still billing and still writing shared state after
	// the caller has already been handed a result.
	it("reports an observer failure without abandoning the running workers", async () => {
		const finished: number[] = [];
		await expect(
			mapPool(
				Array.from({ length: 10 }, (_, i) => i),
				2,
				async (i) => {
					await tick(2);
					finished.push(i);
					return i;
				},
				{
					onSettled: (index) => {
						if (index === 0) throw new Error("disk full");
					},
				},
			),
		).rejects.toThrow(/disk full/);

		// Nothing was still in flight when the rejection surfaced, and the pool
		// stopped rather than working through the remaining eight items.
		expect(finished.length).toBeLessThan(10);
	});

	it("handles an empty item list", async () => {
		expect(await mapPool([], 4, async () => 1)).toEqual([]);
	});
});
