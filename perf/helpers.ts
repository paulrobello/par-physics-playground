import os from "node:os";
import type { Page } from "@playwright/test";

/**
 * Shared perf-harness helpers (local-only per D14). Load guards: the host
 * 1-min load average must be ≤ 15 before and after a measured run; a run
 * whose post-load exceeded the limit is discarded and re-measured once.
 */

export const WARMUP_FRAMES = 120;
export const MEASURED_FRAMES = 1000;
export const LOAD_LIMIT = 15;
export const MAX_ATTEMPTS = 2; // first attempt + one re-run for a load-broken sample

/** Host 1-minute load average (noUncheckedIndexedAccess: index may be absent). */
export function load1min(): number {
	return os.loadavg()[0] ?? 0;
}

/** Bounded wait for the host 1-min load average to drop to ≤ 15. */
export async function waitForCalm(deadlineMs = 120_000): Promise<number> {
	const start = Date.now();
	for (;;) {
		const load = load1min();
		if (load <= LOAD_LIMIT) return load;
		if (Date.now() - start > deadlineMs) {
			throw new Error(
				`host 1-min load ${load.toFixed(1)} still > ${LOAD_LIMIT} after ${Math.round(deadlineMs / 1000)}s`,
			);
		}
		await new Promise((resolve) => setTimeout(resolve, 5_000));
	}
}

/**
 * Unpause the debug-frozen sim and measure rAF fps over MEASURED_FRAMES
 * after WARMUP_FRAMES — the full physics + render pipeline in real time.
 */
export async function measureFps(page: Page): Promise<number> {
	await page.click('[data-sim="pause"]');
	return page.evaluate(
		({ warmup, measured }) =>
			new Promise<number>((resolve) => {
				let frames = 0;
				let t0 = 0;
				const frame = (t: number) => {
					if (frames === warmup) t0 = t;
					if (frames === warmup + measured) {
						resolve((measured * 1000) / (t - t0));
						return;
					}
					frames += 1;
					requestAnimationFrame(frame);
				};
				requestAnimationFrame(frame);
			}),
		{ warmup: WARMUP_FRAMES, measured: MEASURED_FRAMES },
	);
}

/**
 * The load-guarded measurement loop shared by every perf case: wait for
 * calm, measure, re-guard after; a load-broken sample is re-measured once.
 * Returns the valid fps sample plus the before/after load for the evidence
 * record.
 */
export async function runGuarded(
	page: Page,
): Promise<{ fps: number; loadBefore: number; loadAfter: number }> {
	let fps = 0;
	let loadAfter = 0;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		// Every attempt re-guards: a prior attempt's own load may still be
		// decaying when the retry starts.
		const loadBefore = await waitForCalm();
		console.log(
			`[perf] attempt ${attempt}: load before: ${loadBefore.toFixed(2)}`,
		);
		fps = await measureFps(page);
		loadAfter = load1min();
		console.log(
			`[perf] attempt ${attempt}: ${fps.toFixed(1)} fps, load after: ${loadAfter.toFixed(2)}`,
		);
		if (loadAfter <= LOAD_LIMIT) return { fps, loadBefore, loadAfter };
		if (attempt === MAX_ATTEMPTS) {
			throw new Error(
				`post-run load ${loadAfter.toFixed(2)} > ${LOAD_LIMIT} on all ${MAX_ATTEMPTS} attempts; sample invalid`,
			);
		}
	}
	throw new Error("unreachable");
}
