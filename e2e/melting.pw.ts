import { expect, test } from "@playwright/test";

/**
 * Melting materials extra e2e (debug mode: real-time feed paused,
 * `advanceTime` drives the sim). A melting custom material created through
 * the real editor form disappears after MELT_SECONDS of sustained exhaust
 * aim; a body with BOTH flags ignites instead (flammable wins) and is
 * consumed at the 4s burn while a melting-only control under the same aim
 * survives past the burn and melts later.
 */
test("melting material: sustained aim melts, both flags burn rather than melt", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Wax (melting) and Waxfire (both flags) through the editor form.
	for (const [name, check] of [
		["Wax", "[data-mat-melting]"],
		["Waxfire", "[data-mat-flammable]"],
	] as const) {
		await page.click("[data-mat-new]");
		await page.fill("[data-mat-name]", name);
		await page.check(check);
		// Waxfire carries BOTH flags: the form is stateful per open, so tick
		// melting too while it is open.
		if (name === "Waxfire") await page.check("[data-mat-melting]");
		await page.click("[data-mat-save]");
	}

	const matIds = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const wax = ppg.materials().find((m) => m.melting === true && !m.flammable);
		const both = ppg
			.materials()
			.find((m) => m.melting === true && m.flammable === true);
		if (!wax || !both) throw new Error("melting materials missing after save");
		return { wax: wax.id, both: both.id };
	});

	// Two exhaust beams off one mount: "both" in the −x beam, wax control in
	// the +x beam (thrust 180°).
	await page.evaluate(
		({ matIds }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			ppg.spawnBox("mount", 0, -1, 1, 1, "ink", true);
			ppg.spawnBox("both1", -4, -1, 1, 1, matIds.both);
			ppg.spawnBox("wax1", 4, -1, 1, 1, matIds.wax);
			ppg.placeThruster("th1", "mount", 0, 0, 0, 10_000, true);
			ppg.placeThruster("th2", "mount", 0, 0, 180, 10_000, true);
		},
		{ matIds },
	);

	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.stepOnce();
	});

	const state = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			bothBurning: ppg.isBurning("both1"),
			bothMelt: ppg.meltProgress("both1"),
			waxMelt: ppg.meltProgress("wax1"),
		};
	});
	// Flammable wins on the both-flags body: it burns and never accumulates
	// melt heat; the melting-only control accumulates from the first tick.
	expect(state.bothBurning).toBe(true);
	expect(state.bothMelt).toBe(0);
	expect(state.waxMelt).toBeGreaterThan(0);

	// Past the 4s burn but before the 6s melt: the both-flags body is gone
	// (the burn won), the melting-only control is still there.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(4700);
	});

	const mid = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			bothGone: !ppg.bodyIds().includes("both1"),
			waxIntact: ppg.bodyIds().includes("wax1"),
			waxMelt: ppg.meltProgress("wax1"),
		};
	});
	expect(mid.bothGone).toBe(true);
	expect(mid.waxIntact).toBe(true);
	expect(mid.waxMelt).toBeGreaterThan(0.7);

	// The control finishes its melt.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(2500);
	});

	const end = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return !ppg.bodyIds().includes("wax1");
	});
	expect(end).toBe(true);
});
