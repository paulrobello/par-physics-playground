import { expect, test } from "@playwright/test";

/**
 * Fixed-pulley e2e (post-MVP, local-only per D14): the REAL tool radio's
 * three-click flow (body A → body B → wheel anywhere) places a pulley that
 * exchanges weights under the sim (the heavy side falls, the light side
 * rises along its rope leg). Also covers the cancel/abort behavior of the
 * third click, the wheel glyph as its own pick target, the read-only panel
 * section, the endpoint-delete cascade, and autosave persistence.
 */
test("pulley: three-click placement exchanges weights; abort, delete, panel, autosave", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// A heavy box and a light box at the same height; the wheel click goes
	// between and above them. Screen position = stage origin + world·zoom +
	// camera offset (the joints.pw.ts convention).
	const stage = await page.locator("#stage").boundingBox();
	if (!stage) throw new Error("stage missing");
	const cam = await page.evaluate(() => window.__ppg?.cameraState());
	if (!cam) throw new Error("camera missing");
	const toScreen = (wx: number, wy: number) => ({
		x: stage.x + wx * cam.zoom + cam.offsetX,
		y: stage.y + wy * cam.zoom + cam.offsetY,
	});

	await page.evaluate(() => {
		const ppg = window.__ppg;
		ppg?.spawnBox("pa", 140, -140, 40, 40);
		ppg?.spawnBox("pb", 420, -140, 10, 10);
	});

	// --- Abort paths of the three-click flow place nothing.
	await page.click('[data-tool="joint"]');
	await page.click('[data-joint-kind="pulley"]');
	// Second click on empty space aborts (a pulley needs two bodies).
	await page.mouse.click(toScreen(140, -140).x, toScreen(140, -140).y);
	await page.mouse.click(toScreen(280, -40).x, toScreen(280, -40).y);
	// Second click on bodyA again aborts.
	await page.mouse.click(toScreen(140, -140).x, toScreen(140, -140).y);
	await page.mouse.click(toScreen(140, -140).x, toScreen(140, -140).y);
	// Escape during the wheel phase cancels.
	await page.mouse.click(toScreen(140, -140).x, toScreen(140, -140).y);
	await page.mouse.click(toScreen(420, -140).x, toScreen(420, -140).y);
	await page.keyboard.press("Escape");
	expect(await page.evaluate(() => window.__ppg?.jointIds().length ?? -1)).toBe(
		0,
	);

	// --- The real three-click flow places the pulley and auto-selects it.
	await page.mouse.click(toScreen(140, -140).x, toScreen(140, -140).y);
	await page.mouse.click(toScreen(420, -140).x, toScreen(420, -140).y);
	// Third click anywhere (the wheel is a scene point, not a body pick):
	// deliberately over empty space far above.
	await page.mouse.click(toScreen(280, -340).x, toScreen(280, -340).y);
	const placed = await page.evaluate(() => ({
		joints: window.__ppg?.jointIds() ?? [],
		joint: window.__ppg?.joint("joint-1"),
		selected: window.__ppg?.selectedIds() ?? [],
	}));
	expect(placed.joints).toEqual(["joint-1"]);
	expect(placed.joint?.jointType).toBe("pulley");
	expect(placed.joint?.params).toEqual({
		kind: "pulley",
		wheelX: 280,
		wheelY: -340,
		length: 2 * Math.hypot(140, 200),
	});
	expect(placed.selected).toEqual(["joint-1"]);
	await expect(page.locator(".joint-panel")).toBeVisible();
	await expect(page.locator(".joint-panel")).toContainText("Pulley");
	// Read-only params: length and wheel are displayed, never editable.
	await expect(page.locator(".joint-panel")).toContainText("Rope length:");
	await expect(
		page.locator(".joint-panel [data-joint-params] input"),
	).toHaveCount(0);

	// --- The sim exchanges: the heavy side falls, the light side rises.
	await page.evaluate(() => window.__ppg?.advanceTime(2500));
	const moved = await page.evaluate(() => ({
		a: window.__ppg?.bodyPosition("pa"),
		b: window.__ppg?.bodyPosition("pb"),
	}));
	expect(moved.a?.y ?? Number.NaN).toBeGreaterThan(-135); // heavy fell
	expect(moved.b?.y ?? Number.NaN).toBeLessThan(-145); // light rose

	// --- The wheel glyph is its own pick target: a select-tool press on the
	// wheel selects the pulley, and the toolbar delete removes it (the
	// keyboard Delete is kept by the focused tool radio — buttons are the
	// reliable UI path here).
	await page.click('[data-tool="select"]');
	const wheel = toScreen(280, -340);
	await page.mouse.click(wheel.x, wheel.y);
	expect(await page.evaluate(() => window.__ppg?.selectedIds() ?? [])).toEqual([
		"joint-1",
	]);
	await page.click('[data-action="delete"]');
	await expect
		.poll(async () =>
			page.evaluate(() => window.__ppg?.jointIds().length ?? -1),
		)
		.toBe(0);

	// --- Undo brings the pulley back (the bodies-before-joints rebuild) and
	// the autosave persists the restored document across a reload.
	await page.click('[data-action="undo"]');
	await page.waitForTimeout(900); // the autosave debounce (500 ms)
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);
	const restored = await page.evaluate(() => ({
		joint: window.__ppg?.joint("joint-1"),
		params: window.__ppg?.joint("joint-1")?.params,
	}));
	expect(restored.joint?.jointType).toBe("pulley");
	expect(restored.params).toEqual({
		kind: "pulley",
		wheelX: 280,
		wheelY: -340,
		length: 2 * Math.hypot(140, 200),
	});
	// The restored rope still pulls: the heavy side sinks further.
	await page.evaluate(() => window.__ppg?.advanceTime(1500));
	const after = await page.evaluate(() => ({
		a: window.__ppg?.bodyPosition("pa"),
	}));
	expect(after.a?.y ?? Number.NaN).toBeGreaterThan(-135);

	// --- Deleting an ENDPOINT BODY cascades the pulley away (the card
	// criterion; the renderer draws joints from document entities, so the
	// entity check is the no-dangling-render proof). The body is picked at
	// its LIVE position — the sim has moved it.
	const lightWorld = await page.evaluate(() =>
		window.__ppg?.bodyPosition("pb"),
	);
	if (!lightWorld) throw new Error("light body missing");
	const lightScreen = toScreen(lightWorld.x, lightWorld.y);
	await page.mouse.click(lightScreen.x, lightScreen.y);
	await page.click('[data-action="delete"]');
	await expect
		.poll(async () =>
			page.evaluate(() => window.__ppg?.jointIds().length ?? -1),
		)
		.toBe(0);
	const cascade = await page.evaluate(() => ({
		joint: window.__ppg?.joint("joint-1"),
		lightGone: window.__ppg?.bodyIds().includes("pb"),
	}));
	expect(cascade.joint).toBeUndefined();
	expect(cascade.lightGone).toBe(false);
});
