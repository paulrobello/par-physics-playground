import { expect, test } from "@playwright/test";
import { LOAD_LIMIT, runGuarded } from "./helpers";

/**
 * Perf smoke (local-only per D14, its own Playwright config): spawn 200 boxes
 * through the existing `?debug=1` spawn hooks, warm up, then measure 1000
 * frames of the real-time (non-debug) sim. Fails below 60 fps.
 */

test("200-body scene holds 60 fps", async ({ page }) => {
	test.setTimeout(300_000);
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	// 10-wide grid stacked above the ground line (y-down: negative y is up).
	await page.evaluate((count) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		for (let i = 0; i < count; i++) {
			const col = i % 10;
			const row = Math.floor(i / 10);
			ppg.spawnBox(`perf-${i}`, -198 + col * 44, -40 - row * 44, 20, 20);
		}
	}, 200);
	const { fps, loadAfter } = await runGuarded(page);
	expect(loadAfter).toBeLessThanOrEqual(LOAD_LIMIT);

	// The perf gate's own pass/fail: 200 bodies must hold 60 fps.
	expect(fps).toBeGreaterThanOrEqual(60);
});
