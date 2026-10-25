import { expect, test } from "@playwright/test";

/**
 * Text tool properties (label-panel.ts) and re-editing: a placed label takes
 * size/font/alignment from the context panel, and a double-click with the
 * select tool re-enters the inline edit (typed text appends; Enter commits).
 * The document record is the contract.
 */

test("placed text: panel size/font/align apply; double-click re-edits the text", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	const stage = await page.locator("#stage").boundingBox();
	const cam = await page.evaluate(() => window.__ppg!.cameraState());
	const toScreen = (wx: number, wy: number) => ({
		x: stage!.x + wx * cam.zoom + cam.offsetX,
		y: stage!.y + wy * cam.zoom + cam.offsetY,
	});

	// Place a label through the real text-tool flow: click, type, Enter.
	await page.locator('[data-tool="text"]').click();
	const p = toScreen(40, -140);
	await page.mouse.click(p.x, p.y);
	await page.keyboard.type("Hello");
	await page.keyboard.press("Enter");
	const placed = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().at(-1);
		return e?.kind === "label" ? e : null;
	});
	expect(placed).not.toBeNull();
	expect(placed?.text).toBe("Hello");

	// Double-click re-enters the edit; typed characters append; Enter commits.
	await page.locator('[data-tool="select"]').click();
	const at = toScreen(placed?.x ?? 40, placed?.y ?? -140);
	await page.mouse.dblclick(at.x, at.y);
	await page.keyboard.type(" World");
	await page.keyboard.press("Enter");
	const edited = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().find((e) => e.kind === "label");
		return e?.kind === "label" ? { text: e.text } : null;
	});
	expect(edited?.text).toBe("Hello World");

	// The double-click left the label selected: the Text section is showing.
	// Set size, font, and alignment; each lands in the document.
	const sizeInput = page.locator("[data-label-size]");
	await sizeInput.waitFor({ state: "visible", timeout: 5000 });
	await sizeInput.fill("20");
	await sizeInput.blur();
	await page.locator("[data-label-font]").selectOption("serif");
	await page.locator("[data-label-align]").selectOption("center");
	const styled = await page.evaluate(() => {
		const e = window.__ppg!.documentAll().find((e) => e.kind === "label");
		return e?.kind === "label"
			? { size: e.size, font: e.font, align: e.align }
			: null;
	});
	expect(styled?.size).toBe(20);
	expect(styled?.font).toBe("serif");
	expect(styled?.align).toBe("center");
});
