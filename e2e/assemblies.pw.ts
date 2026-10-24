import { expect, test } from "@playwright/test";

/**
 * Reusable assemblies e2e: save the current selection as a named assembly,
 * reload (the library persists in IndexedDB), stamp a copy on the canvas,
 * prove the stamped ids are fresh (originals untouched, count +2), and undo
 * removes exactly the stamp in one action.
 */
test("save from selection, reload, stamp fresh ids, undo", async ({ page }) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");

	const pagePos = async (
		wx: number,
		wy: number,
	): Promise<{ x: number; y: number }> => {
		const cam = await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.cameraState();
		});
		return {
			x: stageBox.x + wx * cam.zoom + cam.offsetX,
			y: stageBox.y + wy * cam.zoom + cam.offsetY,
		};
	};
	const drag = async (
		ax: number,
		ay: number,
		bx: number,
		by: number,
	): Promise<void> => {
		const a = await pagePos(ax, ay);
		const b = await pagePos(bx, by);
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move(b.x, b.y, { steps: 4 });
		await page.mouse.up();
	};

	// Two boxes drawn with the box tool (each spawn commits an undo action).
	await page.keyboard.press("b");
	await drag(60, -60, 80, -40);
	await drag(100, -60, 120, -40);
	const originalIds: string[] = await page.evaluate(() =>
		window.__ppg ? window.__ppg.bodyIds() : [],
	);
	expect(originalIds.length).toBe(2);

	// Rubber-band select both boxes with the select tool.
	await page.keyboard.press("v");
	await drag(50, -70, 130, -30);
	expect(
		await page.evaluate(() =>
			window.__ppg ? window.__ppg.selectedIds().length : 0,
		),
	).toBe(2);

	// Save the selection as a named assembly.
	await page.locator("[data-asm-name]").fill("bridge");
	await page.locator("[data-asm-save]").click();
	const row = page.locator("[data-asm-stamp]");
	await expect(row).toHaveCount(1);
	await expect(row).toContainText("bridge");

	// Let the autosave debounce (500ms) fire so the scene restores after
	// reload; the assembly itself persists in its own IndexedDB store.
	await page.waitForTimeout(800);
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);

	// The assembly survives the reload.
	await expect(page.locator("[data-asm-stamp]")).toContainText("bridge");
	// The working scene restored from autosave: the same two bodies.
	const restoredIds: string[] = await page.evaluate(() =>
		window.__ppg ? window.__ppg.bodyIds() : [],
	);
	expect([...restoredIds].sort()).toEqual([...originalIds].sort());

	// Stamp: click the row, then click the canvas to place the copy.
	await page.locator("[data-asm-stamp]").click();
	const place = await pagePos(300, -100);
	await stage.click({
		position: { x: place.x - stageBox.x, y: place.y - stageBox.y },
	});

	// Fresh non-colliding ids: two new ids, originals untouched (a colliding
	// mint would have silently REPLACED a body, keeping the count at 2).
	const stampedIds: string[] = await page.evaluate(() =>
		window.__ppg ? window.__ppg.bodyIds() : [],
	);
	expect(stampedIds.length).toBe(4);
	const freshIds = stampedIds.filter((id) => !restoredIds.includes(id));
	expect(freshIds.length).toBe(2);
	for (const id of restoredIds) {
		expect(stampedIds.filter((x) => x === id).length).toBe(1);
	}
	// The stamp keeps the assembly's internal geometry: 4 units between copies.
	const positions = await page.evaluate(
		(ids: string[]) => ids.map((id) => window.__ppg?.bodyPosition(id) ?? null),
		freshIds,
	);
	expect(positions.every((p) => p !== null)).toBe(true);
	const xs = positions.map((p) => (p as { x: number }).x);
	const x0 = xs[0];
	const x1 = xs[1];
	if (x0 === undefined || x1 === undefined)
		throw new Error("stamp body positions missing");
	// The stamp keeps the assembly's internal geometry: the two boxes were
	// drawn with centers 40 units apart (70 and 110), copies keep that.
	expect(Math.abs(x0 - x1)).toBeCloseTo(40, 1);

	// Undo removes exactly the stamp (one action), leaving the originals.
	await page.evaluate(() => window.__ppg?.undo());
	const afterUndo: string[] = await page.evaluate(() =>
		window.__ppg ? window.__ppg.bodyIds() : [],
	);
	expect([...afterUndo].sort()).toEqual([...restoredIds].sort());
});
