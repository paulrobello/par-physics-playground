import { expect, test } from "@playwright/test";

/**
 * Deterministic-settle test: with the debug clock frozen (`?debug=1` pauses the
 * real-time feed), `advanceTime` alone drives the sim, so two independent runs
 * of the same scripted sequence must land the box within float tolerance.
 */
test("dropped box settles on the ground deterministically", async ({
	page,
}) => {
	const settle = async (): Promise<{ x: number; y: number }> => {
		await page.goto("/?debug=1");
		await page.waitForFunction(() => window.__ppg !== undefined);
		const result = await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			ppg.spawnBox("e2e-box", 0, -100, 25, 25);
			ppg.advanceTime(10000);
			const pos = ppg.bodyPosition("e2e-box");
			if (!pos) throw new Error("box was culled, not settled");
			return { x: pos.x, y: pos.y, tick: ppg.tick() };
		});
		expect(result.tick).toBe(600);
		// Restitution 0.1 lets the box bounce and tilt a little on landing, so x
		// drifts sub-unit; run-to-run identity (below) is the determinism proof.
		expect(Math.abs(result.x)).toBeLessThan(0.05);
		expect(Math.abs(result.y + 25)).toBeLessThan(0.05);
		return { x: result.x, y: result.y };
	};

	const run1 = await settle();
	const run2 = await settle();
	expect(Math.abs(run1.x - run2.x)).toBeLessThan(1e-9);
	expect(Math.abs(run1.y - run2.y)).toBeLessThan(1e-9);
});
