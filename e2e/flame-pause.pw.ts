import { expect, test } from "@playwright/test";

/**
 * The thruster exhaust flicker keys off the SIM clock (Paul, 2026-10-25):
 * pausing time freezes the flame; wall-clock flicker used to keep it
 * animating through a pause. Verified at the pixel level on debug pages,
 * which boot paused.
 */

const sampleFlame = (
	page: import("@playwright/test").Page,
): Promise<number[]> =>
	page.evaluate(() => {
		const ctx = document
			.querySelector<HTMLCanvasElement>("#stage")!
			.getContext("2d")!;
		const cam = window.__ppg!.cameraState();
		const dpr = window.devicePixelRatio;
		// Near the plume's WIDE end (the quad widens linearly from the mount
		// point to full half-width ~26 units out): the half-width oscillates
		// ±13%, so this pixel flips between fill and background as the flame
		// pulses. Positive x: the debug camera's offsetX is 0, so negative
		// world x is off-canvas.
		const d = ctx.getImageData(
			Math.round((168 * cam.zoom + cam.offsetX) * dpr),
			Math.round((-404.9 * cam.zoom + cam.offsetY) * dpr),
			1,
			1,
		).data;
		return [d[0]!, d[1]!, d[2]!];
	});

const paintedFrame = (page: import("@playwright/test").Page): Promise<void> =>
	page.evaluate(
		() =>
			new Promise<void>((resolve) => {
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
			}),
	);

test("rocket flame freezes while paused and animates when running", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.evaluate(() => {
		window.__ppg!.spawnBox("rb", 200, -400, 16, 16, "wood", true);
		window.__ppg!.placeThruster("th", "rb", 0, 0, 0, 12000, true);
	});
	await paintedFrame(page);

	// Debug boots paused: the flame must be FROZEN — pixel identical across
	// wall time.
	const frozen = [
		await sampleFlame(page),
		await (async () => {
			await page.waitForTimeout(320);
			await paintedFrame(page);
			return sampleFlame(page);
		})(),
	];
	expect(frozen[1]).toEqual(frozen[0]);

	// Unpause: the flicker must move — some consecutive sample pair differs.
	await page.locator('[data-sim="pause"]').click();
	await paintedFrame(page);
	let animating = false;
	for (let i = 0; i < 6 && !animating; i++) {
		const a = await sampleFlame(page);
		await page.waitForTimeout(110);
		await paintedFrame(page);
		const b = await sampleFlame(page);
		if (
			Math.max(
				Math.abs(a[0]! - b[0]!),
				Math.abs(a[1]! - b[1]!),
				Math.abs(a[2]! - b[2]!),
			) > 8
		)
			animating = true;
	}
	expect(animating).toBe(true);

	// Pause again: frozen once more.
	await page.locator('[data-sim="pause"]').click();
	await paintedFrame(page);
	const againA = await sampleFlame(page);
	await page.waitForTimeout(320);
	await paintedFrame(page);
	const againB = await sampleFlame(page);
	expect(againB).toEqual(againA);
});
