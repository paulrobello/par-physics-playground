import { expect, test } from "@playwright/test";

/**
 * Status bar (status-bar.ts): the help line tracks the active tool (the
 * polygon close instructions Paul called out), the census updates live as
 * bodies are added, and the FPS toggle shows a live readout.
 */

test("status bar: polygon help, live census, FPS toggle", async ({ page }) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	const help = page.locator("#status-help");

	// The polygon tool's help names both close affordances.
	await page.locator('[data-tool="polygon"]').click();
	await expect(help).toContainText("Enter to close");
	await expect(help).toContainText("first vertex");

	// Census: a debug-spawned box shows up without any reload.
	await page.evaluate(() =>
		window.__ppg!.spawnBox("statbox", 0, -60, 30, 20, "ink", false),
	);
	await expect(page.locator("#status-stats")).toContainText("boxes 1", {
		timeout: 5000,
	});

	// FPS toggle: the readout appears and reports a number.
	await page.locator("#fps-toggle").click();
	await expect(page.locator("#status-fps")).toBeVisible();
	await expect(page.locator("#status-fps")).toContainText("fps", {
		timeout: 5000,
	});
});
