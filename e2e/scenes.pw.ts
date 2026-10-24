import { writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

/**
 * Scene persistence e2e (P5-T1/T2, local-only per D14): named scenes in
 * IndexedDB survive a reload and round-trip the whole document (bodies,
 * custom material, joint, thruster); the autosave restores the working
 * scene on boot; JSON export→import reproduces the scene; a malformed
 * import is refused VISIBLY and leaves the world untouched.
 */

async function buildRichScene(page: import("@playwright/test").Page) {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		ppg.spawnBox("sc-box", 0, -10, 6, 3, "wood", false);
		ppg.spawnCircle("sc-ball", 14, -40, 4, false, "ice");
		// Custom material on the box (P3-T2 customs live in the document).
		ppg.addCustomMaterial({
			id: "sc-lead",
			name: "Scene Lead",
			color: "#556677",
			density: 7,
			friction: 0.4,
			restitution: 0,
		});
		ppg.setBodyMaterial("sc-box", "sc-lead");
		// A joint and a thruster complete the entity-kind coverage.
		ppg.placeJoint("sc-pin", "pin", "sc-box", null, 0, -10, 0, -10);
		ppg.placeThruster("sc-thruster", "sc-box", 6, -10, 0, 2500, true);
	});
}

test("named scene saves, survives reload, loads, deletes; autosave restores boot", async ({
	page,
}) => {
	await buildRichScene(page);
	const before = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			ids: [...ppg.documentAll().map((e) => e.id)].sort(),
			thrusters: ppg.thrusterIds().length,
			customs: ppg.customMaterials().map((m) => m.name),
		};
	});

	// Save through the real menu.
	await page.click('[data-scenes="open"]');
	await page.fill('[data-scenes="save-name"]', "rich machine");
	await page.click('[data-scenes="save"]');
	await expect(page.locator("#ppg-notice")).toContainText("rich machine");

	// Extra edit after the save, through the REAL tool path (debug spawns
	// skip the undo boundary, and the autosave rides on it): only the
	// AUTOSAVE should carry this box.
	await page.keyboard.press("b");
	await page.mouse.move(400, 300);
	await page.mouse.down();
	await page.mouse.move(460, 360);
	await page.mouse.up();
	await page.waitForTimeout(900); // debounce window

	// Reload: boot restores the autosaved working scene (first-run marker
	// was set on the first goto), including the late box.
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);
	const bootState = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return { ids: [...ppg.documentAll().map((e) => e.id)] };
	});
	// The tool-drawn box carries a minted body-N id (fresh counter per page).
	expect(bootState.ids).toContain("body-1");

	// The named scene (WITHOUT the late box) still exists and loads whole.
	await page.click('[data-scenes="open"]');
	await expect(page.locator('[data-scene-load="rich machine"]')).toBeVisible();
	await page.click('[data-scene-load="rich machine"]');
	// The load is async (IndexedDB read → restore); the notice gates it.
	await expect(page.locator("#ppg-notice")).toContainText("Loaded");
	const loaded = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return {
			ids: [...ppg.documentAll().map((e) => e.id)].sort(),
			thrusters: ppg.thrusterIds().length,
			customs: ppg.customMaterials().map((m) => m.name),
		};
	});
	expect(loaded.ids).toEqual(before.ids);
	expect(loaded.thrusters).toBe(before.thrusters);
	expect(loaded.customs).toEqual(before.customs);
	expect(loaded.ids).not.toContain("body-1");

	// The sim resumes from the restored scene: the ball (spawned at y=-40)
	// has fallen under gravity — 1.5 s of free fall covers ≥ 10 units.
	await page.evaluate(() => window.__ppg?.advanceTime(1_500));
	const fell = await page.evaluate(() => window.__ppg?.bodyPosition("sc-ball"));
	expect(fell?.y ?? -40).toBeGreaterThan(-32);

	// Delete: the list empties of the scene.
	await page.click('[data-scenes="open"]');
	await page.click('[data-scene-del="rich machine"]');
	await page.click('[data-scenes="open"]');
	await expect(page.locator('[data-scene-load="rich machine"]')).toHaveCount(0);
});

test("JSON export and import round-trip; malformed import refuses visibly", async ({
	page,
}) => {
	await buildRichScene(page);
	const before = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return [...ppg.documentAll().map((e) => e.id)].sort();
	});

	// Export via the real menu; Playwright captures the download.
	await page.click('[data-scenes="open"]');
	const download = page.waitForEvent("download");
	await page.click('[data-scenes="export"]');
	const saved = await download;
	const path = await saved.path();
	if (!path) throw new Error("download produced no file");

	// Wipe, then import the exported file back in.
	await page.click('[data-sim="new-world"]');
	let count = await page.evaluate(
		() => window.__ppg?.documentAll().length ?? -1,
	);
	expect(count).toBe(0);

	await page.setInputFiles('[data-scenes="import"]', path);
	// setInputFiles resolves on the change event, not the async handler.
	await expect(page.locator("#ppg-notice")).toContainText("Imported");
	const after = await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		return [...ppg.documentAll().map((e) => e.id)].sort();
	});
	expect(after).toEqual(before);

	// Malformed import: visible refusal, world untouched.
	const bad = "/tmp/ppg-malformed-scene.json";
	writeFileSync(
		bad,
		JSON.stringify({ schemaVersion: 1, entities: "nonsense" }),
	);
	await page.click('[data-sim="new-world"]');
	await page.setInputFiles('[data-scenes="import"]', bad);
	await expect(page.locator("#ppg-notice")).toContainText("refused");
	count = await page.evaluate(() => window.__ppg?.documentAll().length ?? -1);
	expect(count).toBe(0);
});
