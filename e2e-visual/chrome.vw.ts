import { expect, test } from "@playwright/test";

// Visual-regression baselines for the P3-T4 impeccable pass: top bar (sim
// controls), tool rail, and the context panel — chrome only, never the
// canvas (the physics render is not pixel-deterministic). Local-only per
// D14. Update baselines with:
//   bunx playwright test --config playwright.visual.config.ts --update-snapshots

async function boot(page: import("@playwright/test").Page): Promise<void> {
	await page.goto("/");
	await page.waitForTimeout(600);
}

test("top bar with sim controls", async ({ page }) => {
	await boot(page);
	const bar = page.locator("#top-bar");
	await expect(bar).toBeVisible();
	await expect(page).toHaveScreenshot("top-bar.png", {
		clip: { x: 0, y: 0, width: 1440, height: 40 },
		fullPage: false,
	});
});

test("tool rail at rest and armed", async ({ page }) => {
	await boot(page);
	const rail = page.locator("#tool-rail");
	await expect(rail).toBeVisible();
	await expect(page).toHaveScreenshot("tool-rail.png", {
		clip: { x: 0, y: 40, width: 48, height: 560 },
	});
	// Armed (hover) state of a second tool.
	await page.hover("[data-tool='circle']");
	await page.waitForTimeout(250);
	await expect(page).toHaveScreenshot("tool-rail-hover.png", {
		clip: { x: 0, y: 40, width: 48, height: 560 },
	});
});

test("context panel: palette, editor open, selection glow", async ({
	page,
}) => {
	await boot(page);
	const panel = page.locator("#context-panel");
	await expect(panel).toBeVisible();
	await expect(page).toHaveScreenshot("context-panel.png", {
		clip: { x: 1160, y: 40, width: 280, height: 480 },
	});
	// Material editor open (raised card, primary action).
	await page.click("[data-mat-new]");
	await page.waitForTimeout(250);
	await expect(page).toHaveScreenshot("context-panel-editor.png", {
		clip: { x: 1160, y: 40, width: 280, height: 700 },
	});
});
