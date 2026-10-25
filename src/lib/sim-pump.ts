/**
 * Sim time pump (the "super slow motion at 1x" fix): the sim clock used to
 * be fed only from the render loop's rAF callback, so when heavy host load
 * starved rAF below the accumulator's catch-up cap (≈12 fps), sim time fell
 * behind wall time and the world visibly ran in slow motion. The pump is
 * now the SINGLE timekeeper: the render loop AND a fallback interval both
 * call {@link SimPump.pump}, and whoever fires consumes the real elapsed
 * wall time since the LAST PUMP — so wall time is consumed exactly once no
 * matter which cadence is live, the accumulator semantics are unchanged,
 * and a stalled render loop can no longer stall the sim. (While rAF is
 * healthy the interval is a constant zero-length no-op; in a background tab
 * the throttled interval feeds coarse bursts the catch-up cap bounds, the
 * same behavior as before.)
 */
export interface SimPump {
	/** Consume wall time since the previous pump (no-op on the first call). */
	pump(): void;
	/** Stop the fallback interval. */
	dispose(): void;
}

/**
 * @param advance wall seconds to feed (the caller applies the time scale —
 *   the pump is scale-agnostic)
 * @param now monotonic milliseconds (injected: tests use a fake clock)
 * @param intervalMs fallback polling cadence
 */
export function createSimPump(
	advance: (seconds: number) => void,
	now: () => number,
	intervalMs = 100,
): SimPump {
	let lastPumpMs: number | undefined;
	const pump = (): void => {
		const t = now();
		if (lastPumpMs !== undefined) {
			const elapsedSeconds = (t - lastPumpMs) / 1000;
			if (elapsedSeconds > 0) advance(elapsedSeconds);
		}
		lastPumpMs = t;
	};
	const timer = setInterval(pump, intervalMs);
	return {
		pump,
		dispose: () => clearInterval(timer),
	};
}
