import { expect, test } from "@playwright/test";

/**
 * Transform gizmo e2e (debug mode): selecting a body with the select tool
 * draws the gizmo over the selection's combined bounds — square corner
 * handles scale, the ring handle above the top edge rotates — multi-selection
 * rotates both bodies in ONE undo action, undo restores exactly, and a
 * handle drag mid-run keeps the sim alive. Criterion evidence for the
 * transform-gizmo card. Bodies spawn in the viewport's world range
 * (x ∈ [0, width] at the boot camera) so the synthesized clicks land on the
 * canvas, and they are STATIC so the handle math below stays exact.
 */

/** Snapshot of one body's transform + box shape, via the debug API. */
interface BodySnapshot {
	x: number;
	y: number;
	rot: number;
	halfWidth: number;
	halfHeight: number;
}

const snapshotOf = (id: string): string =>
	`(function(){ const ppg = window.__ppg; if (!ppg) throw new Error("debug api missing"); const p = ppg.bodyPosition('${id}'); const s = ppg.bodyShape('${id}'); const r = ppg.bodyRot('${id}'); if (!p || !s || s.kind !== 'box' || r === undefined) throw new Error('body ${id} missing'); return { x: p.x, y: p.y, rot: r, halfWidth: s.halfWidth, halfHeight: s.halfHeight }; })()`;

test("gizmo scales on corner drag, rotates on ring drag, multi-select undoes", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));

	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");

	const call = <T>(body: string): Promise<T> =>
		page.evaluate(
			`(function(){ const ppg = window.__ppg; if (!ppg) throw new Error("debug api missing"); return (${body}); })()`,
		) as Promise<T>;

	// Two settled boxes (static: poses stay put while the sim runs, so the
	// handle math below stays exact).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("a", 300, -300, 20, 20, undefined, true);
		ppg.spawnBox("b", 700, -300, 20, 20, undefined, true);
	});

	await page.keyboard.press("v");
	const aPos = await call<{ x: number; y: number }>("ppg.bodyPosition('a')");
	if (!aPos) throw new Error("box a missing");
	const cam = await call<{
		zoom: number;
		offsetX: number;
		offsetY: number;
	}>("ppg.cameraState()");
	const at = (wx: number, wy: number): { x: number; y: number } => ({
		x: stageBox.x + wx * cam.zoom + cam.offsetX,
		y: stageBox.y + wy * cam.zoom + cam.offsetY,
	});

	// Select the first body: the gizmo appears (discovery criterion).
	await page.mouse.click(at(aPos.x, aPos.y).x, at(aPos.x, aPos.y).y);
	await expect.poll(() => call<string[]>("ppg.selectedIds()")).toContain("a");

	// Corner drag scales: the TL corner (px-20, py-20), anchored at BR
	// (px+20, py+20) — a pointer at TWICE the corner→anchor distance doubles
	// the factor (halfWidth 20 → 40).
	const tl = at(aPos.x - 20, aPos.y - 20);
	const far = at(aPos.x - 60, aPos.y - 60);
	await page.mouse.move(tl.x, tl.y);
	await page.mouse.down();
	await page.mouse.move(far.x, far.y, { steps: 4 });
	await page.mouse.up();
	const shape = await call<{
		kind: string;
		halfWidth: number;
		halfHeight: number;
	}>("ppg.bodyShape('a')");
	if (!shape || shape.kind !== "box") throw new Error("box shape missing");
	expect(shape.halfWidth).toBeCloseTo(40, 0);
	expect(shape.halfHeight).toBeCloseTo(40, 0);

	// Ring drag rotates: the ring hangs 8px above the CURRENT top edge — the
	// box is halfWidth 40 after the corner drag above — and sweeping it a
	// quarter turn counter-clockwise around the box center (y-down world: up
	// is -y) rotates the body by the delta.
	const ringR = 40 + 8 / cam.zoom;
	const ring = at(aPos.x, aPos.y - 40 - 8 / cam.zoom);
	const swept = at(
		aPos.x - ringR * Math.SQRT1_2,
		aPos.y - ringR * Math.SQRT1_2,
	);
	const rotBefore = await call<number | undefined>("ppg.bodyRot('a')");
	if (rotBefore === undefined) throw new Error("box a missing");
	await page.mouse.move(ring.x, ring.y);
	await page.mouse.down();
	await page.mouse.move(swept.x, swept.y, { steps: 4 });
	await page.mouse.up();
	await expect
		.poll(() => call<number | undefined>("ppg.bodyRot('a')"))
		.toBeCloseTo(rotBefore - Math.PI / 4, 1);

	// Multi-select (shift-click the second body) + ring drag rotates BOTH
	// around the combined box center via ONE undo action; undo restores both
	// bodies exactly.
	await page.keyboard.down("Shift");
	await page.mouse.click(at(700, aPos.y).x, at(700, aPos.y).y);
	await page.keyboard.up("Shift");
	await expect.poll(() => call<string[]>("ppg.selectedIds()")).toContain("b");

	const beforeA = await call<BodySnapshot>(snapshotOf("a"));
	const beforeB = await call<number>("ppg.bodyRot('b')");

	// Combined box after the first ring drag: a (40×40, now rotated −45°) has
	// an AABB half-extent of 40·√2 about its center; b (20) spans
	// [680,-320]-[720,-280]. The ring hangs 8px above the combined top edge,
	// centered on it; the pivot is the combined box's center.
	const aHalf = 40 * Math.SQRT2;
	const pairMinX = aPos.x - aHalf;
	const pairTop = aPos.y - aHalf;
	const pairMaxX = 720;
	const pairBottom = -260;
	const pairRingX = (pairMinX + pairMaxX) / 2;
	const pairRingY = pairTop - 8 / cam.zoom;
	const pairRing = at(pairRingX, pairRingY);
	const pivotY = (pairTop + pairBottom) / 2;
	const pairR = pairRingY - pivotY;
	const pairSwept = at(
		pairRingX - pairR * Math.SQRT1_2,
		pivotY - pairR * Math.SQRT1_2,
	);
	await page.mouse.move(pairRing.x, pairRing.y);
	await page.mouse.down();
	await page.mouse.move(pairSwept.x, pairSwept.y, { steps: 4 });
	await page.mouse.up();
	const rotA2 = await call<number>("ppg.bodyRot('a')");
	const rotB2 = await call<number>("ppg.bodyRot('b')");
	expect(rotA2).not.toBeCloseTo(beforeA.rot, 3);
	expect(rotB2).not.toBeCloseTo(beforeB, 3);

	await page.keyboard.press("Control+z");
	await expect
		.poll(() => call<number>("ppg.bodyRot('a')"))
		.toBeCloseTo(beforeA.rot, 3);
	const afterA = await call<BodySnapshot>(snapshotOf("a"));
	expect(afterA.x).toBeCloseTo(beforeA.x, 3);
	expect(afterA.y).toBeCloseTo(beforeA.y, 3);
	expect(afterA.halfWidth).toBeCloseTo(beforeA.halfWidth, 3);
	expect(afterA.halfHeight).toBeCloseTo(beforeA.halfHeight, 3);
	const rotBRestored = await call<number>("ppg.bodyRot('b')");
	expect(rotBRestored).toBeCloseTo(beforeB, 3);

	expect(errors).toEqual([]);
});

test("a handle drag mid-run keeps the sim alive and scales", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (err) => errors.push(String(err)));

	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");

	const call = <T>(body: string): Promise<T> =>
		page.evaluate(
			`(function(){ const ppg = window.__ppg; if (!ppg) throw new Error("debug api missing"); return (${body}); })()`,
		) as Promise<T>;

	// A static box (terrain): its pose never moves, so the gizmo handles
	// stay exactly where the math puts them while the sim runs.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("t", 300, -300, 20, 20, undefined, true);
	});

	await page.keyboard.press("v");
	const pos = await call<{ x: number; y: number }>("ppg.bodyPosition('t')");
	if (!pos) throw new Error("box t missing");
	const cam = await call<{
		zoom: number;
		offsetX: number;
		offsetY: number;
	}>("ppg.cameraState()");
	const at = (wx: number, wy: number): { x: number; y: number } => ({
		x: stageBox.x + wx * cam.zoom + cam.offsetX,
		y: stageBox.y + wy * cam.zoom + cam.offsetY,
	});

	await page.mouse.click(at(pos.x, pos.y).x, at(pos.x, pos.y).y);
	await expect.poll(() => call<string[]>("ppg.selectedIds()")).toContain("t");

	// Unpause: the sim RUNS (debug boots paused).
	await page.locator('[data-sim="pause"]').click();

	// Corner drag mid-run: the TL corner (px-20, py-20), anchored at BR
	// (px+20, py+20) — a pointer at TWICE the corner→anchor distance doubles
	// the factor (halfWidth 20 → 40).
	const tl = at(pos.x - 20, pos.y - 20);
	const far = at(pos.x - 60, pos.y - 60);
	await page.mouse.move(tl.x, tl.y);
	await page.mouse.down();
	await page.mouse.move(far.x, far.y, { steps: 4 });
	await page.mouse.up();
	const shape = await call<{
		kind: string;
		halfWidth: number;
		halfHeight: number;
	}>("ppg.bodyShape('t')");
	if (!shape || shape.kind !== "box") throw new Error("box shape missing");
	expect(shape.halfWidth).toBeCloseTo(40, 0);

	// No page errors while the sim ran through the handle drag.
	expect(errors).toEqual([]);
});
