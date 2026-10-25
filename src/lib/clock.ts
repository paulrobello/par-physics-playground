/**
 * Fixed-step accumulator clock (line-run pattern, trimmed to this codebase):
 * wall-clock frames are converted into an exact number of fixed ticks, with the
 * fp remainder carried between frames so long runs do not drift.
 */

export const SIM_TICK_HZ = 60;
export const SIM_DT_SECONDS = 1 / SIM_TICK_HZ;

export interface TickContext {
	readonly tick: number;
	readonly dtSeconds: number;
}

export type TickListener = (context: TickContext) => void;

export interface SimClockOptions {
	readonly maxCatchUpSteps?: number;
}

export class SimClock {
	readonly fixedDtSeconds: number;
	readonly maxCatchUpSteps: number;

	private accumulatorSeconds = 0;
	private tickCount = 0;
	private droppedSecondsTotal = 0;
	private paused = false;
	private readonly listeners = new Set<TickListener>();

	constructor(options: SimClockOptions = {}) {
		this.fixedDtSeconds = SIM_DT_SECONDS;
		this.maxCatchUpSteps = options.maxCatchUpSteps ?? 24;
		if (
			!Number.isFinite(this.fixedDtSeconds) ||
			this.fixedDtSeconds <= 0 ||
			!Number.isInteger(this.maxCatchUpSteps) ||
			this.maxCatchUpSteps <= 0
		)
			throw new RangeError(
				"Clock interval and catch-up limit must be positive finite values",
			);
	}

	get tick(): number {
		return this.tickCount;
	}

	/**
	 * Sim time dropped by the catch-up limit so far (seconds): the fixed-step
	 * clock discards excess backlog instead of death-spiraling — surfaced for
	 * the debug telemetry (`__ppg.simTelemetry()`).
	 */
	get droppedSeconds(): number {
		return this.droppedSecondsTotal;
	}

	/** Fraction of the next tick already accumulated; supports render interpolation. */
	get interpolationAlpha(): number {
		return this.accumulatorSeconds / this.fixedDtSeconds;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	setPaused(paused: boolean): void {
		this.paused = paused;
	}

	subscribe(listener: TickListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	/** Feed one wall-clock frame; advances 0..maxCatchUpSteps ticks. No-op while paused. */
	advanceRealTime(elapsedSeconds: number): void {
		if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0)
			throw new RangeError("elapsedSeconds must be finite and non-negative");
		if (this.paused) return;
		this.accumulate(elapsedSeconds, this.maxCatchUpSteps);
	}

	/**
	 * Debug/deterministic single-step: fires exactly one tick regardless of
	 * pause, discarding any partial-frame remainder so the step is exact even
	 * when the accumulator holds a leftover from an earlier partial advance.
	 */
	stepOnce(): void {
		this.accumulatorSeconds = 0;
		this.tickOnce();
	}

	/**
	 * Debug/deterministic path (`advanceTime`): advances sim time regardless of
	 * pause, with no catch-up cap, so a test gets exactly floor(seconds / dt) ticks.
	 */
	advanceSimTime(seconds: number): void {
		if (!Number.isFinite(seconds) || seconds < 0)
			throw new RangeError("seconds must be finite and non-negative");
		this.accumulate(seconds, Number.POSITIVE_INFINITY);
	}

	private accumulate(seconds: number, maxSteps: number): void {
		this.accumulatorSeconds += seconds;
		const tolerance = this.fixedDtSeconds * 1e-9;
		let steps = 0;
		while (
			this.accumulatorSeconds + tolerance >= this.fixedDtSeconds &&
			steps < maxSteps
		) {
			this.accumulatorSeconds -= this.fixedDtSeconds;
			this.tickOnce();
			steps += 1;
		}
		// Beyond the real-time catch-up cap, drop the excess rather than spiral.
		if (steps === maxSteps) {
			const excess = Math.floor(
				(this.accumulatorSeconds + tolerance) / this.fixedDtSeconds,
			);
			if (excess > 0) {
				this.accumulatorSeconds -= excess * this.fixedDtSeconds;
				this.droppedSecondsTotal += excess * this.fixedDtSeconds;
			}
		}
	}

	private tickOnce(): void {
		this.tickCount += 1;
		const context: TickContext = {
			tick: this.tickCount,
			dtSeconds: this.fixedDtSeconds,
		};
		for (const listener of this.listeners) listener(context);
	}
}
