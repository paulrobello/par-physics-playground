import { expect, test } from "@playwright/test";

test("boots canvas and HUD skeleton", async ({ page }) => {
	const pageErrors: string[] = [];
	page.on("pageerror", (error) => pageErrors.push(String(error)));
	page.on("console", (message) => {
		if (message.type() === "error") pageErrors.push(message.text());
	});

	await page.goto("/?debug=1");
	await expect(page.locator("#stage")).toBeVisible();
	// The app name lives in the document title only — the top bar is
	// icon+tooltip controls since 2026-10-25.
	await expect(page).toHaveTitle("Par Physics Playground");
	await expect(page.locator("#tool-rail")).toBeAttached();
	await expect(page.locator("#context-panel")).toBeAttached();

	// The renderer's per-frame background fill must reach the backing store;
	// a boot crash before the rAF loop leaves every pixel transparent.
	await expect
		.poll(
			async () =>
				page.evaluate(() => {
					const canvas = document.querySelector<HTMLCanvasElement>("#stage");
					const ctx = canvas?.getContext("2d");
					if (!canvas || !ctx || canvas.width === 0 || canvas.height === 0)
						return 0;
					const pixel = ctx.getImageData(
						Math.floor(canvas.width / 2),
						Math.floor(canvas.height / 2),
						1,
						1,
					).data;
					return pixel[3] ?? 0;
				}),
			{ timeout: 5_000 },
		)
		.toBeGreaterThan(0);

	// Backing store must track CSS size times devicePixelRatio after a resize.
	await page.setViewportSize({ width: 900, height: 620 });
	await expect
		.poll(async () =>
			page.evaluate(() => {
				const canvas = document.querySelector<HTMLCanvasElement>("#stage");
				if (!canvas) return Number.NaN;
				const rect = canvas.getBoundingClientRect();
				const dpr = window.devicePixelRatio;
				return (
					Math.abs(canvas.width - Math.round(rect.width * dpr)) +
					Math.abs(canvas.height - Math.round(rect.height * dpr))
				);
			}),
		)
		.toBeLessThanOrEqual(1);

	expect(pageErrors).toEqual([]);
});
