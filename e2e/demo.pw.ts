import { expect, test } from "@playwright/test";

/**
 * Demo scene e2e (P4-T5, local-only per D14): `?demo=1` forces the built-in
 * Rube Goldberg starter alongside `?debug=1`; the deterministic `advanceTime`
 * hook runs the machine end-to-end — the thruster-kicked final ball crosses
 * the FINISH marker. Deleting a machine part through the real UI path
 * (select + Delete) leaves no orphan joints, and undo restores the machine.
 * The top-bar Demo scene / New empty world actions drive the same load path.
 */

test("demo machine runs end-to-end, deletes cleanly, undoes, reloads", async ({
	page,
}) => {
	await page.goto("/?debug=1&demo=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// The machine runs end-to-end: the final ball crosses the FINISH marker
	// (x > 450) and ball A's cascade topples the domino row (the ramp slide
	// alone is many seconds — Rube Goldberg pacing). Deterministic — the
	// same numbers every run (40 s of sim, ~2400 fixed ticks).
	await page.evaluate(() => window.__ppg?.advanceTime(40_000));
	const run = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			finalX: ppg.bodyPosition("demo-final")?.x ?? Number.NaN,
			dominoesToppled: ppg
				.bodyIds()
				.filter((id) => id.startsWith("demo-domino"))
				.filter((id) => Math.abs(ppg.bodyRot(id) ?? 0) > 0.5).length,
			jointCount: ppg.jointIds().length,
			thrusterCount: ppg.thrusterIds().length,
		};
	});
	expect(run.finalX).toBeGreaterThan(450);
	expect(run.dominoesToppled).toBeGreaterThanOrEqual(2);
	expect(run.jointCount).toBeGreaterThan(20);
	expect(run.thrusterCount).toBe(1);

	// Delete the cradle through the real UI path (select tool + Delete): its
	// rope capture pin and the counterweight weld die with it — no orphan
	// joints remain. The click aims at the cradle's right arm — offset from
	// the centre so it lands on the body, not on the rope-cap pin glyph
	// riding the cradle's top edge (joint pick radius is 6 world units).
	const spot = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const p = ppg.bodyPosition("demo-cradle");
		if (!p) throw new Error("cradle missing");
		const cam = ppg.cameraState();
		const stage = document
			.querySelector<HTMLElement>("#stage")
			?.getBoundingClientRect();
		if (!stage) throw new Error("stage missing");
		return {
			x: (stage?.x ?? 0) + (p.x + 15) * cam.zoom + cam.offsetX,
			y: (stage?.y ?? 0) + p.y * cam.zoom + cam.offsetY,
		};
	});
	await page.keyboard.press("v");
	await page.mouse.click(spot.x, spot.y);
	await page.keyboard.press("Delete");
	const afterDelete = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const bodyIds = new Set(ppg.bodyIds());
		const orphans = ppg
			.jointIds()
			.map((id) => ppg.joint(id))
			.filter(
				(j) =>
					!bodyIds.has(j?.bodyA ?? "") ||
					(j?.bodyB !== null && !bodyIds.has(j?.bodyB ?? "")),
			).length;
		return {
			orphans,
			cradleGone: !bodyIds.has("demo-cradle"),
			joints: ppg.jointIds().length,
			thrusters: ppg.thrusterIds().length,
		};
	});
	expect(afterDelete.cradleGone).toBe(true);
	expect(afterDelete.orphans).toBe(0);
	// Exactly the weld + the rope capture pin went with it.
	expect(afterDelete.joints).toBe(run.jointCount - 2);
	expect(afterDelete.thrusters).toBe(run.thrusterCount);

	// Undo restores the machine whole.
	await page.evaluate(() => window.__ppg?.undo());
	const afterUndo = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			cradleBack: ppg.bodyIds().includes("demo-cradle"),
			joints: ppg.jointIds().length,
		};
	});
	expect(afterUndo.cradleBack).toBe(true);
	expect(afterUndo.joints).toBe(run.jointCount);

	// New empty world clears; the Demo scene button loads the machine back.
	await page.click('[data-sim="new-world"]');
	const cleared = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { bodies: ppg.bodyIds().length, joints: ppg.jointIds().length };
	});
	expect(cleared.bodies).toBe(0);
	expect(cleared.joints).toBe(0);
	await page.click('[data-sim="demo"]');
	const reloaded = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			finalBack: ppg.bodyIds().includes("demo-final"),
			joints: ppg.jointIds().length,
		};
	});
	expect(reloaded.finalBack).toBe(true);
	expect(reloaded.joints).toBe(run.jointCount);
});
