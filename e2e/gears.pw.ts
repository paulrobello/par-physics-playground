import { expect, test } from "@playwright/test";

for (const mode of ["gear", "belt"] as const) {
	test(`${mode}: real circle-only placement, motor drive, readouts, undo, autosave, cascade`, async ({
		page,
	}) => {
		await page.goto("/?debug=1");
		await page.waitForFunction(() => window.__ppg !== undefined);
		const stage = await page.locator("#stage").boundingBox();
		const cam = await page.evaluate(() => window.__ppg?.cameraState());
		if (!stage || !cam) throw new Error("stage missing");
		const screen = (x: number, y: number) => ({
			x: stage.x + x * cam.zoom + cam.offsetX,
			y: stage.y + y * cam.zoom + cam.offsetY,
		});
		const click = async (x: number, y: number) => {
			const p = screen(x, y);
			await page.mouse.click(p.x, p.y);
		};
		await page.evaluate(() => {
			const p = window.__ppg;
			p?.spawnCircle("a", 140, -160, 30);
			p?.spawnCircle("b", 400, -160, 15);
			p?.spawnBox("box", 270, -80, 20, 20);
			p?.placeJoint("motor-a", "motor", "a", null, 140, -160, 140, -160);
			p?.placeJoint("pin-b", "pin", "b", null, 400, -160, 400, -160);
		});
		await page.click('[data-tool="joint"]');
		await page.click(`[data-joint-kind="${mode}"]`);
		await click(270, -80);
		await expect(page.locator("#ppg-notice")).toContainText("circles");
		await click(140, -160);
		await click(270, -80);
		expect(await page.evaluate(() => window.__ppg?.jointIds().length)).toBe(2);
		await click(140, -160);
		await click(400, -160);
		const id = await page.evaluate(() => window.__ppg?.selectedIds()[0]);
		if (!id) throw new Error("joint not selected");
		await expect(page.locator(".joint-panel")).toContainText(
			"Radius ratio (A/B): 2.000",
		);
		await expect(
			page.locator(".joint-panel [data-joint-params] input"),
		).toHaveCount(0);
		const motion = await page.evaluate(() => {
			const p = window.__ppg;
			let a = 0,
				b = 0,
				pa = p?.bodyRot("a") ?? 0,
				pb = p?.bodyRot("b") ?? 0;
			const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
			for (let i = 0; i < 240; i++) {
				p?.advanceTime(1000 / 60);
				const ra = p?.bodyRot("a") ?? 0,
					rb = p?.bodyRot("b") ?? 0;
				a += wrap(ra - pa);
				b += wrap(rb - pb);
				pa = ra;
				pb = rb;
			}
			return { a, b };
		});
		expect(Math.abs(motion.a)).toBeGreaterThan(2);
		expect(
			Math.abs(motion.b / motion.a - (mode === "gear" ? -2 : 2)),
		).toBeLessThan(0.1);
		await page.click('[data-action="delete"]');
		expect(
			await page.evaluate((id) => window.__ppg?.joint(id), id),
		).toBeUndefined();
		await page.click('[data-action="undo"]');
		await page.waitForTimeout(900);
		await page.reload();
		await page.waitForFunction(() => window.__ppg !== undefined);
		expect(
			await page.evaluate((id) => window.__ppg?.joint(id)?.jointType, id),
		).toBe(mode);
		await page.click('[data-tool="select"]');
		// Off-center body click avoids the axle glyph.
		await click(405, -155);
		await page.click('[data-action="delete"]');
		expect(
			await page.evaluate((id) => window.__ppg?.joint(id), id),
		).toBeUndefined();
	});
}
