import { expect, test } from "@playwright/test";

/**
 * Header draw options (draw-options.ts): grid size + snap, circle-from-center,
 * square-constrained box drags, and 15° angle snap on the rotate gesture.
 * Verified through the real UI toggles and pointer flow; document records are
 * the contract (placement poses are the committed geometry).
 */

test("square toggle forces equal box halves; center toggle anchors circles at the press point", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	const stage = await page.locator("#stage").boundingBox();
	const cam = await page.evaluate(() => window.__ppg!.cameraState());
	const toScreen = (wx: number, wy: number) => ({
		x: stage!.x + wx * cam.zoom + cam.offsetX,
		y: stage!.y + wy * cam.zoom + cam.offsetY,
	});

	// Square box: an asymmetric drag commits equal halves.
	await page.locator('[data-draw="box-square"]').click();
	await page.locator('[data-tool="box"]').click();
	const p = toScreen(30, -150);
	await page.mouse.move(p.x, p.y);
	await page.mouse.down();
	await page.mouse.move(p.x + 120, p.y + 40, { steps: 4 });
	await page.mouse.up();
	const box = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().at(-1);
		return e?.kind === "body" && e.shape.kind === "box" ? e.shape : null;
	});
	expect(box).not.toBeNull();
	expect(box!.halfWidth).toBeCloseTo(box!.halfHeight, 6);

	// Circle from center: the press point is the committed center.
	await page.locator('[data-draw="circle-center"]').click();
	await page.locator('[data-tool="circle"]').click();
	const c = toScreen(60, -220);
	await page.mouse.move(c.x, c.y);
	await page.mouse.down();
	await page.mouse.move(c.x + 60, c.y + 20, { steps: 4 });
	await page.mouse.up();
	const circle = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().at(-1);
		return e?.kind === "body" && e.shape.kind === "circle"
			? { cx: e.x, cy: e.y, radius: e.shape.radius }
			: null;
	});
	expect(circle).not.toBeNull();
	expect(circle!.cx).toBeCloseTo(60, 4);
	expect(circle!.cy).toBeCloseTo(-220, 4);
});

test("grid snap: size field drives the renderer and drawing snaps to multiples", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Set grid size to 40 and enable snap through the real controls.
	const gridField = page.locator('[data-draw="grid-size"]');
	await gridField.fill("40");
	await gridField.blur();
	await page.locator('[data-draw="grid-snap"]').click();
	await page.locator('[data-tool="box"]').click();
	const stage = await page.locator("#stage").boundingBox();
	const cam = await page.evaluate(() => window.__ppg!.cameraState());
	const toScreen = (wx: number, wy: number) => ({
		x: stage!.x + wx * cam.zoom + cam.offsetX,
		y: stage!.y + wy * cam.zoom + cam.offsetY,
	});
	// Drag 5→63 (world): snapped corners 0→64... with size 40: snapped
	// corners 0→80 → center 40, halves 40 on each axis.
	const p = toScreen(5, -131);
	await page.mouse.move(p.x, p.y);
	await page.mouse.down();
	await page.mouse.move(p.x + 58, p.y + 64, { steps: 4 });
	await page.mouse.up();
	const box = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().at(-1);
		return e?.kind === "body" && e.shape.kind === "box"
			? { cx: e.x, cy: e.y, ...e.shape }
			: null;
	});
	expect(box).not.toBeNull();
	// Both corners sit on the 40-unit grid (centers alone are only
	// guaranteed multiples of half the spacing).
	expect((((box!.cx + box!.halfWidth) % 40) + 40) % 40).toBe(0);
	expect((((box!.cx - box!.halfWidth) % 40) + 40) % 40).toBe(0);
	expect((((box!.cy + box!.halfHeight) % 40) + 40) % 40).toBe(0);
	expect((((box!.cy - box!.halfHeight) % 40) + 40) % 40).toBe(0);
});

test("angle snap: R-drag rotation commits on 15° steps and no fling breaks it", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.evaluate(() =>
		window.__ppg!.spawnBox("snapbox", 0, -80, 30, 20, "ink", false),
	);
	await page.locator('[data-draw="angle-snap"]').click();
	await page.locator('[data-tool="select"]').click();
	const stage = await page.locator("#stage").boundingBox();
	const cam = await page.evaluate(() => window.__ppg!.cameraState());
	const p = {
		x: stage!.x + 0 * cam.zoom + cam.offsetX,
		y: stage!.y + -80 * cam.zoom + cam.offsetY,
	};
	// Hold R, press on the box, drag vertically (arbitrary distance), release.
	await page.keyboard.down("r");
	await page.mouse.move(p.x, p.y);
	await page.mouse.down();
	await page.mouse.move(p.x, p.y - 33, { steps: 5 });
	await page.mouse.up();
	await page.keyboard.up("r");
	const rot = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().find((e) => e.id === "snapbox");
		return e && "rot" in e ? e.rot : null;
	});
	expect(rot).not.toBeNull();
	// Some exact 15° multiple (33 world px of drag ≈ 5 ticks of ROTATE step).
	const steps = rot! / (Math.PI / 12);
	expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-6);
});
