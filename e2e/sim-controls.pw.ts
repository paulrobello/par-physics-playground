import { expect, test } from "@playwright/test";

/**
 * Sim control cluster: single-step advances exactly one tick (velocity and
 * position asserted against one tick of gravity), pause freezes a falling
 * body, and reset clears every dynamic body. Runs under `?debug=1` where the
 * clock starts paused, so only stepOnce/advanceTime move the sim; stepOnce
 * deliberately ignores pause.
 */
test("step advances exactly one tick; pause freezes; reset clears", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// In debug mode the clock starts paused; the pause button must reflect it.
	await expect(
		page.getByRole("button", { name: "Play simulation (P)" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Play simulation (P)" }),
	).toHaveAttribute("aria-pressed", "true");

	// Single-step from rest: one tick of gravity. Rapier's position integrator
	// is not the naive semi-implicit closed form (fp32 internals), so the
	// velocity is asserted exactly (v = g·dt is exact per tick) and the
	// position delta is bounded to one tick's worth of gravity — excluding 0
	// and 2+ ticks, whose tick counts are asserted exactly alongside.
	await page.evaluate(() => {
		window.__ppg?.spawnBox("step-box", 0, -100, 25, 25);
	});
	const y0: number = (await page.evaluate(
		() => window.__ppg?.bodyPosition("step-box")?.y ?? null,
	)) as number;
	expect(y0).toBe(-100);
	const g = 9.81;
	const dt = 1 / 60;
	await page.click('[data-sim="step"]');
	const afterStep1 = await page.evaluate(() => ({
		y: window.__ppg?.bodyPosition("step-box")?.y ?? 0,
		v: window.__ppg?.bodyLinvel("step-box")?.y ?? 0,
		tick: window.__ppg?.tick() ?? -1,
	}));
	expect(afterStep1.tick).toBe(1);
	expect(Math.abs(afterStep1.v - g * dt)).toBeLessThan(1e-4);
	const delta1 = afterStep1.y - y0;
	expect(delta1).toBeGreaterThan(0.5 * g * dt * dt);
	expect(delta1).toBeLessThan(1.5 * g * dt * dt);

	// Second step accelerates: velocity doubles, position speeds up.
	await page.click('[data-sim="step"]');
	const afterStep2 = await page.evaluate(() => ({
		y: window.__ppg?.bodyPosition("step-box")?.y ?? 0,
		v: window.__ppg?.bodyLinvel("step-box")?.y ?? 0,
		tick: window.__ppg?.tick() ?? -1,
	}));
	expect(afterStep2.tick).toBe(2);
	expect(Math.abs(afterStep2.v - 2 * g * dt)).toBeLessThan(1e-4);
	expect(afterStep2.y - afterStep1.y).toBeGreaterThan(delta1);

	// Reset clears every dynamic body (ground is not registry-tracked) and
	// the world keeps simulating normally afterwards.
	await page.evaluate(() => {
		window.__ppg?.spawnBox("reset-a", -60, -300, 20, 20);
		window.__ppg?.spawnCircle("reset-b", 60, -300, 15);
	});
	let count = await page.evaluate(() => window.__ppg?.bodyIds().length ?? -1);
	expect(count).toBe(3);
	await page.click('[data-sim="reset"]'); // arms only — the world survives
	count = await page.evaluate(() => window.__ppg?.bodyIds().length ?? -1);
	expect(count).toBe(3);
	await page.click('[data-sim="reset"]'); // confirms within the arm window
	count = await page.evaluate(() => window.__ppg?.bodyIds().length ?? -1);
	expect(count).toBe(0);
	// Post-reset sanity: a freshly spawned box still falls and settles on the
	// ground line (rest y = −halfHeight for a 25-half-extent box).
	await page.evaluate(() => {
		window.__ppg?.spawnBox("post-reset", 0, -100, 25, 25);
	});
	await page.evaluate(() => window.__ppg?.advanceTime(10_000));
	const postResetY: number = (await page.evaluate(
		() => window.__ppg?.bodyPosition("post-reset")?.y ?? null,
	)) as number;
	expect(Math.abs(postResetY + 25)).toBeLessThan(0.05);

	// Pause: click Play, let the box fall in real time, then Pause must freeze
	// its position across real frames (advanceTime deliberately ignores pause;
	// the user-facing pause contract is about real-time flow).
	await page.evaluate(() => {
		window.__ppg?.spawnBox("fall-box", 0, -300, 25, 25);
	});
	await page.click('[data-sim="pause"]'); // Play: unpauses the real-time feed
	await expect(
		page.getByRole("button", { name: "Pause simulation (P)" }),
	).toHaveAttribute("aria-pressed", "false");
	await page.waitForFunction(() => {
		const y = window.__ppg?.bodyPosition("fall-box")?.y ?? 0;
		return y > -290; // fallen ≥ 10 world units of real time
	});
	await page.click('[data-sim="pause"]'); // Pause again
	const frozenY: number = (await page.evaluate(
		() => window.__ppg?.bodyPosition("fall-box")?.y ?? null,
	)) as number;
	await page.waitForTimeout(400);
	const after: number = (await page.evaluate(
		() => window.__ppg?.bodyPosition("fall-box")?.y ?? null,
	)) as number;
	expect(Math.abs(after - frozenY)).toBeLessThan(1e-9);
});

/**
 * F7 regression: Space with a focused sim button must activate the button
 * (native behavior) instead of arming camera space-pan. Space-drag pan on the
 * canvas itself stays covered by e2e/camera.pw.ts.
 */
test("Space activates a focused sim button instead of arming camera pan", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const pauseBtn = page.locator('[data-sim="pause"]');
	await pauseBtn.focus();
	await page.keyboard.press("Space");
	// Debug mode starts paused; the button's native Space activation unpauses.
	await expect(pauseBtn).toHaveAttribute("aria-pressed", "false");
	await expect(
		page.getByRole("button", { name: "Pause simulation (P)" }),
	).toBeVisible();
	// The camera must not have claimed the key: no grab cursor armed.
	const cursor = await page.evaluate(
		() =>
			(document.querySelector("#stage") as HTMLElement | null)?.style.cursor ??
			"",
	);
	expect(cursor).not.toBe("grab");

	// Space-drag on the canvas still pans (camera-controls untouched there).
	// Blur whatever holds focus (the button) so the next Space targets the body.
	await page.evaluate(() =>
		(document.activeElement as HTMLElement | null)?.blur(),
	);
	await page.keyboard.down("Space");
	const stage = page.locator("#stage");
	const box = await stage.boundingBox();
	if (!box) throw new Error("stage canvas not visible");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(
		box.x + box.width / 2 + 40,
		box.y + box.height / 2 + 20,
		{ steps: 3 },
	);
	await page.mouse.up();
	await page.keyboard.up("Space");
	const panned = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(Math.abs(panned.offsetX)).toBeGreaterThan(10);
});
