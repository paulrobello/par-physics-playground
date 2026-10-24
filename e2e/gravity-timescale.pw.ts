import { expect, test } from "@playwright/test";

/**
 * P3-T3 simulation controls (PRD D5): gravity direction/magnitude/presets
 * applied to the LIVE world, and the 0.25×–2× time scale acting on the
 * accumulator FEED RATE with the fixed tick untouched. Runs under `?debug=1`
 * (clock paused, `advanceTime` drives the sim deterministically).
 */
test("flipped gravity lifts a resting box; zero-g lets it drift", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Settle a box onto the ground (advanceTime determinism: exactly 600 ticks).
	const result = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("grav-box", 0, -100, 25, 25);
		ppg.advanceTime(10_000);
		return {
			y: ppg.bodyPosition("grav-box")?.y ?? 0,
			sleeping: ppg.bodyIsSleeping("grav-box") ?? false,
		};
	});
	expect(Math.abs(result.y + 25)).toBeLessThan(0.05);
	expect(result.sleeping).toBe(true);

	// Flip gravity to point UP: the sleeping box must wake immediately, then
	// fall upward — 2 s of sim time from rest covers ½·9.81·2² ≈ 19.6 m, so
	// from the rest height y = −25 the centre must be well above −45.
	const flipped = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.setGravityVector(0, -9.81);
		const woken = !(ppg.bodyIsSleeping("grav-box") ?? true);
		ppg.advanceTime(2000);
		return {
			woken,
			y: ppg.bodyPosition("grav-box")?.y ?? 0,
			gravity: ppg.gravity(),
		};
	});
	expect(flipped.gravity.y).toBeLessThan(0);
	expect(flipped.woken).toBe(true);
	expect(flipped.y).toBeLessThan(-40);

	// Zero-g: a box spawned away from the ground must not fall — no gravity,
	// no velocity, so it drifts in place.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.setGravityVector(0, 0);
		ppg.spawnBox("zero-box", 0, -300, 25, 25);
		ppg.advanceTime(2000);
	});
	const zeroY: number = (await page.evaluate(
		() => window.__ppg?.bodyPosition("zero-box")?.y ?? null,
	)) as number;
	expect(zeroY).toBeCloseTo(-300, 3);

	// The Moon preset value (via the pure mapping, asserted in unit tests) also
	// reaches the live world through the debug hook.
	await page.evaluate(() => window.__ppg?.setGravityVector(0, 1.62));
	const moonG = await page.evaluate(() => window.__ppg?.gravity());
	expect(moonG).toEqual({ x: 0, y: 1.62 });
});

test("0.5× advances about half the sim time of 1×; advanceTime stays exact", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Unpause the real-time feed (debug mode starts paused) so rAF feeds the
	// accumulator; the wall-clock rate then reflects the time scale.
	await page.click('[data-sim="pause"]');

	const ticksOver = async (ms: number): Promise<number> => {
		const start = await page.evaluate(() => window.__ppg?.tick() ?? -1);
		await page.waitForTimeout(ms);
		return (await page.evaluate(() => window.__ppg?.tick() ?? -1)) - start;
	};

	// Warm-up so the first window does not pay page-load rAF ramp-up.
	await ticksOver(250);
	const ticks1x = await ticksOver(1000);
	// Headless rAF can vary, but 1× must still advance near real-time
	// (60 ticks/s nominal; the catch-up cap absorbs frame jitter).
	expect(ticks1x).toBeGreaterThanOrEqual(40);

	await page.evaluate(() => window.__ppg?.setTimeScale(0.5));
	expect(await page.evaluate(() => window.__ppg?.timeScale())).toBe(0.5);
	const ticksHalf = await ticksOver(1000);
	const ratio = ticksHalf / ticks1x;
	// Half the feed rate: a wide band around 0.5 — tight enough to fail if the
	// scale is ignored (ratio would be ~1) or misapplied as a per-tick dt.
	// Wide margins: the assertion must separate "≈half" from the failure
	// modes (ignored ≈1, misapplied ≫1), not pin 0.5 — host load shifts the
	// wall-clock windows and flipped the old 0.3–0.7 bound (measured twice on
	// 2026-10-24 at load ~10; clean runs pass in 4 s).
	expect(ratio).toBeGreaterThan(0.25);
	expect(ratio).toBeLessThan(0.8);

	// Determinism guard: pause the wall-clock feed again (an rAF frame between
	// the evaluates below would leave a real-time remainder in the accumulator),
	// then advanceTime must still advance EXACTLY 600 ticks for 10 000 ms with
	// 2× set — the scale never leaks into the deterministic path. stepOnce
	// zeroes any leftover remainder before the exact window.
	await page.click('[data-sim="pause"]');
	await page.evaluate(() => {
		window.__ppg?.setTimeScale(2);
		window.__ppg?.stepOnce();
	});
	const before = await page.evaluate(() => window.__ppg?.tick() ?? -1);
	await page.evaluate(() => window.__ppg?.advanceTime(10_000));
	const after = await page.evaluate(() => window.__ppg?.tick() ?? -1);
	expect(after - before).toBe(600);
});

test("gravity presets and the speed slider drive the live world from the UI", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Moon preset button: the live gravity must read lunar.
	await page.click('[data-gravity-preset="moon"]');
	let g = await page.evaluate(() => window.__ppg?.gravity());
	expect(g?.x).toBeCloseTo(0, 9);
	expect(g?.y).toBeCloseTo(1.62, 2);
	// Preset writes back into the sliders.
	await expect(page.locator('[data-sim="gravity-mag"]')).toHaveValue("1.62");

	// The direction slider alone flips gravity to point up.
	await page.locator('[data-sim="gravity-angle"]').fill("180");
	g = await page.evaluate(() => window.__ppg?.gravity());
	expect(g?.y).toBeCloseTo(-1.62, 2);

	// The speed slider drives the shared TimeScale state.
	await page.locator('[data-sim="time-scale"]').fill("0.5");
	expect(await page.evaluate(() => window.__ppg?.timeScale())).toBe(0.5);

	// The debug-API write syncs back into the slider (TimeScale listeners).
	await page.evaluate(() => window.__ppg?.setTimeScale(2));
	await expect(page.locator('[data-sim="time-scale"]')).toHaveValue("2");
	await expect(page.locator('[data-sim="time-scale-out"]')).toHaveText("2.00×");

	// Fix-wave F4: a debug-API GRAVITY write must sync the sliders the same
	// way (no stale direction/magnitude for the next slider move to pair with).
	// setGravityVector takes the vector: (5, ~0) is 90° (right) at mag 5.
	await page.evaluate(() => window.__ppg?.setGravityVector(5, 0));
	await expect(page.locator('[data-sim="gravity-angle"]')).toHaveValue("90");
	await expect(page.locator('[data-sim="gravity-mag"]')).toHaveValue("5");
	// Moving one slider afterwards applies the CURRENT other value, not a
	// stale one: 270° at mag 5 points gravity left (−x).
	await page.locator('[data-sim="gravity-angle"]').fill("270");
	const gLeft = await page.evaluate(() => window.__ppg?.gravity());
	expect(gLeft?.x).toBeCloseTo(-5, 6);
	expect(gLeft?.y).toBeCloseTo(0, 6);
});
