import { expect, test } from "@playwright/test";

/**
 * Material palette e2e (debug mode: real-time feed paused, `advanceTime`
 * drives the sim). Draws two static ramps with the line tool, then drops an
 * ice box down one and a stone box down the other: near-zero friction makes
 * the ice box slide far while the stone box barely moves. A rubber box
 * dropped on flat ground bounces (velocity sign flips counted through the
 * debug API) — restitution and friction both come from the material.
 */
test("ice slides far, stone does not, rubber bounces", async ({ page }) => {
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

	// Two static ramps (static mode + line tool): 45-degree drops toward +x.
	await page.keyboard.press("s");
	expect(
		await page.locator('[data-mode="static"]').getAttribute("aria-pressed"),
	).toBe("true");
	await page.keyboard.press("l");
	await drag(30, -80, 90, -20);
	await drag(260, -80, 320, -20);
	await page.keyboard.press("s"); // back to dynamic spawns
	expect(
		await page.locator('[data-mode="static"]').getAttribute("aria-pressed"),
	).toBe("false");

	// Ice box near the top of ramp 1, stone box near the top of ramp 2 (the
	// camera has no x offset, so the scene stays in positive world x).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("ice", 46, -70, 1, 1, "ice");
		ppg.spawnBox("stone", 276, -70, 1, 1, "stone");
	});

	const started = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const ids = ppg.bodyIds();
		return {
			ice: ppg.bodyPosition("ice"),
			stone: ppg.bodyPosition("stone"),
			iceMat: ppg.bodyMaterial("ice"),
			stoneMat: ppg.bodyMaterial("stone"),
			ramp1: ppg.bodyIsStatic(ids[0] ?? ""),
		};
	});
	if (!started.ice || !started.stone) throw new Error("boxes missing at spawn");
	expect(started.iceMat?.id).toBe("ice");
	expect(started.stoneMat?.id).toBe("stone");
	expect(started.iceMat?.friction).toBeCloseTo(0.02);
	expect(started.ramp1).toBe(true);

	// Rubber box drops onto flat ground from a height; count bounces as
	// downward->upward velocity flips across 33ms simulated samples (12s total).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("rubber", 450, -12, 1, 1, "rubber");
	});
	const bounces = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		let count = 0;
		let wasFalling = false;
		for (let i = 0; i < 360; i++) {
			ppg.advanceTime(33);
			const v = ppg.bodyLinvel("rubber");
			if (!v) break;
			if (v.y > 0.5) wasFalling = true;
			else if (wasFalling && v.y < -0.5) {
				count += 1;
				wasFalling = false;
			}
		}
		return count;
	});
	expect(bounces).toBeGreaterThanOrEqual(3);

	// Slides: 10 more simulated seconds, then compare horizontal travel.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(10000);
	});
	const ended = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			ice: ppg.bodyPosition("ice"),
			stone: ppg.bodyPosition("stone"),
			rubber: ppg.bodyPosition("rubber"),
		};
	});
	if (!ended.ice || !ended.stone || !ended.rubber)
		throw new Error("a box was culled, not settled");

	// Ice slides far down-slope and past the ramp base; stone barely moves.
	const iceTravel = ended.ice.x - started.ice.x;
	const stoneTravel = ended.stone.x - started.stone.x;
	expect(
		iceTravel,
		`ice travel=${iceTravel} stone travel=${stoneTravel} ice=${JSON.stringify(ended.ice)} stone=${JSON.stringify(ended.stone)}`,
	).toBeGreaterThan(30);
	expect(iceTravel).toBeGreaterThan(stoneTravel + 10);
	// Rubber settles on the ground (top at y=0, half-height 1).
	expect(Math.abs(ended.rubber.y + 1)).toBeLessThan(0.5);
});
