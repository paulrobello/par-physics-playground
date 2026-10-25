import { expect, test } from "@playwright/test";

/**
 * Thruster burn duration (Paul, 2026-10-25): a rocket with a duration stops
 * thrusting after that many sim seconds; the panel field takes decimals to
 * two places, empty clears the limit, and the scene round-trips it. Runs in
 * zero gravity so the burn comparison is clean.
 */

test("a duration-limited rocket burns out while the unlimited twin keeps thrusting", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Two identical rockets, one limited to 0.1 s of burn.
	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.setGravityVector(0, 0);
		ppg.spawnBox("d-box", 0, -150, 10, 10);
		ppg.spawnBox("f-box", 200, -150, 10, 10);
		// Body-LOCAL anchors (the debug placement passes them through): both
		// rockets mount at the box center, thrusting along +x.
		ppg.placeThruster("d-th", "d-box", 0, 0, 0, 12000, true);
		ppg.placeThruster("f-th", "f-box", 0, 0, 0, 12000, true);
		ppg.setThrusterParams("d-th", { duration: 0.1 });
	});

	// The panel shows the stored duration when the thruster is selected.
	// Selecting = clicking the glyph, which TOGGLES it off (the glyph toggle,
	// interaction.ts onClickSelect) — click once to select+toggle, again to
	// restore thrusting while keeping the selection.
	await page.locator('[data-tool="select"]').click();
	const pose = await page.evaluate(() => window.__ppg!.thrusterPose("d-th"));
	const stage = await page.locator("#stage").boundingBox();
	const cam = await page.evaluate(() => window.__ppg!.cameraState());
	const px = stage!.x + pose!.x * cam.zoom + cam.offsetX;
	const py = stage!.y + pose!.y * cam.zoom + cam.offsetY;
	await page.mouse.click(px, py);
	await page.mouse.click(px, py);
	await expect
		.poll(() => page.evaluate(() => window.__ppg!.thruster("d-th")!.on))
		.toBe(true);
	const durationInput = page.locator("[data-thruster-duration]");
	await expect(durationInput).toHaveValue("0.1");
	// Two-decimal edit lands in the document inside one undo action.
	await durationInput.fill("1.5");
	await durationInput.blur();
	expect(
		await page.evaluate(() => window.__ppg!.thruster("d-th")!.duration),
	).toBe(1.5);
	// ...and an edit restarts the countdown, so run from a fresh state.
	await page.evaluate(() =>
		window.__ppg!.setThrusterParams("d-th", { duration: 0.1 }),
	);

	// 2 s of sim: the limited rocket burned out at 0.1 s and coasts; the
	// unlimited twin kept accelerating the whole time.
	await page.evaluate(() => window.__ppg!.advanceTime(2000));
	const v = await page.evaluate(() => ({
		d: window.__ppg!.bodyLinvel("d-box")!.x,
		f: window.__ppg!.bodyLinvel("f-box")!.x,
	}));
	expect(v.d).toBeGreaterThan(0);
	expect(v.f).toBeGreaterThan(v.d * 3);

	// The limited one has stopped: velocity is stable across 500 ms more.
	const v1 = await page.evaluate(() => window.__ppg!.bodyLinvel("d-box")!.x);
	await page.evaluate(() => window.__ppg!.advanceTime(500));
	const v2 = await page.evaluate(() => window.__ppg!.bodyLinvel("d-box")!.x);
	expect(Math.abs(v2 - v1)).toBeLessThan(1);
});
