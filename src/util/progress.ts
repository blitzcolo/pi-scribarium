/**
 * Progress and time formatting for long unattended stages.
 *
 * A hundred-paper fan-out and a rate-limited download queue both run for many
 * minutes with nothing to show, and the failure they are most often confused
 * with is a hang. A counter says work is happening; an estimate says whether to
 * wait or go and do something else.
 */

/** `45s`, `2m30s`, `1h05m` — two units at most, because this is glanced at. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;

	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) {
		const rest = seconds % 60;
		return rest === 0 ? `${minutes}m` : `${minutes}m${String(rest).padStart(2, "0")}s`;
	}

	const hours = Math.floor(minutes / 60);
	const rest = minutes % 60;
	return rest === 0 ? `${hours}h` : `${hours}h${String(rest).padStart(2, "0")}m`;
}

/**
 * Items to finish before an estimate is offered.
 *
 * The first item of a stage carries one-off costs — a cold connection, a
 * session being built — so extrapolating from it overstates the remainder
 * badly. Three is enough to stop the number swinging on every tick.
 */
const MIN_SAMPLES = 3;

/**
 * `[12/100] ~4m left`, or just `[1/100]` until an estimate would be honest.
 *
 * Deliberately a mean rather than a smarter model: the work is heterogeneous
 * (a paywalled paper costs one API call, an open-access one costs a download)
 * and a confident-looking estimate that is wrong is worse than a rough one.
 * The tilde is doing real work.
 */
export function progressLabel(done: number, total: number, elapsedMs: number): string {
	const counter = `[${done}/${total}]`;
	if (done < MIN_SAMPLES || done >= total || elapsedMs <= 0) return counter;

	const remaining = ((total - done) * elapsedMs) / done;
	return `${counter} ~${formatDuration(remaining)} left`;
}
