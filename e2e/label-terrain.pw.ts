import { expect, test } from "@playwright/test";

/**
 * P2-T4 e2e: terrain painting and labels. Static mode (S) + line tool draws
 * an angled beam ramp; a dropped box is deflected by it (slides down-slope to
 * a position a pass-through fall could never reach). The text tool (T) places
 * a label; the label keeps its world anchor across a zoom change (verified
 * through the screen<->world probes), then is picked and deleted.
 */
test("static ramp deflects a dropped box; label is world-anchored across zoom", async ({
	page,
}) => {
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

	// --- Terrain: static-mode ramp via the line tool -----------------------
	await page.keyboard.press("s");
	expect(
		await page.locator('[data-mode="static"]').getAttribute("aria-pressed"),
	).toBe("true");
	await page.keyboard.press("l");
	const rampStart = await pagePos(500, -350);
	const rampEnd = await pagePos(700, -180);
	await page.mouse.move(rampStart.x, rampStart.y);
	await page.mouse.down();
	await page.mouse.move(rampEnd.x, rampEnd.y, { steps: 4 });
	await page.mouse.up();

	// The ramp exists, is static, and is an angled box (rot > 0).
	const ramp = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const ids = ppg.bodyIds();
		return {
			ids,
			isStatic: ids[0] ? ppg.bodyIsStatic(ids[0]) : undefined,
			shape: ids[0] ? ppg.bodyShape(ids[0]) : undefined,
			rot: ids[0] ? ppg.bodyRot(ids[0]) : undefined,
		};
	});
	expect(ramp.ids).toHaveLength(1);
	expect(ramp.isStatic).toBe(true);
	expect(ramp.shape?.kind).toBe("box");
	expect((ramp.rot ?? 0) > 0.3).toBe(true); // atan2(170, 200) ≈ 0.705

	// --- Deflection: a box dropped on the ramp slides, never passes through -
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("box1", 530, -400, 5, 5);
	});
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(8000);
	});
	const box = await page.evaluate((rampId) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			p: ppg.bodyPosition("box1"),
			ids: ppg.bodyIds(),
			rampPos: rampId ? ppg.bodyPosition(rampId) : undefined,
			rampRot: rampId ? ppg.bodyRot(rampId) : undefined,
		};
	}, ramp.ids[0]);
	if (!box.p) throw new Error("dropped box culled");
	// The ramp did not move (infinite mass).
	expect(box.rampPos?.y).toBeCloseTo(-265, 0);
	expect(box.rampRot ?? 0).toBeGreaterThan(0.3);
	// Deflection: a straight fall would land near x = 530 on the ground
	// (y ≈ -5); instead the box slid down-slope and came to rest ON the ramp,
	// high above the ground — deflected, never passed through.
	expect(box.p.x).toBeGreaterThan(530);
	expect(box.p.y).toBeLessThan(-200);

	await page.keyboard.press("s"); // static mode back off for the label part
	expect(
		await page.locator('[data-mode="static"]').getAttribute("aria-pressed"),
	).toBe("false");

	// --- Label: place, type, commit -----------------------------------------
	await page.keyboard.press("t");
	expect(
		await page.locator('[data-tool="text"]').getAttribute("aria-pressed"),
	).toBe("true");
	const labelPos = await pagePos(150, -120);
	await page.mouse.click(labelPos.x, labelPos.y);
	await page.keyboard.type("Ramp A");
	await page.keyboard.press("Enter");

	const label = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const ids = ppg.labelIds();
		return {
			ids,
			info: ids[0] ? ppg.label(ids[0]) : undefined,
		};
	});
	expect(label.ids).toHaveLength(1);
	expect(label.info?.text).toBe("Ramp A");
	expect(label.info?.x).toBeCloseTo(150, 3);
	expect(label.info?.y).toBeCloseTo(-120, 3);

	// --- World anchoring survives pan/zoom ----------------------------------
	// Zoom in via the mouse wheel, anchored AT the label (camera-controls
	// zooms at the cursor, so the label stays on screen), then verify the
	// label's world position and the screen<->world probes still agree.
	const camBefore = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	const labelScreen = await pagePos(150, -120);
	await page.mouse.move(labelScreen.x, labelScreen.y);
	await page.mouse.wheel(0, -600);
	const camAfter = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.cameraState();
	});
	expect(camAfter.zoom).toBeGreaterThan(camBefore.zoom);

	// The label's world position is untouched by the camera (world-anchored).
	const labelAfter = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.label(ppg.labelIds()[0] as string);
	});
	expect(labelAfter?.x).toBeCloseTo(150, 6);
	expect(labelAfter?.y).toBeCloseTo(-120, 6);
	// And the screen<->world probes agree at the new zoom: the screen point
	// the label now occupies maps back to the label's world anchor.
	const lw = {
		x: labelAfter ? labelAfter.x : 0,
		y: labelAfter ? labelAfter.y : 0,
	};
	const probe = await page.evaluate(
		({ lw, cam }) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			const sx = lw.x * cam.zoom + cam.offsetX;
			const sy = lw.y * cam.zoom + cam.offsetY;
			return ppg.screenToWorld(sx, sy);
		},
		{ lw, cam: camAfter },
	);
	expect(probe.x).toBeCloseTo(150, 3);
	expect(probe.y).toBeCloseTo(-120, 3);

	// --- Label pick + delete --------------------------------------------------
	// Pick near the FAR END of the drawn glyphs: the point is inside the
	// effective (zoom-matched) hit box but beyond the unclamped base-size
	// bounds the pre-fix picker used, so this exercises the shared font-size
	// computation, not just the anchor.
	await page.keyboard.press("v");
	const cam = camAfter;
	const labelSize = Math.min(Math.max(1.5, 10 / cam.zoom), 48 / cam.zoom);
	const labelWidth = "Ramp A".length * 0.6 * labelSize;
	const pickPos = await pagePos(150 + labelWidth - 0.5, -120 - labelSize * 0.4);
	await page.mouse.click(pickPos.x, pickPos.y);
	await page.keyboard.press("Delete");
	const afterDelete = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { labels: ppg.labelIds(), selected: ppg.selectedIds() };
	});
	expect(afterDelete.labels).toHaveLength(0);
});
