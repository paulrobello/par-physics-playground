import { expect, type Page, test } from "@playwright/test";

/**
 * UX fixes batch: widget tooltips (no native titles, hover + keyboard
 * paths), and the demo camera centering the scene's content bounds in the
 * visible canvas. The sim-stall pump is pinned by unit tests
 * (tests/unit/sim-pump.test.ts) — an e2e rate assert would be a load flake.
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

	test("hover shows the styled tooltip after its delay", async () => {
		const label = page.locator('[data-tool="box"]');
		await label.hover();
		await page.waitForTimeout(700);
		const opacity = await label.evaluate(
			(el) => getComputedStyle(el, "::after").opacity,
		);
		expect(Number(opacity)).toBe(1);
		const content = await label.evaluate(
			(e) => getComputedStyle(e, "::after").content,
		);
		expect(content).toContain("Box (B)");
	});

	test("keyboard focus shows the tooltip (:focus-within path)", async () => {
		await page.locator("#ppg-tool-box").focus();
		await page.waitForTimeout(700);
		const opacity = await page
			.locator('[data-tool="box"]')
			.evaluate((el) => getComputedStyle(el, "::after").opacity);
		expect(Number(opacity)).toBe(1);
	});

	test("top-bar buttons open their tooltip BELOW, rail buttons to the RIGHT", async () => {
		// Position contract via computed top offsets (below = 100% + 9px;
		// right = 50% vertical). Compare the resolved 'top' differs between
		// variants rather than parsing calc().
		const railTop = await page
			.locator('[data-tool="box"]')
			.evaluate((el) => getComputedStyle(el, "::after").top);
		const topBarTop = await page
			.locator('[data-sim="demo"]')
			.evaluate((el) => getComputedStyle(el, "::after").top);
		expect(railTop).not.toBe(topBarTop);
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
