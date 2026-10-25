import { expect, test } from "@playwright/test";

/**
 * Batch: x-ray stays translucent while dragging (the hover path is the one
 * live draw path, and a dragged body is always hovered), the Snap tool
 * (click mover → click target: centers align, undoable; Alt+click picks a
 * body beneath a stack), and the Joint Lines toggle (dotted anchor→center
 * relationship lines, persisted like the other view options).
 */

/** Convert a debug-page world point to page CSS coords. */
const toScreen = (
	page: import("@playwright/test").Page,
	wx: number,
	wy: number,
): Promise<{ x: number; y: number }> =>
	page.evaluate(
		({ x, y }) => {
			const stage = document.querySelector("#stage")!.getBoundingClientRect();
			const cam = window.__ppg!.cameraState();
			return {
				x: stage.x + x * cam.zoom + cam.offsetX,
				y: stage.y + y * cam.zoom + cam.offsetY,
			};
		},
		{ x: wx, y: wy },
	);

const samplePixel = (
	page: import("@playwright/test").Page,
	wx: number,
	wy: number,
): Promise<{ r: number; g: number; b: number }> =>
	page.evaluate(
		({ x, y }) => {
			const stage = document.querySelector("#stage") as HTMLCanvasElement;
			const ctx = stage.getContext("2d")!;
			const cam = window.__ppg!.cameraState();
			const px = Math.round(
				(x * cam.zoom + cam.offsetX) * window.devicePixelRatio,
			);
			const py = Math.round(
				(y * cam.zoom + cam.offsetY) * window.devicePixelRatio,
			);
			const d = ctx.getImageData(px, py, 1, 1).data;
			return { r: d[0]!, g: d[1]!, b: d[2]! };
		},
		{ x: wx, y: wy },
	);

const dist = (
	a: { x: number; y: number },
	b: { x: number; y: number },
): number => Math.hypot(a.x - b.x, a.y - b.y);

test("x-ray stays translucent while a body is being dragged", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("under", 0, -400, 30, 20, "wood", false);
		ppg.spawnBox("over", 40, -400, 20, 20, "ink", false);
	});
	// The sample point sits inside the OVER box's fill (its center region,
	// away from its edges and the seam with the under box).
	const sp = await toScreen(page, 40, -400);

	// Baseline: x-ray off, pointer held on the over box (a press with the
	// select tool is a drag) — the old bug drew it opaque here.
	await page.mouse.move(sp.x, sp.y);
	await page.mouse.down();
	await page.waitForTimeout(120);
	const solidHeld = await samplePixel(page, 40, -400);
	await page.mouse.up();
	await page.waitForTimeout(80);

	// X-ray on, hold again: the held body must stay translucent.
	await page.locator('[data-draw="x-ray"]').click();
	await page.waitForTimeout(120);
	await page.mouse.move(sp.x, sp.y);
	await page.mouse.down();
	await page.waitForTimeout(120);
	const ghostHeld = await samplePixel(page, 40, -400);
	await page.mouse.up();

	const diff = Math.max(
		Math.abs(ghostHeld.r - solidHeld.r),
		Math.abs(ghostHeld.g - solidHeld.g),
		Math.abs(ghostHeld.b - solidHeld.b),
	);
	expect(diff).toBeGreaterThan(12);
});

test("snap tool moves the first-picked body's center onto the target's", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("mover", 0, -400, 15, 15, "wood", false);
		ppg.spawnBox("target", 150, -400, 15, 15, "ink", false);
	});
	await page.locator('[data-tool="snap"]').click();

	const from = await toScreen(page, 0, -400);
	const to = await toScreen(page, 150, -400);
	await page.mouse.click(from.x, from.y);
	await page.mouse.click(to.x, to.y);

	const mover = await page.evaluate(() => window.__ppg!.bodyPosition("mover"));
	const target = await page.evaluate(() =>
		window.__ppg!.bodyPosition("target"),
	);
	expect(mover && target && dist(mover, target)).toBeLessThan(0.01);

	// One undo step rewinds the whole gesture.
	await page.evaluate(() => window.__ppg!.undo());
	const restored = await page.evaluate(() =>
		window.__ppg!.bodyPosition("mover"),
	);
	expect(restored && dist(restored, { x: 0, y: -400 })).toBeLessThan(0.01);
});

test("Alt+click with the snap tool picks the body beneath the topmost", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("mover", 0, -400, 10, 10, "wood", false);
		// Over spans x [278, 302], under spans x [298, 322]: a click at 300
		// hits both; document order makes "under" the topmost.
		ppg.spawnBox("over", 290, -400, 12, 12, "ink", false);
		ppg.spawnBox("under", 310, -400, 12, 6, "steel", false);
	});
	await page.locator('[data-tool="snap"]').click();

	const from = await toScreen(page, 0, -400);
	const stacked = await toScreen(page, 300, -400);
	await page.mouse.click(from.x, from.y);
	// Alt+click: the pick goes one beneath the topmost → "over" (290,-400).
	await page.keyboard.down("Alt");
	await page.mouse.click(stacked.x, stacked.y);
	await page.keyboard.up("Alt");

	const mover = await page.evaluate(() => window.__ppg!.bodyPosition("mover"));
	expect(mover && dist(mover, { x: 290, y: -400 })).toBeLessThan(0.01);
});

test("joint-lines toggle draws dotted relationship lines and persists", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("a", 100, -500, 30, 20, "wood", false);
		ppg.spawnBox("b", 100, -580, 30, 20, "ink", false);
		ppg.placePin("p1", "a", "b", 100, -500);
	});

	/** Capture the pin's anchor→center line strip (backing-store RGBA). */
	const capture = async (): Promise<Uint8ClampedArray> =>
		page.evaluate(() => {
			const stage = document.querySelector("#stage") as HTMLCanvasElement;
			const ctx = stage.getContext("2d")!;
			const cam = window.__ppg!.cameraState();
			const dpr = window.devicePixelRatio;
			const px = Math.round((100 * cam.zoom + cam.offsetX) * dpr);
			const y0 = Math.round(((-580 + 12) * cam.zoom + cam.offsetY) * dpr);
			const y1 = Math.round(((-500 - 12) * cam.zoom + cam.offsetY) * dpr);
			const top = Math.min(y0, y1);
			const bottom = Math.max(y0, y1);
			return ctx.getImageData(px, top, 1, bottom - top).data.slice();
		});

	// Let layout/fonts settle so the canvas backing store is stable across
	// the captures (a mid-settle baseline shifts every later frame).
	await page.waitForTimeout(300);
	const baseline = await capture();

	await page.locator('[data-draw="joint-lines"]').click();
	await page.waitForTimeout(150);
	const after = await capture();
	let sum = 0;
	for (let i = 0; i < after.length; i += 4) {
		sum += Math.abs(after[i]! - baseline[i]!);
	}
	// Dotted accent segments landed somewhere along the strip.
	expect(sum).toBeGreaterThan(300);

	// Toggle back off: the strip returns to the baseline.
	await page.locator('[data-draw="joint-lines"]').click();
	await page.waitForTimeout(150);
	const restoredStrip = await capture();
	let sumOff = 0;
	for (let i = 0; i < restoredStrip.length; i += 4) {
		sumOff += Math.abs(restoredStrip[i]! - baseline[i]!);
	}
	expect(sumOff).toBeLessThan(20);

	// The setting persists across a reload.
	await page.locator('[data-draw="joint-lines"]').click();
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);
	await expect.soft(page.locator('[data-draw="joint-lines"]')).toBeChecked();
});
