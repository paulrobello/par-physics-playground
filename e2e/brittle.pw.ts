import { expect, test } from "@playwright/test";

/**
 * Brittle materials extra e2e (debug mode: real-time feed paused,
 * `advanceTime` drives the sim). Creates a brittle custom material through
 * the real editor form (the checkbox round-trip), then drops a box of it
 * hard: it shatters into four half-size same-material fragments while a
 * second box of the same material resting on the ground stays intact.
 */
test("brittle material: hard drop shatters, resting stays intact", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Create the brittle custom material through the editor form.
	await page.click("[data-mat-new]");
	await page.fill("[data-mat-name]", "Glass");
	await page.check("[data-mat-brittle]");
	await page.click("[data-mat-save]");

	const matId = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const glass = ppg.materials().find((m) => m.brittle === true);
		return glass ? glass.id : null;
	});
	if (!matId) throw new Error("brittle custom material missing after save");

	// Hard drop from 39 units at x=0; a resting slab of the same material
	// off to the side at x=40.
	await page.evaluate(
		({ matId }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			ppg.spawnBox("pane", 0, -40, 1, 1, matId);
			ppg.spawnBox("slab", 40, -1, 1, 1, matId);
		},
		{ matId },
	);

	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(5000);
	});

	const result = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const ids = ppg.bodyIds();
		const frags = ids.filter((id) => id !== "pane" && id !== "slab");
		return {
			paneGone: !ids.includes("pane"),
			slabIntact: ids.includes("slab"),
			fragCount: frags.length,
			fragShapes: frags.map((id) => ppg.bodyShape(id)),
			fragMats: frags.map((id) => ppg.bodyMaterial(id)?.id),
		};
	});

	expect(result.paneGone).toBe(true);
	expect(result.slabIntact).toBe(true);
	expect(result.fragCount).toBe(4);
	for (const shape of result.fragShapes) {
		expect(shape).toEqual({ kind: "box", halfWidth: 0.5, halfHeight: 0.5 });
	}
	for (const mat of result.fragMats) {
		expect(mat).toBe(matId);
	}
});
