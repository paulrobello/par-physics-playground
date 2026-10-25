import { expect, test } from "@playwright/test";

/**
 * Joint tool modes (Paul, 2026-10-25): Shift+click ties every body stacked
 * under the click, Snap-Join mode snaps the second body onto the first
 * before jointing at the shared center, and hovering a body shows its
 * center marker.
 */

const toScreen = (
	page: import("@playwright/test").Page,
	wx: number,
	wy: number,
): Promise<{ x: number; y: number }> =>
	page.evaluate(
		({ x, y }) => {
			const stage = document.querySelector("#stage")!.getBoundingClientRect();
			const cam = window.__ppg!.cameraState();
			return {
				x: stage.x + x * cam.zoom + cam.offsetX,
				y: stage.y + y * cam.zoom + cam.offsetY,
			};
		},
		{ x: wx, y: wy },
	);

test("Snap-Join: first click is the target, second body snaps to it, joint at the shared center", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("anchor", 100, -400, 25, 25, "wood", true);
		ppg.spawnCircle("bob", 300, -400, 15, false, "ink");
	});
	await page.locator('[data-tool="joint"]').click();
	await page.locator("[data-joint-snap-join] input").check();

	const anchorPt = await toScreen(page, 100, -400);
	const bobPt = await toScreen(page, 300, -400);
	await page.mouse.click(anchorPt.x, anchorPt.y);
	await page.mouse.click(bobPt.x, bobPt.y);

	const state = await page.evaluate(() => {
		const d = (
			a: { x: number; y: number },
			b: { x: number; y: number },
		): number => Math.hypot(a.x - b.x, a.y - b.y);
		const bob = window.__ppg!.bodyPosition("bob");
		const snapped = d(bob!, { x: 100, y: -400 });
		const joints = window.__ppg!.jointIds();
		const kind = joints
			.map((id) => window.__ppg!.joint(id)?.params.kind)
			.join(",");
		window.__ppg!.undo();
		const restored = d(window.__ppg!.bodyPosition("bob")!, {
			x: 300,
			y: -400,
		});
		const jointsAfterUndo = window.__ppg!.jointIds().length;
		return { snapped, kind, restored, jointsAfterUndo, count: joints.length };
	});
	expect(state.snapped).toBeLessThan(0.01);
	expect(state.count).toBe(1);
	expect(state.kind).toBe("pin");
	// One undo step rewinds move + joint together.
	expect(state.restored).toBeLessThan(0.01);
	expect(state.jointsAfterUndo).toBe(0);
});

test("Shift+click ties every body stacked under the click", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("under", 300, -400, 16, 16, "wood", false);
		ppg.spawnBox("mid", 300, -400, 12, 12, "ink", false);
		ppg.spawnBox("over", 300, -400, 8, 8, "steel", false);
	});
	await page.locator('[data-tool="joint"]').click();

	const pt = await toScreen(page, 300, -400);
	await page.keyboard.down("Shift");
	await page.mouse.click(pt.x, pt.y);
	await page.keyboard.up("Shift");

	const state = await page.evaluate(() => {
		const joints = window.__ppg!.jointIds();
		const kinds = joints.map((id) => window.__ppg!.joint(id)?.params.kind);
		window.__ppg!.undo();
		return {
			count: joints.length,
			kinds,
			after: window.__ppg!.jointIds().length,
		};
	});
	// Three stacked bodies -> two pins chaining them, one undo step.
	expect(state.count).toBe(2);
	expect(new Set(state.kinds)).toEqual(new Set(["pin"]));
	expect(state.after).toBe(0);
});

test("hovering a body shows its center marker", async ({ page }) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.waitForTimeout(300); // canvas/layout settle

	await page.evaluate(() => {
		window.__ppg!.spawnBox("solo", 0, -400, 30, 20, "wood", false);
	});
	const center = await toScreen(page, 0, -400);
	const sample = () =>
		page.evaluate(
			({ x, y }) => {
				const ctx = document
					.querySelector<HTMLCanvasElement>("#stage")!
					.getContext("2d")!;
				const cam = window.__ppg!.cameraState();
				const dpr = window.devicePixelRatio;
				const d = ctx.getImageData(
					Math.round((x * cam.zoom + cam.offsetX) * dpr),
					Math.round((y * cam.zoom + cam.offsetY) * dpr),
					1,
					1,
				).data;
				return [d[0]!, d[1]!, d[2]!];
			},
			{ x: 0, y: -400 },
		);

	// Pointer away from the body: the center shows plain fill.
	await page.mouse.move(center.x + 120, center.y);
	await page.waitForTimeout(120);
	const plain = await sample();
	// Hover the body: the crosshair marker draws at the center.
	await page.mouse.move(center.x, center.y);
	await page.waitForTimeout(120);
	const marked = await sample();
	const diff = Math.max(
		Math.abs(marked[0]! - plain[0]!),
		Math.abs(marked[1]! - plain[1]!),
		Math.abs(marked[2]! - plain[2]!),
	);
	expect(diff).toBeGreaterThan(12);
});

test("center marker tracks the hovered body during joint placement", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.waitForTimeout(300); // canvas/layout settle

	await page.evaluate(() => {
		const ppg = window.__ppg!;
		ppg.spawnBox("anchor", 100, -450, 25, 25, "wood", true);
		ppg.spawnBox("target", 400, -450, 25, 25, "wood", true);
	});
	await page.locator('[data-tool="joint"]').click();

	// First click arms the joint on the anchor; the flow phase is now
	// non-idle for everything that follows.
	const anchorPt = await toScreen(page, 100, -450);
	await page.mouse.click(anchorPt.x, anchorPt.y);

	const sampleAt = (wx: number, wy: number) =>
		page.evaluate(
			({ x, y }) => {
				const ctx = document
					.querySelector<HTMLCanvasElement>("#stage")!
					.getContext("2d")!;
				const cam = window.__ppg!.cameraState();
				const dpr = window.devicePixelRatio;
				const d = ctx.getImageData(
					Math.round((x * cam.zoom + cam.offsetX) * dpr),
					Math.round((y * cam.zoom + cam.offsetY) * dpr),
					1,
					1,
				).data;
				return [d[0]!, d[1]!, d[2]!];
			},
			{ x: wx, y: wy },
		);

	const targetPt = await toScreen(page, 400, -450);
	// Pointer parked on empty space: the target body's center shows plain fill.
	await page.mouse.move(targetPt.x + 120, targetPt.y + 150);
	await page.waitForTimeout(120);
	const plain = await sampleAt(400, -450);
	// Hover the second body while the joint is still armed: the crosshair
	// marker must track the pointer-picked body mid-flow. The hover lands
	// OFF-center (still inside the body) so the placement preview line ends
	// beside the sampled center — the pixel can only change via the marker.
	const hoverPt = await toScreen(page, 400, -430);
	await page.mouse.move(hoverPt.x, hoverPt.y);
	await page.waitForTimeout(120);
	const marked = await sampleAt(400, -450);
	const diff = Math.max(
		Math.abs(marked[0]! - plain[0]!),
		Math.abs(marked[1]! - plain[1]!),
		Math.abs(marked[2]! - plain[2]!),
	);
	expect(diff).toBeGreaterThan(12);
});
