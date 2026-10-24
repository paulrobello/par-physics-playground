import os from "node:os";
import { expect, type Page, test } from "@playwright/test";

/**
 * Perf smoke (local-only per D14, its own Playwright config): spawn 200 boxes
 * through the existing `?debug=1` spawn hooks, warm up, then measure 1000
 * frames of the real-time (non-debug) sim. Fails below 60 fps. Load guards:
 * host 1-min load average must be ≤ 15 before and after the measured run; a
 * run whose post-load exceeded the limit is discarded and re-measured once.
 */

const BOX_COUNT = 200;
const WARMUP_FRAMES = 120;
const MEASURED_FRAMES = 1000;
const LOAD_LIMIT = 15;
const MAX_ATTEMPTS = 2; // first attempt + one re-run for a load-broken sample

/** Host 1-minute load average (noUncheckedIndexedAccess: index may be absent). */
function load1min(): number {
	return os.loadavg()[0] ?? 0;
}

/** Bounded wait for the host 1-min load average to drop to ≤ 15. */
async function waitForCalm(deadlineMs = 120_000): Promise<number> {
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

/** Spawns the box grid and measures rAF fps over MEASURED_FRAMES after warmup. */
async function measureFps(page: Page): Promise<number> {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.evaluate((count) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		// 10-wide grid stacked above the ground line (y-down: negative y is up).
		for (let i = 0; i < count; i++) {
			const col = i % 10;
			const row = Math.floor(i / 10);
			ppg.spawnBox(`perf-${i}`, -198 + col * 44, -40 - row * 44, 20, 20);
		}
	}, BOX_COUNT);
	// Debug mode freezes the real-time feed; the Play control unpauses it so
	// the measured frames run the full physics + render pipeline in real time.
	await page.click('[data-sim="pause"]');
	const fps = await page.evaluate(
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
	return fps;
}

test("200-body scene holds 60 fps", async ({ page }) => {
	test.setTimeout(300_000);

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
		if (loadAfter <= LOAD_LIMIT) break;
		if (attempt === MAX_ATTEMPTS) {
			throw new Error(
				`post-run load ${loadAfter.toFixed(2)} > ${LOAD_LIMIT} on all ${MAX_ATTEMPTS} attempts; sample invalid`,
			);
		}
	}
	expect(loadAfter).toBeLessThanOrEqual(LOAD_LIMIT);

	// The perf gate's own pass/fail: 200 bodies must hold 60 fps.
	expect(fps).toBeGreaterThanOrEqual(60);
});
