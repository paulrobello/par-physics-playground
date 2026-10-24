import { expect, type Page, test } from "@playwright/test";

async function setup(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (e) => errors.push(e.message));
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	const box = await page.locator("#stage").boundingBox();
	if (!box) throw new Error("stage missing");
	const cam = await page.evaluate(() => window.__ppg!.cameraState());
	const pos = (x: number, y: number) => ({
		x: box.x + x * cam.zoom + cam.offsetX,
		y: box.y + y * cam.zoom + cam.offsetY,
	});
	const click = async (x: number, y: number) => {
		const p = pos(x, y);
		await page.mouse.click(p.x, p.y);
	};
	const drag = async (ax: number, ay: number, bx: number, by: number) => {
		const a = pos(ax, ay),
			b = pos(bx, by);
		await page.mouse.move(a.x, a.y);
		await page.mouse.down();
		await page.mouse.move(b.x, b.y, { steps: 3 });
		await page.mouse.up();
	};
	return { errors, pos, click, drag };
}

test("F7 F8 F10: text owns keyboard, re-edits once, and wins over terrain", async ({
	page,
}) => {
	const { errors, click, drag } = await setup(page);
	await page.keyboard.press("s");
	await page.keyboard.press("b");
	await drag(80, -220, 280, -140);
	await page.keyboard.press("t");
	await click(120, -180);
	const before = await page.evaluate(() => ({
		tick: window.__ppg!.tick(),
		cam: window.__ppg!.cameraState(),
	}));
	await page.keyboard.type("r p. space");
	expect(await page.evaluate(() => window.__ppg!.tick())).toBe(before.tick);
	await expect(page.locator('[data-sim="pause"]')).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.locator("#stage")).not.toHaveCSS("cursor", "grab");
	await page.keyboard.press("Enter");
	const id = await page.evaluate(() => window.__ppg!.labelIds()[0]!);
	expect(await page.evaluate((id) => window.__ppg!.label(id)?.text, id)).toBe(
		"r p. space",
	);
	await click(120, -180);
	await page.keyboard.type(" edited");
	await page.keyboard.press("Enter");
	expect(await page.evaluate(() => window.__ppg!.labelIds().length)).toBe(1);
	await page.keyboard.press("Control+z");
	expect(await page.evaluate((id) => window.__ppg!.label(id)?.text, id)).toBe(
		"r p. space",
	);
	await page.keyboard.press("Control+Shift+z");
	expect(await page.evaluate((id) => window.__ppg!.label(id)?.text, id)).toBe(
		"r p. space edited",
	);
	await page.keyboard.press("v");
	await click(120, -180);
	expect(await page.evaluate(() => window.__ppg!.selectedIds())).toEqual([id]);
	expect(await page.evaluate(() => window.__ppg!.cameraState())).toEqual(
		before.cam,
	);
	// R pressed during text entry must not remain armed as a rotate modifier.
	await page.keyboard.press("t");
	await click(120, -180);
	await page.keyboard.down("r");
	await page.keyboard.press("Enter");
	await page.keyboard.press("v");
	await drag(120, -180, 140, -160);
	expect(await page.evaluate((id) => window.__ppg!.label(id)?.rot, id)).toBe(0);
	expect(
		(await page.evaluate((id) => window.__ppg!.label(id), id))?.x,
	).toBeCloseTo(140, 0);
	await page.keyboard.up("r");
	expect(errors).toEqual([]);
});

test("F5 F6 F14: running terrain edit and drag-delete lifetime; Reset clears history", async ({
	page,
}) => {
	const { errors, click, drag, pos } = await setup(page);
	await page.keyboard.press("s");
	await page.keyboard.press("b");
	await drag(80, -220, 140, -180);
	const id = await page.evaluate(() => window.__ppg!.bodyIds()[0]!);
	await page.keyboard.press("v");
	await page.keyboard.press("p");
	await drag(110, -200, 170, -240);
	expect(
		(await page.evaluate((id) => window.__ppg!.bodyPosition(id), id))?.x,
	).toBeCloseTo(170, 0);
	await page.keyboard.down("r");
	await drag(170, -240, 170, -200);
	await page.keyboard.up("r");
	expect(
		Math.abs((await page.evaluate((id) => window.__ppg!.bodyRot(id), id))!),
	).toBeGreaterThan(0.3);
	await page.keyboard.press("Control+d");
	await page.keyboard.press("Delete");
	await page.keyboard.press("Control+z");
	expect(await page.evaluate(() => window.__ppg!.bodyIds().length)).toBe(2);
	await page.evaluate(() => {
		window.__ppg!.spawnBox("dynamic", 320, -240, 10, 10);
		window.__ppg!.spawnBox("next", 380, -240, 10, 10);
	});
	const p = pos(320, -240);
	await page.mouse.move(p.x, p.y);
	await page.mouse.down();
	await page.keyboard.press("Delete");
	await page.mouse.move(p.x + 30, p.y + 30);
	await page.mouse.up();
	expect(await page.evaluate(() => window.__ppg!.bodyIds())).not.toContain(
		"dynamic",
	);
	await click(380, -240);
	expect(await page.evaluate(() => window.__ppg!.selectedIds())).toEqual([
		"next",
	]);
	await page.locator('[data-sim="reset"]').click();
	expect(
		await page.evaluate(() => ({
			ids: window.__ppg!.bodyIds(),
			selected: window.__ppg!.selectedIds(),
			depth: window.__ppg!.undoDepth(),
		})),
	).toEqual({ ids: [], selected: [], depth: { undo: 0, redo: 0 } });
	expect(errors).toEqual([]);
});

test("F9: mixed rubber-band rotation and undo/redo", async ({ page }) => {
	const { errors, click, drag } = await setup(page);
	await page.keyboard.press("b");
	await drag(100, -240, 140, -200);
	await page.keyboard.press("t");
	await click(200, -220);
	await page.keyboard.type("tag");
	await page.keyboard.press("Enter");
	const ids = await page.evaluate(() => ({
		body: window.__ppg!.bodyIds()[0]!,
		label: window.__ppg!.labelIds()[0]!,
	}));
	await page.keyboard.press("v");
	await drag(70, -270, 250, -170);
	expect(
		(await page.evaluate(() => window.__ppg!.selectedIds())).sort(),
	).toEqual([ids.body, ids.label].sort());
	await page.keyboard.down("r");
	await drag(120, -220, 120, -180);
	await page.keyboard.up("r");
	const after = await page.evaluate(
		(ids) => ({
			b: window.__ppg!.bodyRot(ids.body),
			l: window.__ppg!.label(ids.label)?.rot,
		}),
		ids,
	);
	expect(after.b).toBeCloseTo(0.4);
	expect(after.l).toBeCloseTo(0.4);
	await page.keyboard.press("Control+z");
	expect(
		await page.evaluate((id) => window.__ppg!.label(id)?.rot, ids.label),
	).toBe(0);
	await page.keyboard.press("Control+Shift+z");
	expect(
		await page.evaluate((id) => window.__ppg!.label(id)?.rot, ids.label),
	).toBeCloseTo(0.4);
	expect(errors).toEqual([]);
});

test("F11: simulate-delete-undo and simulate-move-undo restore visible pre-action pose", async ({
	page,
}) => {
	const { errors, click, drag } = await setup(page);
	await page.keyboard.press("b");
	await drag(100, -300, 120, -280);
	const id = await page.evaluate(() => window.__ppg!.bodyIds()[0]!);
	await page.evaluate(() => window.__ppg!.advanceTime(2000));
	const before = await page.evaluate(
		(id) => window.__ppg!.bodyPosition(id)!,
		id,
	);
	expect(before.y).toBeGreaterThan(-285);
	await page.keyboard.press("v");
	await click(before.x, before.y);
	await page.keyboard.press("Delete");
	await page.keyboard.press("Control+z");
	expect(
		(await page.evaluate((id) => window.__ppg!.bodyPosition(id), id))?.y,
	).toBeCloseTo(before.y, 3);
	await page.evaluate(() => window.__ppg!.advanceTime(1000));
	const start = await page.evaluate(
		(id) => window.__ppg!.bodyPosition(id)!,
		id,
	);
	await drag(start.x, start.y, start.x + 60, start.y - 30);
	await page.keyboard.press("Control+z");
	const undone = await page.evaluate(
		(id) => window.__ppg!.bodyPosition(id)!,
		id,
	);
	expect(undone.x).toBeCloseTo(start.x, 3);
	expect(undone.y).toBeCloseTo(start.y, 3);
	await page.keyboard.press("Control+Shift+z");
	expect(
		(await page.evaluate((id) => window.__ppg!.bodyPosition(id), id))?.x,
	).toBeCloseTo(start.x + 60, 3);
	expect(errors).toEqual([]);
});

test("F12: self-intersecting pointer polygon warns without body or history", async ({
	page,
}) => {
	const { errors, click } = await setup(page);
	const warnings: string[] = [];
	page.on("console", (m) => {
		if (m.type() === "warning") warnings.push(m.text());
	});
	await page.keyboard.press("g");
	for (const [x, y] of [
		[100, -250],
		[200, -150],
		[100, -150],
		[200, -250],
	])
		await click(x!, y!);
	await page.keyboard.press("Enter");
	expect(await page.evaluate(() => window.__ppg!.bodyIds())).toEqual([]);
	expect(await page.evaluate(() => window.__ppg!.undoDepth().undo)).toBe(0);
	expect(warnings.some((s) => s.includes("Polygon rejected"))).toBe(true);
	expect(errors).toEqual([]);
});
