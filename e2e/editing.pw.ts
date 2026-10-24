import { expect, test } from "@playwright/test";

/**
 * Editing e2e (debug mode: real-time feed paused, `advanceTime` drives the
 * sim): paused-drag teleports a selected box while another body stays put;
 * R-drag rotates; Ctrl+D duplicates (the copy is offset and moves
 * independently of its source); Delete removes a body from the physics
 * registry; rubber-band multi-select selects both bodies and Escape clears.
 */
test("select/move/rotate/duplicate/delete and rubber-band multi-select", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");

	const cam = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	const pagePos = (wx: number, wy: number): { x: number; y: number } => ({
		x: stageBox.x + wx * cam.zoom + cam.offsetX,
		y: stageBox.y + wy * cam.zoom + cam.offsetY,
	});

	const call = <T>(body: string): Promise<T> =>
		page.evaluate(
			`(function(){ const ppg = window.__ppg; if (!ppg) throw new Error("debug api missing"); return (${body}); })()`,
		) as Promise<T>;

	// Two boxes, settled (advanceSimTime ignores pause).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("a", 0, -300, 20, 20);
		ppg.spawnBox("b", 200, -300, 20, 20);
		ppg.advanceTime(2000);
	});

	// Paused drag teleports the selected box: position changes immediately.
	await page.keyboard.press("v");
	const aPos = await call<{ x: number; y: number }>("ppg.bodyPosition('a')");
	if (!aPos) throw new Error("box a missing");
	const grab = pagePos(aPos.x, aPos.y);
	const drop = pagePos(aPos.x + 60, aPos.y - 40);
	await page.mouse.move(grab.x, grab.y);
	await page.mouse.down();
	await page.mouse.move(drop.x, drop.y, { steps: 4 });
	await page.mouse.up();
	const aAfter = await call<{ x: number; y: number } | undefined>(
		"ppg.bodyPosition('a')",
	);
	if (!aAfter) throw new Error("box a vanished");
	expect(aAfter.x).toBeCloseTo(aPos.x + 60, 0);
	expect(aAfter.y).toBeCloseTo(aPos.y - 40, 0);
	// The other box did not move.
	const bPos = await call<{ x: number; y: number } | undefined>(
		"ppg.bodyPosition('b')",
	);
	if (!bPos) throw new Error("box b vanished");
	expect(bPos.x).toBeCloseTo(200, 0);
	expect(bPos.y).toBeCloseTo(-280, 0);

	// R-drag rotates the selection: down-drag = positive angle (y-down world).
	// Press at the box's CURRENT center — the paused drag teleported it.
	const aCenter = pagePos(aAfter.x, aAfter.y);
	await page.keyboard.down("r");
	await page.mouse.move(aCenter.x, aCenter.y);
	await page.mouse.down();
	await page.mouse.move(aCenter.x, aCenter.y + 50, { steps: 3 });
	await page.mouse.up();
	await page.keyboard.up("r");
	const aRot = await call<number | undefined>("ppg.bodyRot('a')");
	if (aRot === undefined) throw new Error("box a missing");
	expect(Math.abs(aRot)).toBeGreaterThan(0.3);

	// Duplicate (Ctrl+D): a third body appears, offset by the fixed delta.
	const idsBefore = await call<string[]>("ppg.bodyIds()");
	await page.keyboard.press("Control+d");
	const idsAfter = await call<string[]>("ppg.bodyIds()");
	expect(idsAfter.length).toBe(idsBefore.length + 1);
	const dupId = idsAfter.find((id) => !idsBefore.includes(id));
	if (!dupId) throw new Error("duplicate body missing");
	const dupPos = await call<{ x: number; y: number } | undefined>(
		`ppg.bodyPosition('${dupId}')`,
	);
	if (!dupPos) throw new Error("duplicate body missing");
	expect(dupPos.x).toBeCloseTo(aAfter.x + 1, 0);
	expect(dupPos.y).toBeCloseTo(aAfter.y - 1, 0);

	// The duplicate moves independently: drag it far away; source stays.
	const dupPage = pagePos(dupPos.x, dupPos.y);
	const farPage = pagePos(-400, -420);
	await page.mouse.move(dupPage.x, dupPage.y);
	await page.mouse.down();
	await page.mouse.move(farPage.x, farPage.y, { steps: 4 });
	await page.mouse.up();
	const dupAfter = await call<{ x: number; y: number } | undefined>(
		`ppg.bodyPosition('${dupId}')`,
	);
	const aIndependent = await call<{ x: number; y: number } | undefined>(
		"ppg.bodyPosition('a')",
	);
	if (!dupAfter || !aIndependent) throw new Error("bodies missing");
	expect(dupAfter.x).toBeLessThan(-300); // moved independently
	expect(aIndependent.x).toBeCloseTo(aAfter.x, 0);
	expect(aIndependent.y).toBeCloseTo(aAfter.y, 0);

	// Delete removes the duplicate from the physics registry.
	await page.keyboard.press("Delete");
	const afterDelete = await call<string[]>("ppg.bodyIds()");
	expect(afterDelete).not.toContain(dupId);
	expect(afterDelete).toContain("a");
	expect(afterDelete).toContain("b");

	// Rubber-band multi-select: band around both boxes selects both; Escape
	// clears. The band stays inside the canvas (x ≥ 0: the tool rail sits left).
	await page.mouse.move(pagePos(10, -400).x, pagePos(10, -400).y);
	await page.mouse.down();
	await page.mouse.move(pagePos(300, -200).x, pagePos(300, -200).y, {
		steps: 3,
	});
	await page.mouse.up();
	expect(
		await call<string[]>("ppg.selectedIds()").then((s) => s.sort()),
	).toEqual(["a", "b"]);
	await page.keyboard.press("Escape");
	expect(await call<number>("ppg.selectedIds().length")).toBe(0);
});
