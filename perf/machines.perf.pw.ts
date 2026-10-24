import { expect, type Page, test } from "@playwright/test";
import { runGuarded } from "./helpers";

/**
 * P5-T3 perf qualification (local-only per D14): the PRD G7 scale target —
 * 500 mixed bodies at the 60 fps budget, and a 1000-body machine-shaped
 * stress case (300+ rope beads across chains plus jointed cart assemblies)
 * against the documented 45 fps floor. Spawned through the real `?debug=1`
 * spawn hooks (spawnBox/spawnCircle/spawnRope/placeJoint), so the colliders,
 * joints, and rope links are exactly what the tools produce.
 */

/** Load the debug page and build a fixture. `build` must be fully
 * self-contained (no closure over module scope — page.evaluate serializes
 * the function source) and grab the debug API off `window.__ppg` itself. */
async function spawnField(page: Page, build: () => void) {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	await page.evaluate(build);
}

test("500 mixed bodies hold 60 fps", async ({ page }) => {
	test.setTimeout(300_000);
	// The grid builder is emitted inline (serialized): mixed materials,
	// boxes and circles, 10-wide rows.
	await spawnField(page, () => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		const materials = ["ink", "wood", "stone", "metal", "rubber", "ice"];
		for (let i = 0; i < 500; i++) {
			const col = i % 10;
			const row = Math.floor(i / 10);
			const x = -198 + col * 44;
			const y = -40 - row * 44;
			const material = materials[i % materials.length];
			if (i % 3 === 2) {
				ppg.spawnCircle(`typ-${i}`, x, y, 12 + (i % 4) * 2, false, material);
			} else {
				ppg.spawnBox(`typ-${i}`, x, y, 20, 16, material, false);
			}
		}
	});
	// Settle the pile before measuring (falling stacks are the easy case;
	// resting contact stacks are the solver's steady-state load).
	await page.evaluate(() => window.__ppg?.advanceTime(3_000));
	const { stats, loadBefore, loadAfter } = await runGuarded(page);
	console.log(
		`[perf] 500 typical: ${stats.fps.toFixed(1)} fps (load ${loadBefore.toFixed(2)} → ${loadAfter.toFixed(2)}), frame budget p50 ${stats.p50.toFixed(1)}ms p95 ${stats.p95.toFixed(1)}ms max ${stats.max.toFixed(1)}ms`,
	);
	expect(stats.fps).toBeGreaterThanOrEqual(60);
	expect(stats.p95).toBeLessThanOrEqual(25);
});

test("1000-body machine stress: 300+ rope beads + cart assemblies hold 45 fps", async ({
	page,
}) => {
	test.setTimeout(300_000);
	await spawnField(page, () => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("debug api missing");
		// 620 loose mixed bodies across the field (same shape as the 500
		// case, widened field).
		const materials = ["ink", "wood", "stone", "metal", "rubber", "ice"];
		for (let i = 0; i < 620; i++) {
			const col = i % 10;
			const row = Math.floor(i / 10);
			const x = -198 + col * 44;
			const y = -40 - row * 44;
			const material = materials[i % materials.length];
			if (i % 3 === 2) {
				ppg.spawnCircle(`str-${i}`, x, y, 12 + (i % 4) * 2, false, material);
			} else {
				ppg.spawnBox(`str-${i}`, x, y, 20, 16, material, false);
			}
		}

		// 20 cart assemblies: chassis + two wheels on pins (3 bodies, 2 pin
		// joints each) parked to the right of the grid.
		for (let c = 0; c < 20; c++) {
			const x = 280 + (c % 5) * 90;
			const y = -20 - Math.floor(c / 5) * 60;
			ppg.spawnBox(`cart-${c}`, x, y, 26, 8, "wood", false);
			ppg.spawnCircle(`cart-${c}-wl`, x - 22, y + 12, 9, false, "metal");
			ppg.spawnCircle(`cart-${c}-wr`, x + 22, y + 12, 9, false, "metal");
			ppg.placeJoint(
				`cart-${c}-pl`,
				"pin",
				`cart-${c}`,
				`cart-${c}-wl`,
				x - 22,
				y + 12,
				x - 22,
				y + 12,
			);
			ppg.placeJoint(
				`cart-${c}-pr`,
				"pin",
				`cart-${c}`,
				`cart-${c}-wr`,
				x + 22,
				y + 12,
				x + 22,
				y + 12,
			);
		}

		// 5 ropes at the 64-link per-chain cap hanging from static anchor
		// beams, top end captured to the beam — 300 beads total (the D17
		// total guard was raised to 384 for exactly this workload).
		let beads = 0;
		for (let r = 0; r < 5; r++) {
			const x = -450 + r * 150;
			ppg.spawnBox(`beam-${r}`, x, -500, 30, 4, "stone", true);
			const points = [];
			for (let s = 0; s <= 60; s++) {
				points.push({ x, y: -490 + s * 2 });
			}
			const spawned = ppg.spawnRope(points, `beam-${r}`);
			if (!spawned) throw new Error(`rope ${r} refused (D17 bounds)`);
			beads += spawned.segments.length;
		}
		if (beads < 300) throw new Error(`only ${beads} rope beads placed`);
	});
	await page.evaluate(() => window.__ppg?.advanceTime(3_000));
	const { stats, loadBefore, loadAfter } = await runGuarded(page);
	console.log(
		`[perf] 1000 stress: ${stats.fps.toFixed(1)} fps (load ${loadBefore.toFixed(2)} → ${loadAfter.toFixed(2)}), frame budget p50 ${stats.p50.toFixed(1)}ms p95 ${stats.p95.toFixed(1)}ms max ${stats.max.toFixed(1)}ms`,
	);
	expect(stats.fps).toBeGreaterThanOrEqual(45);
});
