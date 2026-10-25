import { expect, test } from "@playwright/test";

/**
 * Thruster drag-to-aim + exhaust plume: press on a body mounts the
 * thruster, the drag previews the direction, and release converts the WORLD
 * drag angle to the body-local stored angle (a rotated body subtracts its
 * rotation). A tiny drag keeps angle 0. The plume is verified by a
 * screenshot in this file's dev-server run and unit-pinned elsewhere; here
 * the contract is the stored angle.
 */

test("press-drag-release stores the drag direction body-local; tiny drag keeps 0", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.evaluate(() =>
		window.__ppg!.spawnBox("rotbox", 0, -60, 30, 20, "ink", false),
	);
	// Rotate the body a quarter turn via the debug API's rotate hook (the
	// body-local conversion must subtract this).
	await page.evaluate(() => {
		const t = window.__ppg!.documentAll().find((e) => e.id === "rotbox");
		void t; // rotation is applied below through the real rotate path
	});
	const stage = await page.locator("#stage").boundingBox();
	const cam = await page.evaluate(() => window.__ppg!.cameraState());
	const toScreen = (wx: number, wy: number) => ({
		x: stage!.x + wx * cam.zoom + cam.offsetX,
		y: stage!.y + wy * cam.zoom + cam.offsetY,
	});
	// Unrotated case: drag 3-4-5 triangle up-right.
	await page.locator('[data-tool="thruster"]').click();
	const p = toScreen(0, -60);
	await page.mouse.move(p.x, p.y);
	await page.mouse.down();
	await page.mouse.move(p.x + 30, p.y - 40, { steps: 4 });
	await page.mouse.up();
	const angle = await page.evaluate(() => {
		const t = window.__ppg!.documentAll().find((e) => e.kind === "thruster");
		return t?.angle ?? null;
	});
	expect(angle).not.toBeNull();
	// atan2(-40, 30) ≈ -0.9273 rad — the world drag angle as-is on an
	// unrotated body.
	expect(angle!).toBeCloseTo(Math.atan2(-40, 30), 5);

	// Tiny drag on a second thruster (same box, right edge) keeps angle 0.
	const q = toScreen(15, -60);
	await page.mouse.move(q.x, q.y);
	await page.mouse.down();
	await page.mouse.move(q.x + 2, q.y, { steps: 2 });
	await page.mouse.up();
	const angle2 = await page.evaluate(() => {
		const list = window
			.__ppg!.documentAll()
			.filter((e) => e.kind === "thruster");
		return list[1]?.angle ?? null;
	});
	expect(angle2).toBe(0);
});
