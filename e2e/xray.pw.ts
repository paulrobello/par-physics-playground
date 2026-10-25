import { expect, test } from "@playwright/test";

/**
 * X-ray view toggle (Paul, 2026-10-25): bodies draw translucent so shapes
 * underneath stay visible. Verified at the pixel level — the same canvas
 * point inside a covered shape changes color when x-ray turns on — and the
 * toggle persists across a reload (settings store).
 */

test("x-ray makes covered shapes visible; the toggle persists across reload", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Two overlapping boxes: "wood" (bottom, at 0,-150) is covered by an
	// "ink" box on top (40,-150): they overlap in [30, 50] on x.
	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("under", 0, -150, 30, 20, "wood", false);
		ppg.spawnBox("over", 40, -150, 20, 20, "ink", false);
	});

	const sample = (): Promise<{ r: number; g: number; b: number }> =>
		page.evaluate(() => {
			const stage = document.querySelector("#stage") as HTMLCanvasElement;
			const ctx = stage.getContext("2d")!;
			const cam = window.__ppg!.cameraState();
			// Canvas backing-store pixels: camera CSS coords × devicePixelRatio —
			// the page offset (stageBox) is NOT part of the canvas space.
			const px = Math.round(
				(45 * cam.zoom + cam.offsetX) * window.devicePixelRatio,
			);
			const py = Math.round(
				(-150 * cam.zoom + cam.offsetY) * window.devicePixelRatio,
			);
			const d = ctx.getImageData(px, py, 1, 1).data;
			return { r: d[0]!, g: d[1]!, b: d[2]! };
		});

	const solid = await sample();
	await page.locator('[data-draw="x-ray"]').click();
	// Let one frame render in x-ray mode.
	await page.waitForTimeout(120);
	const ghost = await sample();

	// The covered point's color changed: the underlying wood box bleeds
	// through the translucent ink sprite.
	const dr = Math.abs(ghost.r - solid.r);
	const dg = Math.abs(ghost.g - solid.g);
	const db = Math.abs(ghost.b - solid.b);
	expect(Math.max(dr, dg, db)).toBeGreaterThan(12);

	// The toggle persists (settings store) and restores the mode.
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);
	await expect.soft(page.locator('[data-draw="x-ray"]')).toBeChecked();
	const restored = await sample();
	expect(Math.abs(restored.r - solid.r)).toBeGreaterThan(12);
});
