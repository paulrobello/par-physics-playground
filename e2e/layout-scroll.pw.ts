import { expect, test } from "@playwright/test";

/**
 * Page-level scrollbar guard (Paul, 2026-10-24): the header's overflow must
 * scroll inside #top-bar, never the page — a page horizontal scrollbar also
 * pushes the 100vh app grid into vertical scroll (the status bar read as the
 * culprit). innerWidth vs clientWidth is the scrollbar detector: any page
 * scrollbar makes the two differ.
 */

test("the page never scrolls; a narrow header scrolls horizontally", async ({
	page,
}) => {
	await page.setViewportSize({ width: 640, height: 600 });
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	const m = await page.evaluate(() => ({
		innerW: window.innerWidth,
		innerH: window.innerHeight,
		clientW: document.documentElement.clientWidth,
		clientH: document.documentElement.clientHeight,
		barBottom: document.querySelector("#status-bar")!.getBoundingClientRect()
			.bottom,
		headerScrollW: document.querySelector("#top-bar")!.scrollWidth,
		headerClientW: document.querySelector("#top-bar")!.clientWidth,
	}));
	// No page scrollbars in either axis at a header-overflowing width.
	expect(m.clientW).toBe(m.innerW);
	expect(m.clientH).toBe(m.innerH);
	// The status bar sits fully inside the viewport.
	expect(m.barBottom).toBeLessThanOrEqual(m.innerH);
	// The header holds its overflow as horizontal scroll room.
	expect(m.headerScrollW).toBeGreaterThan(m.headerClientW);
});
