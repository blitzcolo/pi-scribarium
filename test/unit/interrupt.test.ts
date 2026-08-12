import { afterEach, describe, expect, it } from "vitest";

import { onInterrupt } from "../../src/cli/interrupt.js";

/**
 * Ctrl-C used to be swallowed by the very handler meant to serve it.
 *
 * Installing a SIGINT listener replaces node's default, which is to terminate;
 * ours only aborted a controller, and everything downstream of that abort is
 * cooperative — `session.abort()` resolves once the session is idle, which a
 * stage wedged inside a tool call it cannot interrupt never becomes. The first
 * press therefore looked like nothing, and every later press did exactly as
 * little, because aborting an aborted controller is a no-op. The only way out
 * was Ctrl-Z, which suspends rather than ends: two such processes accumulated in
 * an afternoon, each still holding its memory and the inspector port, and both
 * looked to their owner like runs that had been stopped.
 */

const released: Array<() => void> = [];
let restoreExit: (() => void) | undefined;
let restoreWrite: (() => void) | undefined;

afterEach(() => {
	for (const release of released.splice(0)) release();
	restoreExit?.();
	restoreWrite?.();
	restoreExit = undefined;
	restoreWrite = undefined;
});

/** Records exit codes instead of taking the process down with the suite. */
function captureExit(): { codes: number[] } {
	const codes: number[] = [];
	const real = process.exit;
	(process as { exit: unknown }).exit = (code?: number): void => {
		codes.push(code ?? 0);
	};
	restoreExit = () => {
		(process as { exit: unknown }).exit = real;
	};
	return { codes };
}

function captureStderr(): { text: () => string } {
	let buffer = "";
	const real = process.stderr.write.bind(process.stderr);
	process.stderr.write = ((chunk: string | Uint8Array): boolean => {
		buffer += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	restoreWrite = () => {
		process.stderr.write = real;
	};
	return { text: () => buffer };
}

function arm(controller: AbortController): void {
	released.push(onInterrupt(controller));
}

describe("onInterrupt", () => {
	it("aborts on the first press", () => {
		captureStderr();
		const controller = new AbortController();
		arm(controller);

		process.emit("SIGINT");

		expect(controller.signal.aborted).toBe(true);
	});

	// A graceful stop that prints nothing is indistinguishable from a key that
	// never registered, which is what sent a user looking for Ctrl-Z.
	it("says that it heard, and that pressing again quits", () => {
		const stderr = captureStderr();
		arm(new AbortController());

		process.emit("SIGINT");

		expect(stderr.text()).toContain("interrupted");
		expect(stderr.text()).toContain("again");
	});

	it("exits on the second press rather than repeating a no-op", () => {
		captureStderr();
		const exit = captureExit();
		arm(new AbortController());

		process.emit("SIGINT");
		expect(exit.codes).toEqual([]);

		process.emit("SIGINT");
		expect(exit.codes).toEqual([130]);
	});

	it("stops listening once released, restoring the default", () => {
		captureStderr();
		const controller = new AbortController();
		const release = onInterrupt(controller);
		release();

		// No listener of ours left; node's own default handling is back in force.
		expect(process.listenerCount("SIGINT")).toBe(0);
	});
});
