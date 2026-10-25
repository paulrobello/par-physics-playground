import { expect, test } from "@playwright/test";

/**
 * Settings persistence (settings-store.ts): every control changed through the
 * real UI writes to localStorage, and a reload restores all of them — speed,
 * gravity magnitude, grid size + toggles, angle snap, static mode, FPS
 * readout, the selected tool, and the paused/running toggle (in a normal,
 * non-debug session — debug boots force-paused by design).
 */

test("changed settings survive a reload", async ({ page }) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Change every persisted control through the real UI.
	const gridField = page.locator('[data-draw="grid-size"]');
	await gridField.fill("40");
	await gridField.blur();
	await page.locator('[data-draw="grid-snap"]').click();
	await page.locator('[data-draw="angle-snap"]').click();
	await page.locator('[data-tool="circle"]').click();
	await page.locator("#fps-toggle").click();
	await page.locator('[data-mode="static"]').click();
	await page.locator('[data-sim="time-scale"]').fill("1.5");
	await page.locator('[data-sim="gravity-mag"]').fill("3.5");

	// A reload boots a fresh app over the same origin storage.
	await page.reload();
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Grid + toggles: the field and output carry the restored values.
	expect.soft(await gridField.inputValue()).toBe("40");
	expect
		.soft(await page.locator('[data-draw="grid-size-out"]').textContent())
		.toBe("40u");
	await expect.soft(page.locator('[data-draw="grid-snap"]')).toBeChecked();
	await expect.soft(page.locator('[data-draw="angle-snap"]')).toBeChecked();

	// Tool rail: the circle radio is checked and its label shows active.
	await expect.soft(page.locator('[data-tool="circle"] input')).toBeChecked();
	await expect.soft(page.locator('[data-tool="circle"]')).toHaveClass(/active/);

	// Static mode + FPS readout restored.
	await expect
		.soft(page.locator('[data-mode="static"]'))
		.toHaveAttribute("aria-pressed", "true");
	await expect.soft(page.locator("#status-fps")).toBeVisible();

	// Speed + gravity sliders repaint from the restored state.
	expect
		.soft(await page.locator('[data-sim="time-scale-out"]').textContent())
		.toBe("1.50×");
	expect
		.soft(await page.locator('[data-sim="gravity-mag-out"]').textContent())
		.toBe("3.50");
});

test("pause state survives a reload in a normal (non-debug) session", async ({
	page,
}) => {
	// ?demo=1 forces the built-in scene without debug mode — the clock runs
	// live. No __ppg here, so boot is detected via the census going non-empty
	// (restore happens before the controls attach and any frame renders).
	await page.goto("/?demo=1");
	await page.waitForFunction(
		() =>
			(document.querySelector("#status-stats")?.textContent ?? "").length > 0,
	);
	const pauseBtn = page.locator('[data-sim="pause"]');

	// A normal session boots RUNNING; pausing persists across a reload.
	await expect(pauseBtn).toHaveAttribute("aria-pressed", "false");
	await pauseBtn.click();
	await expect(pauseBtn).toHaveAttribute("aria-pressed", "true");
	await page.reload();
	await page.waitForFunction(
		() =>
			(document.querySelector("#status-stats")?.textContent ?? "").length > 0,
	);
	await expect
		.soft(page.locator('[data-sim="pause"]'))
		.toHaveAttribute("aria-pressed", "true");

	// ...and unpausing persists too.
	await page.locator('[data-sim="pause"]').click();
	await page.reload();
	await page.waitForFunction(
		() =>
			(document.querySelector("#status-stats")?.textContent ?? "").length > 0,
	);
	await expect
		.soft(page.locator('[data-sim="pause"]'))
		.toHaveAttribute("aria-pressed", "false");
});
