import { expect, test } from "@playwright/test";

const MIN_ZOOM = 0.05;
const MAX_ZOOM = 20;

/**
 * Camera e2e: synthetic wheel and drag events pan/zoom the app, and the debug
 * API re-queries the world point under a known screen position, which must
 * match the value the test computes independently from the camera state.
 */
test("wheel zooms anchored at cursor, drag pans, conversions stay exact", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Hover over the stage before wheeling; zoom anchors at the cursor.
	const cursor = { x: 300, y: 200 };
	await page.mouse.move(cursor.x, cursor.y);

	// Zoom in: zoom multiplies by exp(0.6) ≈ 1.82 per -400px wheel notch.
	await page.mouse.wheel(0, -400);
	const zoomedIn = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(zoomedIn.zoom).toBeGreaterThan(1);

	// Wheel zoom anchors the world point under the cursor. The debug API takes
	// canvas-relative CSS pixels, so convert page coordinates via the bounding box.
	const stage = page.locator("#stage");
	const readWorldAt = async (
		pageX: number,
		pageY: number,
	): Promise<{ x: number; y: number }> => {
		const box = await stage.boundingBox();
		if (!box) throw new Error("stage canvas not visible");
		return page.evaluate(
			({ x, y }) => {
				const ppg = window.__ppg;
				if (!ppg) throw new Error("debug api missing");
				return ppg.screenToWorld(x, y);
			},
			{ x: pageX - box.x, y: pageY - box.y },
		);
	};
	const before = await readWorldAt(cursor.x, cursor.y);
	await page.mouse.wheel(0, -400);
	const after = await readWorldAt(cursor.x, cursor.y);
	expect(Math.abs(after.x - before.x)).toBeLessThan(1e-6);
	expect(Math.abs(after.y - before.y)).toBeLessThan(1e-6);

	// Saturate both ways: clamps at MIN and MAX, stays there.
	for (let i = 0; i < 40; i++) await page.mouse.wheel(0, 1200);
	const atMin = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(atMin.zoom).toBe(MIN_ZOOM);
	for (let i = 0; i < 40; i++) await page.mouse.wheel(0, -1200);
	const atMax = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(atMax.zoom).toBe(MAX_ZOOM);

	// Space-drag pan: offset moves by exactly the drag delta.
	await page.keyboard.down("Space");
	await page.mouse.move(500, 400);
	await page.mouse.down();
	const beforeDrag = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	await page.mouse.move(560, 430, { steps: 4 });
	await page.mouse.up();
	await page.keyboard.up("Space");
	const afterDrag = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(afterDrag.offsetX).toBeCloseTo(beforeDrag.offsetX + 60, 6);
	expect(afterDrag.offsetY).toBeCloseTo(beforeDrag.offsetY + 30, 6);

	// World point under a known canvas-relative screen position matches the
	// test's independent computation from the camera state.
	const sx = 333;
	const sy = 211;
	const expected = {
		x: (sx - afterDrag.offsetX) / afterDrag.zoom,
		y: (sy - afterDrag.offsetY) / afterDrag.zoom,
	};
	const actual = await page.evaluate(
		({ x, y }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.screenToWorld(x, y);
		},
		{ x: sx, y: sy },
	);
	expect(actual.x).toBeCloseTo(expected.x, 9);
	expect(actual.y).toBeCloseTo(expected.y, 9);

	// Trackpad pinch (ctrl+wheel) zooms (conventional mapping), here zooming
	// back out from the saturated MAX.
	await page.keyboard.down("Control");
	await page.mouse.wheel(0, 600);
	await page.keyboard.up("Control");
	const afterPinch = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(afterPinch.zoom).toBeLessThan(MAX_ZOOM);

	// Horizontal wheel delta (two-finger trackpad pan) pans without zooming.
	const beforeHScroll = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	await page.mouse.wheel(120, 0);
	const afterHScroll = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(afterHScroll.offsetX).toBeCloseTo(beforeHScroll.offsetX + 120, 6);
	expect(afterHScroll.offsetY).toBeCloseTo(beforeHScroll.offsetY, 6);
	expect(afterHScroll.zoom).toBe(afterPinch.zoom);

	// Middle-button drag pans without space held.
	await page.mouse.move(500, 400);
	await page.mouse.down({ button: "middle" });
	const beforeMiddle = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	await page.mouse.move(470, 380, { steps: 4 });
	await page.mouse.up({ button: "middle" });
	const afterMiddle = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(afterMiddle.offsetX).toBeCloseTo(beforeMiddle.offsetX - 30, 6);
	expect(afterMiddle.offsetY).toBeCloseTo(beforeMiddle.offsetY - 20, 6);
});
