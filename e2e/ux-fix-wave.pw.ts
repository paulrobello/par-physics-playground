import { expect, test } from "@playwright/test";

/**
 * UX fix wave (Paul, 2026-10-25): reset needs a confirming second click, a
 * plain click spawns a minimum-size shape (no pixel dots), Enter closes an
 * in-progress polygon even with a tool radio focused, and the first polygon
 * vertex carries an always-visible ring that IS the click-to-close hitbox.
 */

test("reset requires a confirming second click within the arm window", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.evaluate(() => {
		window.__ppg!.spawnBox("a", 0, -100, 10, 10, "ink", false);
		window.__ppg!.spawnBox("b", 60, -100, 10, 10, "ink", false);
	});
	const ids = () => page.evaluate(() => window.__ppg!.bodyIds());

	// First click only arms: the world survives, the button shows the armed state.
	await page.locator('[data-sim="reset"]').click();
	expect(await ids()).toEqual(["a", "b"]);
	await expect
		.soft(page.locator('[data-sim="reset"]'))
		.toHaveAttribute("aria-label", "Confirm world reset");
	await expect.soft(page.locator('[data-sim="reset"]')).toHaveClass(/armed/);

	// The arm window lapses: the world still survives; the button disarms.
	await page.waitForTimeout(3200);
	await expect
		.soft(page.locator('[data-sim="reset"]'))
		.toHaveAttribute("aria-label", "Reset world");
	await page.locator('[data-sim="reset"]').click();
	expect(await ids()).toEqual(["a", "b"]);

	// Arm, then confirm: the world wipes.
	await page.locator('[data-sim="reset"]').click();
	await page.locator('[data-sim="reset"]').click();
	expect(await ids()).toEqual([]);
});

test("a plain click with the box and circle tools commits a minimum-size shape", async ({
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

	await page.locator('[data-tool="box"]').click();
	const p = toScreen(40, -120);
	await page.mouse.click(p.x, p.y);
	await page.locator('[data-tool="circle"]').click();
	const q = toScreen(120, -120);
	await page.mouse.click(q.x, q.y);
	const shapes = await page.evaluate(() =>
		window.__ppg!.documentAll().filter((e) => e.kind === "body"),
	);
	expect(shapes).toHaveLength(2);
	const box = shapes[0];
	const circle = shapes[1];
	if (
		!box ||
		box.kind !== "body" ||
		box.shape.kind !== "box" ||
		!circle ||
		circle.kind !== "body" ||
		circle.shape.kind !== "circle"
	)
		throw new Error("expected a box and a circle");
	expect(box.shape.halfWidth).toBe(4);
	expect(box.shape.halfHeight).toBe(4);
	expect(circle.shape.radius).toBe(4);
});

test("Enter closes an in-progress polygon while a tool radio keeps focus", async ({
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

	// Clicking the radio (not the keyboard shortcut) leaves it focused — the
	// exact flow where the old guard swallowed Enter.
	await page.locator('[data-tool="polygon"]').click();
	for (const [wx, wy] of [
		[0, -100],
		[60, -100],
		[30, -150],
	] as const) {
		const v = toScreen(wx, wy);
		await page.mouse.click(v.x, v.y);
	}
	await page.keyboard.press("Enter");
	const poly = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().at(-1);
		return e?.kind === "body" && e.shape.kind === "polygon"
			? e.shape.points.length
			: null;
	});
	expect(poly).toBe(3);
});

test("the first-vertex ring is the close hitbox: a click 8px from the vertex closes", async ({
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

	await page.locator('[data-tool="polygon"]').click();
	for (const [wx, wy] of [
		[0, -100],
		[60, -100],
		[30, -150],
	] as const) {
		const v = toScreen(wx, wy);
		await page.mouse.click(v.x, v.y);
	}
	// The first vertex sits 8 SCREEN px away — inside the 12px close ring at
	// zoom 1 (the old 0.75-unit floor would have demanded sub-pixel aim).
	const first = toScreen(0, -100);
	await page.mouse.move(first.x + 8, first.y);
	await page.mouse.down();
	await page.mouse.up();
	const poly = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().at(-1);
		return e?.kind === "body" && e.shape.kind === "polygon"
			? e.shape.points.length
			: null;
	});
	expect(poly).toBe(3);
});
