/**
 * Ctrl-C that always works.
 *
 * Installing a SIGINT handler replaces node's default, which is to terminate the
 * process. Ours only aborted an `AbortController`, and the abort that follows is
 * cooperative all the way down: the engine asks the stage to stop, `runStage`
 * asks the session, and `session.abort()` resolves only once the session is
 * idle — which a stage wedged inside a tool call it cannot interrupt never
 * becomes. So the first Ctrl-C appeared to do nothing, and every later one did
 * exactly as little, since aborting an already-aborted controller is a no-op.
 *
 * That left Ctrl-Z as the only way out, which suspends a process rather than
 * ending it: two of them accumulated in one afternoon, each still holding its
 * memory and the inspector port, and both looked to their owner like runs that
 * had been stopped.
 *
 * So: the first press asks politely and *says* that it has, because a graceful
 * stop that prints nothing is indistinguishable from a key that did not
 * register. The second press leaves immediately. Every step boundary is
 * checkpointed, so leaving costs at most the step in flight.
 */
export interface InterruptOptions {
	/** Shown on the first press. Should say what is being waited for. */
	message?: string;
	/** Shown on the second. Should say how to pick the work back up. */
	forcedMessage?: string;
}

const FORCED_EXIT_CODE = 130;

export function onInterrupt(
	controller: AbortController,
	options: InterruptOptions = {},
): () => void {
	const message =
		options.message ?? "\ninterrupted; stopping after the current step (resume to continue)";
	const forced = options.forcedMessage ?? "forced; the run is checkpointed and can be resumed";

	let asked = false;
	const handler = (): void => {
		if (asked) {
			process.stderr.write(`\n${forced}\n`);
			// Deliberately abrupt. By the second press the cooperative path has
			// already failed to release, and anything still pending is pending on
			// something that is not going to finish.
			process.exit(FORCED_EXIT_CODE);
		}
		asked = true;
		process.stderr.write(`${message}\npress Ctrl-C again to quit now\n`);
		controller.abort();
	};

	process.on("SIGINT", handler);
	return () => process.off("SIGINT", handler);
}
