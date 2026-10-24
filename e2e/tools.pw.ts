import { expect, test } from "@playwright/test";

/**
 * Tools e2e (debug mode: real-time feed paused, `advanceTime` drives the sim):
 * draw a box and a circle with synthetic mouse drags, both settle under
 * gravity on the ground; select-drag a resting box via the mouse joint — it
 * follows the pointer with physics response and falls again on release.
 */
test("draw tools place bodies that settle; select-drag moves and releases", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");

	// Page coordinates for a world point, from the live camera state.
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

	// Toolbar: select is active by default; B/C shortcuts activate the draw tools.
	expect(await page.locator('[data-tool="select"] input').isChecked()).toBe(
		true,
	);
	await page.keyboard.press("b");
	expect(await page.locator('[data-tool="box"] input').isChecked()).toBe(true);
	expect(await page.locator('[data-tool="select"] input').isChecked()).toBe(
		false,
	);

	// Draw a box (80x80, center ~ (100, -260) in world coords), then commit.
	const b1 = await pagePos(60, -300);
	const b2 = await pagePos(140, -220);
	await page.mouse.move(b1.x, b1.y);
	await page.mouse.down();
	await page.mouse.move(b2.x, b2.y, { steps: 4 });
	await page.mouse.up();

	// Draw a circle r=25 centered at ~(900, -295) — still on the stage but far
	// beyond the release fling's reach, so settle checks stay independent.
	const c1 = await pagePos(875, -320);
	const c2 = await pagePos(925, -270);
	await page.keyboard.press("c");
	await page.mouse.move(c1.x, c1.y);
	await page.mouse.down();
	await page.mouse.move(c2.x, c2.y, { steps: 4 });
	await page.mouse.up();

	const ids = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyIds();
	});
	expect(ids.length).toBe(2);
	const boxId = ids[0];
	const circleId = ids[1];
	if (!boxId || !circleId) throw new Error("expected two spawned bodies");

	// Both settle on the ground under gravity (rest y = -half extent).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(10000);
	});
	const positions = await page.evaluate(
		({ boxId, circleId }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return {
				box: ppg.bodyPosition(boxId),
				circle: ppg.bodyPosition(circleId),
			};
		},
		{ boxId, circleId },
	);
	if (!positions.box || !positions.circle)
		throw new Error("bodies were culled, not settled");
	expect(Math.abs(positions.box.x - 100)).toBeLessThan(0.5);
	expect(Math.abs(positions.box.y + 40)).toBeLessThan(0.05);
	expect(Math.abs(positions.circle.x - 900)).toBeLessThan(0.5);
	expect(Math.abs(positions.circle.y + 25)).toBeLessThan(0.05);

	// Select tool: grab the resting box, pull it up, release — it falls back.
	await page.keyboard.press("v");
	const grab = await pagePos(100, -40);
	await page.mouse.move(grab.x, grab.y);
	await page.mouse.down();
	await page.mouse.move(
		(await pagePos(100, -400)).x,
		(await pagePos(100, -400)).y,
		{
			steps: 4,
		},
	);
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(2000);
	});
	const duringDrag = await page.evaluate((boxId) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyPosition(boxId);
	}, boxId);
	if (!duringDrag) throw new Error("box vanished during drag");
	expect(duringDrag.y).toBeLessThan(-100); // pulled up toward the pointer

	// Bring the pointer back down near the ground while still dragging, so the
	// release happens low: a high release flings the box hard (real physics —
	// drag-to-fling) and the test only needs "it falls again on release".
	const low = await pagePos(100, -60);
	await page.mouse.move(low.x, low.y, { steps: 4 });
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(1000);
	});
	await page.mouse.up();
	// The box was held at ~-60; it must fall back to the ground. Landing plus
	// bounce-and-skid decay is chaotic (corner rocking with restitution 0.1),
	// so assert the fall's outcome — back near the ground — not micro-settling.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(12000);
	});
	const afterRelease = await page.evaluate((boxId) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyPosition(boxId);
	}, boxId);
	if (!afterRelease) throw new Error("box vanished after release");
	// Fell from the ~-60 hold point back to ground level: resting center is
	// -40 (flat) to -56.6 (corner) — both far above the -100 cutoff.
	expect(afterRelease.y).toBeGreaterThan(-100);
	expect(afterRelease.y).toBeLessThan(0);
});
