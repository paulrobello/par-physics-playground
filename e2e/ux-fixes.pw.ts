import { expect, type Page, test } from "@playwright/test";

/**
 * UX fixes batch: widget tooltips (no native titles, hover + keyboard
 * paths), the demo camera centering the scene's content bounds in the
 * visible canvas, and the text tool's label edit working after a MOUSE
 * tool-button click (the radio keeps focus; the label edit must own the
 * keyboard regardless). The sim-stall pump and catch-up-cap change are
 * pinned by unit tests — e2e rate asserts would be load flakes.
 */

test.describe("widget tooltips", () => {
	let page: Page;

	test.beforeAll(async ({ browser }) => {
		page = await browser.newPage();
		await page.goto("/");
		await page.waitForSelector("[data-tip]");
	});

	test.afterAll(async () => {
		await page.close();
	});

	test("no native title attributes remain on the page", async () => {
		expect(await page.locator("[title]").count()).toBe(0);
	});

	test("hover shows the widget tooltip after its delay", async () => {
		const label = page.locator('[data-tool="box"]');
		await label.hover();
		await page.waitForTimeout(700); // 400ms delay + transition
		const tip = page.locator(".ppg-tooltip.visible");
		await expect(tip).toBeVisible();
		await expect(tip).toHaveText("Box (B)");
		// The widget is body-level and fixed-position — it renders even
		// though the rail's ancestors clip their overflow.
		const box = await tip.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.width).toBeGreaterThan(10);
	});

	test("keyboard focus shows the tooltip (focusin path)", async () => {
		await page.mouse.move(10, 500); // clear hover
		await page.waitForTimeout(200);
		await page.locator("#ppg-tool-box").focus();
		await page.waitForTimeout(700);
		await expect(page.locator(".ppg-tooltip.visible")).toHaveText("Box (B)");
	});

	test("top-bar button opens its tooltip BELOW its box; rail button to the RIGHT", async () => {
		await page.locator('[data-sim="demo"]').hover();
		await page.waitForTimeout(700);
		const tipBox = await page.locator(".ppg-tooltip.visible").boundingBox();
		const btnBox = await page.locator('[data-sim="demo"]').boundingBox();
		if (!tipBox || !btnBox) throw new Error("boxes missing");
		// Below: the tip's top starts at or under the button's bottom edge.
		expect(tipBox.y).toBeGreaterThanOrEqual(btnBox.y + btnBox.height - 2);
		await page.mouse.move(640, 400);
		await page.waitForTimeout(300);
		const railTip = await page.locator('[data-tool="box"]').evaluate((el) => {
			el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true }));
			return null;
		});
		void railTip;
		await page.waitForTimeout(700);
		const tip2 = await page.locator(".ppg-tooltip.visible").boundingBox();
		const btn2 = await page.locator('[data-tool="box"]').boundingBox();
		if (!tip2 || !btn2) throw new Error("boxes missing");
		// Right: the tip's left edge starts at or past the button's right edge.
		expect(tip2.x).toBeGreaterThanOrEqual(btn2.x + btn2.width - 2);
	});
});

test.describe("text tool label edit (mouse tool-button path)", () => {
	test("click the text button, click canvas, type — the label takes the text", async ({
		page,
	}) => {
		await page.goto("/?debug=1");
		await page.waitForFunction(() => window.__ppg !== undefined);
		// MOUSE-click the text tool label (focus lands on the radio input —
		// the regression: typing was swallowed while the radio held focus).
		await page.locator('[data-tool="text"]').click();
		await page.locator('[data-tool="text"] input').waitFor({
			state: "attached",
		});
		const stage = await page.locator("#stage").boundingBox();
		if (!stage) throw new Error("stage missing");
		await page.mouse.click(stage.x + 400, stage.y + 300);
		// Type with the radio STILL focused — the exact broken flow.
		await page.keyboard.type("Hello Paul");
		await page.keyboard.press("Enter");
		const text = await page.evaluate(() => {
			const ents = window.__ppg!.documentAll();
			const label = ents.find((e) => e.kind === "label");
			return label?.text ?? null;
		});
		expect(text).toBe("Hello Paul");
	});
});

test.describe("demo camera centering", () => {
	test("content-bounds center sits at the canvas center", async ({ page }) => {
		// debug=1 for the __ppg camera/entity handle (debug boots paused —
		// irrelevant to a camera-state assert); demo=1 forces the demo scene.
		await page.goto("/?debug=1&demo=1");
		await page.waitForFunction(
			() => window.__ppg !== undefined && window.__ppg.cameraState,
		);
		// Let the boot settle (renderer + fonts).
		await page.waitForTimeout(800);
		const check = await page.evaluate(() => {
			const cam = window.__ppg!.cameraState();
			const canvas = document.querySelector("#stage");
			if (!canvas) throw new Error("canvas missing");
			const rect = canvas.getBoundingClientRect();
			const ents = window.__ppg!.documentAll();
			let minX = Infinity,
				minY = Infinity,
				maxX = -Infinity,
				maxY = -Infinity;
			for (const e of ents) {
				if (e.kind !== "body") continue;
				const reach =
					e.shape?.kind === "circle"
						? e.shape.radius
						: e.shape?.kind === "box"
							? Math.hypot(e.shape.halfWidth, e.shape.halfHeight)
							: Array.isArray(e.shape?.points)
								? Math.max(
										...e.shape.points.map((p: { x: number; y: number }) =>
											Math.hypot(p.x, p.y),
										),
									)
								: 0;
				minX = Math.min(minX, e.x - reach);
				maxX = Math.max(maxX, e.x + reach);
				minY = Math.min(minY, e.y - reach);
				maxY = Math.max(maxY, e.y + reach);
			}
			return {
				dx: (minX + maxX) / 2,
				dy: (minY + maxY) / 2,
				// The camera's screen space is CANVAS-LOCAL: the fit centers the
				// content at canvas width/2, NOT viewport rect.x + width/2.
				cx: rect.width / 2,
				cy: rect.height / 2,
				zoom: cam.zoom,
				ox: cam.offsetX,
				oy: cam.offsetY,
			};
		});
		const screenX = check.dx * check.zoom + check.ox;
		const screenY = check.dy * check.zoom + check.oy;
		expect(Math.abs(screenX - check.cx)).toBeLessThan(30);
		expect(Math.abs(screenY - check.cy)).toBeLessThan(30);
	});
});
