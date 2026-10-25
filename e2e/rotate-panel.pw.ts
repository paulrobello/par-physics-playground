import { expect, test } from "@playwright/test";

/**
 * Rotation-field e2e (debug mode: sim paused): selecting a body reveals the
 * Rotation section; a typed angle rotates the body through the same
 * rotateBody path the R+drag gesture uses; undo reverts; and an R-drag
 * gesture feeds back into the field (two-way). Criterion evidence for the
 * visible-rotation-affordance card.
 */
test("rotation field shows, edits, undoes, and tracks the selection", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");

	const call = <T>(body: string): Promise<T> =>
		page.evaluate(
			`(function(){ const ppg = window.__ppg; if (!ppg) throw new Error("debug api missing"); return (${body}); })()`,
		) as Promise<T>;

	// One settled box.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("a", 0, -300, 20, 20);
		ppg.advanceTime(2000);
	});

	await page.keyboard.press("v");
	const pos = await call<{ x: number; y: number }>("ppg.bodyPosition('a')");
	if (!pos) throw new Error("box a missing");
	const cam = await call<{
		zoom: number;
		offsetX: number;
		offsetY: number;
	}>("ppg.cameraState()");
	const at = (wx: number, wy: number): { x: number; y: number } => ({
		x: stageBox.x + wx * cam.zoom + cam.offsetX,
		y: stageBox.y + wy * cam.zoom + cam.offsetY,
	});

	// Selecting the body reveals the field; debug boots paused, so it edits.
	await page.mouse.click(at(pos.x, pos.y).x, at(pos.x, pos.y).y);
	const field = page.locator(".rotate-panel input[data-rotate-angle]");
	await expect(field).toBeVisible();
	await expect(field).toBeEnabled();

	// Typing an angle rotates the body through the shared rotateBody path.
	const before = await call<number | undefined>("ppg.bodyRot('a')");
	if (before === undefined) throw new Error("box a missing");
	await field.fill("90");
	await field.press("Enter");
	await expect
		.poll(() => call<number | undefined>("ppg.bodyRot('a')"))
		.toBeCloseTo(before + Math.PI / 2, 1);
	await expect(field).toHaveValue(/^90/);

	// Undo reverts the field edit like any scene action.
	await field.blur();
	await page.keyboard.press("Control+z");
	await expect
		.poll(() => call<number | undefined>("ppg.bodyRot('a')"))
		.toBeCloseTo(before, 1);

	// Re-select (undo may drop selection) and rotate via the R-drag gesture;
	// the field tracks the gesture's result — the two-way direction.
	await page.mouse.click(at(pos.x, pos.y).x, at(pos.x, pos.y).y);
	await page.keyboard.down("r");
	await page.mouse.move(at(pos.x, pos.y).x, at(pos.x, pos.y).y);
	await page.mouse.down();
	await page.mouse.move(at(pos.x, pos.y).x, at(pos.x, pos.y).y + 50, {
		steps: 3,
	});
	await page.mouse.up();
	await page.keyboard.up("r");
	await expect
		.poll(() => call<number>("Math.abs(ppg.bodyRot('a') ?? 0)"))
		.toBeGreaterThan(0.3);
	await expect(field).not.toHaveValue("");
	await expect(field).not.toHaveValue(/^0(\.0)?$/);
});
