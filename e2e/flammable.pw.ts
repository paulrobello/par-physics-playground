import { expect, test } from "@playwright/test";

/**
 * Flammable materials extra e2e (debug mode: real-time feed paused,
 * `advanceTime` drives the sim). Creates a flammable custom material through
 * the real editor form (the checkbox round-trip), mounts a firing thruster
 * whose exhaust beam hits one of two touching flammable boxes: the beam
 * target ignites, the neighbor ignites through contact spread, a distant
 * flammable box stays unlit, and the burning pair is consumed after the
 * fixed burn while the distant box survives.
 */
test("flammable material: exhaust ignites, fire spreads on contact, bodies burn out", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Create the flammable custom material through the editor form.
	await page.click("[data-mat-new]");
	await page.fill("[data-mat-name]", "Paper");
	await page.check("[data-mat-flammable]");
	await page.click("[data-mat-save]");

	const matId = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const paper = ppg.materials().find((m) => m.flammable === true);
		return paper ? paper.id : null;
	});
	if (!matId) throw new Error("flammable custom material missing after save");

	// Static mount resting on the ground line, firing +x (exhaust −x);
	// page1 in the beam 4 units out; page2 stacked ON page1 (spread only —
	// the beam never touches it); page3 far away on the ground, out of
	// reach and out of the spread radius.
	await page.evaluate(
		({ matId }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			ppg.spawnBox("mount", 0, -1, 1, 1, "ink", true);
			ppg.spawnBox("page1", -4, -1, 1, 1, matId);
			ppg.spawnBox("page2", -4, -3, 1, 1, matId);
			ppg.spawnBox("page3", -40, -1, 1, 1, matId);
			ppg.placeThruster("th", "mount", 0, 0, 0, 10_000, true);
		},
		{ matId },
	);

	// One step brings the broad-phase up; the next ignites page1.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.stepOnce();
		ppg.stepOnce();
	});

	const lit = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			page1: ppg.isBurning("page1"),
			page2: ppg.isBurning("page2"),
			page3: ppg.isBurning("page3"),
		};
	});
	expect(lit.page1).toBe(true);
	expect(lit.page2).toBe(true);
	expect(lit.page3).toBe(false);

	// The fixed burn consumes both touched boxes; the distant one survives.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(5200);
	});

	const result = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			page1Gone: !ppg.bodyIds().includes("page1"),
			page2Gone: !ppg.bodyIds().includes("page2"),
			page3Intact: ppg.bodyIds().includes("page3"),
			mountIntact: ppg.bodyIds().includes("mount"),
		};
	});

	expect(result.page1Gone).toBe(true);
	expect(result.page2Gone).toBe(true);
	expect(result.page3Intact).toBe(true);
	expect(result.mountIntact).toBe(true);
});
