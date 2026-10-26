import { expect, test } from "@playwright/test";

test("rack: real circle-then-box placement, motor drive, readouts, undo, autosave, cascade", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	const stage = await page.locator("#stage").boundingBox();
	const cam = await page.evaluate(() => window.__ppg?.cameraState());
	if (!stage || !cam) throw new Error("stage missing");
	const screen = (x: number, y: number) => ({
		x: stage.x + x * cam.zoom + cam.offsetX,
		y: stage.y + y * cam.zoom + cam.offsetY,
	});
	const click = async (x: number, y: number) => {
		const p = screen(x, y);
		await page.mouse.click(p.x, p.y);
	};
	await page.evaluate(() => {
		const p = window.__ppg;
		// Pinion r=30 and a wide rack box: the rack's axis passes 30 units
		// below the pinion center, so the pitch sign is −1 (v = −30·ω) and
		// the pair never touches (the constraint is the only coupling).
		p?.spawnCircle("a", 140, -160, 30);
		p?.spawnBox("box", 400, -130, 60, 8);
		p?.placeJoint("motor-a", "motor", "a", null, 140, -160, 140, -160);
		// The rack rides a world slider along its axis so the drive shows as
		// pure translation (the mounting is the user's joints, gear precedent).
		p?.placeJoint("rail", "slider", "box", null, 400, -130, 440, -130);
	});
	await page.click('[data-tool="joint"]');
	await page.click('[data-joint-kind="rack"]');
	// The FIRST click must be a circle: the box refuses with the notice.
	await click(400, -130);
	await expect(page.locator("#ppg-notice")).toContainText("pinion");
	// Circle first, box second: the placement commits and selects.
	await click(140, -160);
	await click(400, -130);
	expect(await page.evaluate(() => window.__ppg?.jointIds().length)).toBe(3);
	const id = await page.evaluate(() => window.__ppg?.selectedIds()[0]);
	if (!id) throw new Error("joint not selected");
	await expect(page.locator(".joint-panel")).toContainText(
		"Pitch radius: 30.000",
	);
	await expect(
		page.locator(".joint-panel [data-joint-params] input"),
	).toHaveCount(0);
	const motion = await page.evaluate(() => {
		const p = window.__ppg;
		const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
		let theta = 0;
		let dx = 0;
		let pa = p?.bodyRot("a") ?? 0;
		let px = p?.bodyPosition("box")?.x ?? 0;
		for (let i = 0; i < 120; i++) {
			p?.advanceTime(1000 / 60);
			const ra = p?.bodyRot("a") ?? 0;
			const cx = p?.bodyPosition("box")?.x ?? 0;
			theta += wrap(ra - pa);
			dx += cx - px;
			pa = ra;
			px = cx;
		}
		return { theta, dx };
	});
	// The motorized pinion drives the rack at v = −30·ω (rack below in the
	// y-down world), so the integrated displacement tracks −30·Δθ: clear −x
	// travel and the pitch relation holds through the motor's spin-up.
	expect(Math.abs(motion.dx)).toBeGreaterThan(20);
	expect(motion.dx).toBeLessThan(0);
	expect(Math.abs(motion.dx + 30 * motion.theta)).toBeLessThan(2);
	await page.click('[data-action="delete"]');
	expect(
		await page.evaluate((id) => window.__ppg?.joint(id), id),
	).toBeUndefined();
	await page.click('[data-action="undo"]');
	await page.waitForTimeout(900);
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);
	expect(
		await page.evaluate((id) => window.__ppg?.joint(id)?.jointType, id),
	).toBe("rack");
	await page.click('[data-tool="select"]');
	// Delete the rack BODY at its LIVE position: the removal cascade takes
	// the joint with it (the gear precedent).
	const live = await page.evaluate(
		() => window.__ppg?.bodyPosition("box") ?? { x: 0, y: 0 },
	);
	await click(live.x, live.y);
	await page.click('[data-action="delete"]');
	expect(
		await page.evaluate((id) => window.__ppg?.joint(id), id),
	).toBeUndefined();
});
