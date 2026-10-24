import { expect, test } from "@playwright/test";

/**
 * Polygon + line/beam e2e (debug mode: real-time feed paused, `advanceTime`
 * drives the sim). Creates a triangle with the polygon tool (click vertices,
 * Enter to close), an L-shaped concave polygon (verifies the multi-part
 * triangulation rests stably as one rigid unit), and a beam with the line
 * tool (drag). All settle on the ground, and a
 * dropped ball lands on the beam — the shapes collide, not just exist.
 */
test("polygon and beam tools create bodies that settle and collide", async ({
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
	const clickWorld = async (wx: number, wy: number): Promise<void> => {
		const p = await pagePos(wx, wy);
		await page.mouse.move(p.x, p.y);
		await page.mouse.down();
		await page.mouse.up();
	};

	// Polygon tool: triangle with a flat bottom (world vertices below).
	await page.keyboard.press("g");
	expect(
		await page.locator('[data-tool="polygon"]').getAttribute("aria-pressed"),
	).toBe("true");
	await clickWorld(100, -80);
	await clickWorld(160, -80);
	await clickWorld(130, -140);
	await page.keyboard.press("Enter");

	// Polygon tool: concave L, flat bottom, tall leg (triangulated → 4 parts).
	await clickWorld(400, -80);
	await clickWorld(460, -80);
	await clickWorld(460, -110);
	await clickWorld(430, -110);
	await clickWorld(430, -170);
	await clickWorld(400, -170);
	await page.keyboard.press("Enter");

	// Line tool: horizontal beam by drag.
	await page.keyboard.press("l");
	expect(
		await page.locator('[data-tool="line"]').getAttribute("aria-pressed"),
	).toBe("true");
	const s1 = await pagePos(700, -300);
	const s2 = await pagePos(900, -300);
	await page.mouse.move(s1.x, s1.y);
	await page.mouse.down();
	await page.mouse.move(s2.x, s2.y, { steps: 4 });
	await page.mouse.up();

	const ids = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyIds();
	});
	expect(ids.length).toBe(3);
	const triId = ids[0];
	const lId = ids[1];
	const beamId = ids[2];
	if (!triId || !lId || !beamId)
		throw new Error("expected triangle, L, and beam spawned");

	// Everything settles under gravity.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(10000);
	});
	const state = await page.evaluate(
		({ triId, lId, beamId }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return {
				tri: ppg.bodyPosition(triId),
				triRot: ppg.bodyRot(triId),
				l: ppg.bodyPosition(lId),
				lRot: ppg.bodyRot(lId),
				beam: ppg.bodyPosition(beamId),
				beamRot: ppg.bodyRot(beamId),
				ids: ppg.bodyIds(),
			};
		},
		{ triId, lId, beamId },
	);
	if (!state.tri || !state.l || !state.beam)
		throw new Error("a body was culled, not settled");
	// All three survived culling.
	expect(state.ids).toHaveLength(3);

	// Triangle: flat bottom rests on the ground — centroid 20 above it.
	expect(Math.abs(state.tri.x - 130)).toBeLessThan(0.5);
	expect(Math.abs(state.tri.y + 20)).toBeLessThan(0.5);
	expect(Math.abs(state.triRot ?? 1)).toBeLessThan(0.05);

	// L-shape: rests flat (multi-part triangulation as one rigid unit).
	expect(Math.abs(state.lRot ?? 1)).toBeLessThan(0.05);
	expect(state.l.y).toBeLessThan(0);
	// Stability: after further sim time the pose does not move.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(5000);
	});
	const lAgain = await page.evaluate((lId) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			p: ppg.bodyPosition(lId),
			rot: ppg.bodyRot(lId),
		};
	}, lId);
	if (!lAgain.p) throw new Error("L-shape culled during stability check");
	expect(Math.abs(lAgain.p.x - state.l.x)).toBeLessThan(0.01);
	expect(Math.abs(lAgain.p.y - state.l.y)).toBeLessThan(0.01);
	expect(Math.abs((lAgain.rot ?? 1) - (state.lRot ?? 1))).toBeLessThan(0.001);

	// Beam: a 200-long thin box rests flat on the ground.
	expect(Math.abs(state.beam.x - 800)).toBeLessThan(2);
	expect(Math.abs(state.beam.y + 0.25)).toBeLessThan(0.5);
	expect(Math.abs(state.beamRot ?? 1)).toBeLessThan(0.05);

	// Collision: a ball dropped above the beam lands on top of it.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnCircle("ball", 800, -100, 10);
	});
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(5000);
	});
	const ball = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyPosition("ball");
	});
	if (!ball) throw new Error("ball culled");
	// Beam top at y=-0.5, ball radius 10: rest center y = -10.5.
	expect(Math.abs(ball.y + 10.5)).toBeLessThan(0.5);
});
