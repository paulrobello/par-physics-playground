import { expect, test } from "@playwright/test";

/**
 * P2-T5 e2e: snapshot undo/redo. Draw box → draw circle → undo (circle gone,
 * box present) → redo (circle back); undo after delete restores the body; 60
 * rapid draws stay within the bounded stack (undo depth caps at 49 undoable
 * steps, body counts assert no leak); rebuild of 50 boxes is measured.
 */
test("undo/redo restores draws, deletes, and stays bounded", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = (await stage.boundingBox())!;
	const pagePos = async (wx: number, wy: number) => {
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
	const drawBox = async (cx: number, cy: number, r = 8): Promise<void> => {
		const a = await pagePos(cx - r, cy - r);
		const b = await pagePos(cx + r, cy + r);
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move(b.x, b.y, { steps: 2 });
		await page.mouse.up();
	};

	// Box tool: one box.
	await page.keyboard.press("b");
	await drawBox(200, -300);
	// Circle tool: one circle.
	await page.keyboard.press("c");
	await drawCircle(page, pagePos, 400, -300);

	const two = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { ids: ppg.bodyIds(), depth: ppg.undoDepth() };
	});
	expect(two.ids).toHaveLength(2);
	expect(two.depth.undo).toBe(2);

	// Undo: circle gone, box present. Redo: circle back.
	await page.keyboard.press("Control+z");
	const afterUndo = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { n: ppg.bodyIds().length, depth: ppg.undoDepth() };
	});
	expect(afterUndo.n).toBe(1);
	expect(afterUndo.depth.redo).toBe(1);
	await page.keyboard.press("Control+Shift+z");
	const afterRedo = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyIds().length;
	});
	expect(afterRedo).toBe(2);

	// Delete then undo restores the body (shape is preserved).
	await page.keyboard.press("v");
	const circleSpot = await pagePos(400, -300);
	await page.mouse.click(circleSpot.x, circleSpot.y);
	await page.keyboard.press("Delete");
	const afterDelete = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyIds().length;
	});
	expect(afterDelete).toBe(1);
	await page.keyboard.press("Control+z");
	const restored = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const id = ppg.bodyIds().find((i) => i !== "body-1") ?? "";
		const shape = ppg.bodyShape(id);
		return { n: ppg.bodyIds().length, kind: shape?.kind };
	});
	expect(restored.n).toBe(2);
	expect(restored.kind).toBe("circle");

	// --- Label edit defers to undo shortcuts ----------------------------------
	// While an inline label edit is open, Cmd/Ctrl+Z must neither undo the
	// history nor commit-then-undo the label (and must not type the letter).
	// The edit continues and Enter commits the full text.
	await page.keyboard.press("t");
	const labelSpot = await pagePos(150, -150);
	await page.mouse.click(labelSpot.x, labelSpot.y);
	await page.keyboard.type("R");
	const depthBeforeZ = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.undoDepth();
	});
	await page.keyboard.press("Control+z");
	const afterZ = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { depth: ppg.undoDepth(), labels: ppg.labelIds().length };
	});
	expect(afterZ.depth).toEqual(depthBeforeZ); // no undo happened
	expect(afterZ.labels).toBe(1); // label not committed+undone
	const labelStill = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.label(ppg.labelIds()[0] as string);
	});
	expect(labelStill?.text).toBe(""); // still editing, nothing committed
	await page.keyboard.type("amp A");
	await page.keyboard.press("Enter");
	const labelDone = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			info: ppg.label(ppg.labelIds()[0] as string),
			depth: ppg.undoDepth(),
		};
	});
	expect(labelDone.info?.text).toBe("Ramp A"); // Enter still commits
	expect(labelDone.depth.undo).toBe(depthBeforeZ.undo + 1); // label commit recorded

	// --- Bounded stack: 60 rapid draws ---------------------------------------
	await page.keyboard.press("b");
	for (let i = 0; i < 60; i++) {
		await drawBox(600 + (i % 10) * 25, -420 - Math.floor(i / 10) * 25, 6);
	}
	const burst = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { n: ppg.bodyIds().length, depth: ppg.undoDepth() };
	});
	// 2 original + 60 new = 62 bodies; the undo history capped at 50 states
	// = 49 undoable steps (the seed state plus 49 post-action states).
	expect(burst.n).toBe(62);
	expect(burst.depth.undo).toBe(49);

	// Undo everything available: 49 undos land on the state after the 12th
	// draw of the burst (62 - 49 - ... seed accounting: 13 bodies remain).
	let undoCount = 0;
	for (;;) {
		const more = await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.undo();
		});
		if (!more) break;
		undoCount++;
	}
	expect(undoCount).toBe(49);
	const drained = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { n: ppg.bodyIds().length, depth: ppg.undoDepth() };
	});
	// The drained state keeps 13 bodies (the 2 originals + 11 burst draws);
	// the label in the history is not a body.
	expect(drained.n).toBe(13);
	expect(drained.depth.undo).toBe(0);
	expect(drained.depth.redo).toBe(49);

	// Redo everything: all 62 bodies back.
	let redoCount = 0;
	for (;;) {
		const more = await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.redo();
		});
		if (!more) break;
		redoCount++;
	}
	const full = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyIds().length;
	});
	expect(full).toBe(62);

	// --- Rebuild timing: one undo with 62 bodies, 50 deep --------------------
	const timing = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const t0 = performance.now();
		const ok = ppg.undo();
		return { ok, ms: performance.now() - t0 };
	});
	expect(timing.ok).toBe(true);
	// Sanity bound only — the measured number goes in the task report.
	expect(timing.ms).toBeLessThan(500);
	console.info(`undo rebuild of 61 entities: ${timing.ms.toFixed(2)} ms`);
});

/** Draw a circle with the circle tool (drag from center outward). */
async function drawCircle(
	page: import("@playwright/test").Page,
	pagePos: (wx: number, wy: number) => Promise<{ x: number; y: number }>,
	cx: number,
	cy: number,
): Promise<void> {
	const a = await pagePos(cx - 10, cy - 10);
	const b = await pagePos(cx + 10, cy + 10);
	await page.mouse.move(a.x, a.y);
	await page.mouse.down();
	await page.mouse.move(b.x, b.y, { steps: 2 });
	await page.mouse.up();
}
