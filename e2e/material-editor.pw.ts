import { expect, test } from "@playwright/test";

/**
 * P3-T2 custom material editor e2e (debug mode: real-time feed paused,
 * `advanceTime` drives the sim). Creates a lead-like custom material through
 * the panel UI, asserts new spawns and an apply-to-selection repaint take it,
 * that a lead ball knocks an ink target much farther than an identical wood
 * ball (density reaches Rapier's mass), that ONE undo reverts the whole
 * apply, and that a reload restores the custom list from IndexedDB.
 */
test("lead custom: density physics, apply undo, reload restore", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");
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

	// Create the custom material through the editor form.
	await page.click("[data-mat-new]");
	await page.fill("[data-mat-name]", "Lead");
	await page.fill("[data-mat-color]", "#6f7d8c");
	await page.fill("[data-mat-density]", "11.3");
	await page.fill("[data-mat-friction]", "0.5");
	await page.fill("[data-mat-restitution]", "0.2");
	expect(await page.textContent("[data-mat-density-out]")).toBe("11.3");
	expect(await page.textContent("[data-mat-friction-out]")).toBe("0.50");
	expect(await page.textContent("[data-mat-restitution-out]")).toBe("0.20");
	await page.click("[data-mat-save]");

	const created = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			mats: ppg.materials(),
			active: ppg.activeMaterialId(),
		};
	});
	const lead = created.mats.find((m) => m.id === "custom-1");
	expect(lead?.name).toBe("Lead");
	expect(lead?.density).toBeCloseTo(11.3);
	// A fresh custom becomes the active material (D20 flow).
	expect(created.active).toBe("custom-1");
	await expect(page.locator('[data-mat-id="custom-1"]')).toHaveText(/Lead/);

	// Density physics: identical balls over identical ink targets, only the
	// ball material differs. Momentum transfer: the lead ball sends its target
	// much farther than the wood ball.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("targetA", 200, -10, 4, 4, "ink");
		ppg.spawnBox("targetB", 400, -10, 4, 4, "ink");
		ppg.spawnCircle("ballA", 196, -60, 6, false, "custom-1");
		ppg.spawnCircle("ballB", 396, -60, 6, false, "wood");
	});
	const masses = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			lead: ppg.bodyMass("ballA"),
			wood: ppg.bodyMass("ballB"),
		};
	});
	// mass = density x area (same area): 11.3 / 0.25 = 45.2x.
	expect(masses.lead ?? 0).toBeCloseTo((masses.wood ?? 0) * 45.2, 0);

	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.advanceTime(5000);
	});
	const travel = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const xa = ppg.bodyPosition("targetA");
		const xb = ppg.bodyPosition("targetB");
		if (!xa || !xb) throw new Error("targets culled");
		return { a: Math.abs(xa.x - 200), b: Math.abs(xb.x - 400) };
	});
	expect(
		travel.a,
		`lead target travel=${travel.a} wood target travel=${travel.b}`,
	).toBeGreaterThan(travel.b * 3);
	expect(travel.a).toBeGreaterThan(5);

	// Apply-to-selection repaints an existing body; ONE undoable action.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("pad", 600, -10, 4, 4, "ink", true);
	});
	// Switch the active material to wood by clicking the palette row.
	await page.click('[data-mat-id="wood"]');
	expect(
		await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.activeMaterialId();
		}),
	).toBe("wood");

	await page.keyboard.press("v");
	const padSpot = await pagePos(600, -10);
	await page.mouse.click(padSpot.x, padSpot.y);
	const depthBefore = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.undoDepth().undo;
	});
	await page.click("[data-mat-apply]");
	const applied = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			mat: ppg.bodyMaterial("pad")?.id,
			depth: ppg.undoDepth(),
		};
	});
	expect(applied.mat).toBe("wood");
	// Exactly one undoable action for the whole invocation.
	expect(applied.depth.undo).toBe(depthBefore + 1);

	// Undo reverts the paint; redo restores it.
	await page.keyboard.press("Control+z");
	expect(
		await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.bodyMaterial("pad")?.id;
		}),
	).toBe("ink");
	await page.keyboard.press("Control+Shift+z");
	expect(
		await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.bodyMaterial("pad")?.id;
		}),
	).toBe("wood");

	// Reload: the custom list is restored from IndexedDB (same browser context).
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);
	// The debug API installs BEFORE store.load() completes, so an immediate
	// registry/DOM evaluation races init (fix-wave F6): wait on the restored
	// material row (rendered only after the registry merge) with a retrying
	// locator assertion.
	await expect(page.locator('[data-mat-id="custom-1"]')).toHaveText(/Lead/, {
		timeout: 5_000,
	});
	const restored = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			lead: ppg.materials().find((m) => m.id === "custom-1"),
			row: !!document.querySelector('[data-mat-id="custom-1"]'),
		};
	});
	expect(restored.lead?.name).toBe("Lead");
	expect(restored.lead?.density).toBeCloseTo(11.3);
	expect(restored.row).toBe(true);
});

test("material apply retains selection through apply and edit", async ({
	page,
}) => {
	// Fix-wave F1: applying or editing a material must not behave like a
	// delete — the body's Rapier identity is preserved, so the tool session's
	// selection survives both paths.
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Create a custom material and two bodies, then select both.
	await page.click("[data-mat-new]");
	await page.fill("[data-mat-name]", "Lead");
	await page.fill("[data-mat-density]", "11.3");
	await page.click("[data-mat-save]");
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("a", 200, -10, 4, 4, "ink");
		ppg.spawnBox("b", 240, -10, 4, 4, "ink");
	});
	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");
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
	await page.keyboard.press("v");
	const pa = await pagePos(200, -10);
	const pb = await pagePos(240, -10);
	await page.mouse.click(pa.x, pa.y);
	await page.keyboard.down("Shift");
	await page.mouse.click(pb.x, pb.y);
	await page.keyboard.up("Shift");
	expect(await selectedIds(page)).toEqual(["a", "b"]);

	// Apply-to-selection: physics takes the custom, selection is retained.
	await page.click("[data-mat-apply]");
	let applied = await bodyMaterials(page, ["a", "b"]);
	expect(applied).toEqual(["custom-1", "custom-1"]);
	expect(await selectedIds(page)).toEqual(["a", "b"]);

	// Editing the open material (re-materializes its bodies) also retains it.
	await page.click('[data-mat-edit="custom-1"]');
	await page.fill("[data-mat-density]", "19");
	await page.click("[data-mat-save]");
	applied = await bodyMaterials(page, ["a", "b"]);
	expect(applied).toEqual(["custom-1", "custom-1"]);
	expect(await selectedIds(page)).toEqual(["a", "b"]);
	expect((await bodyMass(page, "a")) ?? 0).toBeCloseTo(19 * 64, 5);
});

test("delete while editing closes the editor; the deleted material never resurrects", async ({
	page,
}) => {
	// Fix-wave F2: New → Create → Edit → Delete → Save → Reload. Deleting the
	// custom being edited closes the editor, so its Save cannot persist the
	// removed id — after a reload the deleted material stays gone.
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.click("[data-mat-new]");
	await page.fill("[data-mat-name]", "Lead");
	await page.fill("[data-mat-density]", "11.3");
	await page.click("[data-mat-save]");
	await expect(page.locator('[data-mat-id="custom-1"]')).toHaveText(/Lead/);

	// Open the editor for it, then delete it while the editor is open.
	await page.click('[data-mat-edit="custom-1"]');
	await expect(page.locator("[data-mat-editor]")).toBeVisible();
	await page.click('[data-mat-delete="custom-1"]');
	// The editor invalidates with the deleted material...
	await expect(page.locator("[data-mat-editor]")).toBeHidden();

	// Wait for the delete to COMMIT in IndexedDB before reloading — a reload
	// mid-transaction would abort it and resurrect the material spuriously.
	await page.waitForFunction(
		() =>
			new Promise<boolean>((resolve) => {
				const req = indexedDB.open("par-physics-playground", 1);
				req.onsuccess = () => {
					const db = req.result;
					const getAll = db
						.transaction("custom-materials", "readonly")
						.objectStore("custom-materials")
						.getAll();
					getAll.onsuccess = () => {
						db.close();
						resolve(
							!getAll.result.some(
								(r) => (r as { id: string }).id === "custom-1",
							),
						);
					};
				};
				req.onerror = () => resolve(false);
			}),
		{ timeout: 5_000 },
	);

	// ...so reload must NOT resurrect the deleted custom.
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);
	await expect(page.locator('[data-mat-id="custom-1"]')).toHaveCount(0);
	const ids = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.materials().map((m) => m.id);
	});
	expect(ids).not.toContain("custom-1");
});

test("custom ids are never reused, so undo history stays isolated", async ({
	page,
}) => {
	// Fix-wave F3: delete custom-1 then create a new custom — the fresh id
	// must be custom-2, because undo snapshots holding materialId custom-1
	// would otherwise silently resolve to the NEW material's values.
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Custom A (heavy), applied to a body via ONE undoable apply action.
	await page.click("[data-mat-new]");
	await page.fill("[data-mat-name]", "Heavy");
	await page.fill("[data-mat-density]", "11.3");
	await page.click("[data-mat-save]");
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("hist", 200, -10, 4, 4, "ink");
	});
	const stage = page.locator("#stage");
	const stageBox = await stage.boundingBox();
	if (!stageBox) throw new Error("stage canvas not visible");
	const selectBody = async (wx: number, wy: number) => {
		const cam = await page.evaluate(() => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("debug api missing");
			return ppg.cameraState();
		});
		await page.mouse.click(
			stageBox.x + wx * cam.zoom + cam.offsetX,
			stageBox.y + wy * cam.zoom + cam.offsetY,
		);
	};
	await page.keyboard.press("v");
	await selectBody(200, -10);
	await page.click("[data-mat-apply]");
	expect((await bodyMaterials(page, ["hist"]))[0]).toBe("custom-1");

	// Delete A, then create custom B with DIFFERENT values.
	await page.click('[data-mat-delete="custom-1"]');
	await page.click("[data-mat-new]");
	await page.fill("[data-mat-name]", "Light");
	await page.fill("[data-mat-density]", "0.4");
	await page.click("[data-mat-save]");
	// The new custom took a fresh id, NOT the deleted one's.
	expect(await page.evaluate(activeIdOf)).toBe("custom-2");
	expect((await bodyMaterials(page, ["hist"]))[0]).toBe("ink");

	// Undo the old apply: its snapshot references custom-1, which no longer
	// exists — the resolved material must be the ink fallback, never B.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.undo();
	});
	const resolved = await bodyMaterialOf(page, "hist");
	expect(resolved?.id).toBe("ink");
	expect(resolved?.density).not.toBeCloseTo(0.4);
});

/** Debug-API helpers shared by the fix-wave cluster. */
async function selectedIds(page: import("@playwright/test").Page) {
	return page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.selectedIds();
	});
}

async function bodyMaterials(
	page: import("@playwright/test").Page,
	ids: string[],
) {
	return Promise.all(
		ids.map((id) => bodyMaterialOf(page, id).then((m) => m?.id)),
	);
}

async function bodyMaterialOf(
	page: import("@playwright/test").Page,
	id: string,
) {
	return page.evaluate((bodyId) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyMaterial(bodyId);
	}, id);
}

async function bodyMass(page: import("@playwright/test").Page, id: string) {
	return page.evaluate((bodyId) => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return ppg.bodyMass(bodyId);
	}, id);
}

async function activeIdOf() {
	const ppg = window.__ppg;
	if (!ppg) throw new Error("debug api missing");
	return ppg.activeMaterialId();
}
