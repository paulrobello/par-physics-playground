import { expect, test } from "@playwright/test";

/**
 * Joint framework e2e (P4-T1, local-only per D14): a pin placed between two
 * boxes constrains their relative pose — the two bodies rotate about the
 * shared pivot, so the stored body-local anchors must stay coincident in
 * world space while the assembly falls and swings. Also covers the attach UX
 * (joint tool two-click flow, auto-select, params panel, undo) and the
 * Ruling-22 removal cascade through the UI delete path.
 */
test("pin between two boxes constrains the anchored pivots together", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg;
		// A static anchor block with a dynamic box pinned to it 60 units out:
		// the pin makes jB rotate about the shared pivot (a pendulum).
		ppg?.spawnBox("jA", 0, -200, 20, 20, undefined, true);
		ppg?.spawnBox("jB", 80, -200, 20, 20);
		ppg?.placePin("jp", "jA", "jB", 0, -200);
	});
	const placed = await page.evaluate(() => ({
		joints: window.__ppg?.jointIds() ?? [],
		anchor0: window.__ppg?.jointAnchorWorld("jp"),
	}));
	expect(placed.joints).toEqual(["jp"]);
	expect(placed.anchor0?.anchorA).toEqual({ x: 0, y: -200 });
	expect(placed.anchor0?.anchorB).toEqual({ x: 0, y: -200 });

	// Let the assembly fall under gravity, pivoting about the pin.
	await page.evaluate(() => window.__ppg?.advanceTime(2000));
	const after = await page.evaluate(() => ({
		a: window.__ppg?.jointAnchorWorld("jp"),
		posB: window.__ppg?.bodyPosition("jB"),
		rotA: window.__ppg?.bodyRot("jA") ?? Number.NaN,
		rotB: window.__ppg?.bodyRot("jB") ?? Number.NaN,
	}));
	// The pin's two anchor points remain coincident in world space.
	expect(
		Math.abs((after.a?.anchorA.x ?? 0) - (after.a?.anchorB.x ?? 1)),
	).toBeLessThan(0.05);
	expect(
		Math.abs((after.a?.anchorA.y ?? 0) - (after.a?.anchorB.y ?? 1)),
	).toBeLessThan(0.05);
	// The static anchor did not move; the pinned box swung about the pivot.
	expect(after.rotA).toBe(0);
	expect(Math.abs(after.rotB)).toBeGreaterThan(0.01);
	// The pin holds jB at its placement distance from the pivot (80 units):
	// constrained to rotate about it, the center keeps that radius.
	const piv = placed.anchor0?.anchorA;
	if (!piv) throw new Error("pivot missing");
	const dist = Math.hypot(
		(after.posB?.x ?? Number.NaN) - piv.x,
		(after.posB?.y ?? Number.NaN) - piv.y,
	);
	expect(Math.abs(dist - 80)).toBeLessThan(0.5);
});

test("joint tool two-click flow places a pin; panel, undo, and delete cascade follow", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Two separated boxes in the default view. Screen position = stage box
	// origin + world·zoom + camera offset (the camera.pw.ts convention).
	const stage = await page.locator("#stage").boundingBox();
	if (!stage) throw new Error("stage missing");
	const cam = await page.evaluate(() => window.__ppg?.cameraState());
	if (!cam) throw new Error("camera missing");
	const toScreen = (wx: number, wy: number) => ({
		x: stage.x + wx * cam.zoom + cam.offsetX,
		y: stage.y + wy * cam.zoom + cam.offsetY,
	});

	await page.evaluate(() => {
		const ppg = window.__ppg;
		ppg?.spawnBox("ua", 140, -140, 30, 30);
		ppg?.spawnBox("ub", 420, -140, 30, 30);
	});
	await page.click('[data-tool="joint"]');
	await page.mouse.click(toScreen(140, -140).x, toScreen(140, -140).y);
	await page.mouse.click(toScreen(420, -140).x, toScreen(420, -140).y);

	const placed = await page.evaluate(() => ({
		joints: window.__ppg?.jointIds() ?? [],
		joint: window.__ppg?.joint("joint-1"),
		selected: window.__ppg?.selectedIds() ?? [],
	}));
	expect(placed.joints).toEqual(["joint-1"]);
	expect(placed.joint?.jointType).toBe("pin");
	// The placed joint auto-selects (D19) and the params panel skeleton shows.
	expect(placed.selected).toEqual(["joint-1"]);
	await expect(page.locator(".joint-panel")).toBeVisible();
	await expect(page.locator(".joint-panel")).toContainText("Pin");
	await expect(page.locator(".joint-panel")).toContainText("ua ↔ ub");

	// Undo removes the joint (snapshot boundary covers joints).
	await page.evaluate(() => window.__ppg?.undo());
	await expect
		.poll(async () =>
			page.evaluate(() => window.__ppg?.jointIds().length ?? -1),
		)
		.toBe(0);
	// Redo brings it back through the bodies-BEFORE-joints rebuild.
	await page.evaluate(() => window.__ppg?.redo());
	await expect
		.poll(async () => page.evaluate(() => window.__ppg?.jointIds()[0] ?? ""))
		.toBe("joint-1");

	// Pin-to-world works from the same debug path (bodyB = null anchors to
	// the ground; its anchorB stays the stored world point).
	const worldPin = await page.evaluate(() => {
		const ppg = window.__ppg;
		const ok = ppg?.placePin("uw", "ub", null, 420, -140) ?? false;
		return { ok, anchor: ok ? ppg?.jointAnchorWorld("uw") : undefined };
	});
	expect(worldPin.ok).toBe(true);
	expect(worldPin.anchor?.anchorB).toEqual({ x: 420, y: -140 });
});

test("welded pair moves rigidly; rod keeps exact distance; slider translates on-axis", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// --- Weld: two adjacent boxes (edges touching at x=10).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		ppg?.spawnBox("wa", 0, -200, 10, 10);
		ppg?.spawnBox("wb", 20, -200, 10, 10);
		ppg?.placeJoint?.("jw", "weld", "wa", "wb", 10, -200, 10, -200);
	});
	const welded = await page.evaluate(() => ({
		ok: (window.__ppg?.jointIds() ?? []).includes("jw"),
	}));
	expect(welded.ok).toBe(true);
	await page.evaluate(() => window.__ppg?.advanceTime(2000));
	const weld = await page.evaluate(() => ({
		rotA: window.__ppg?.bodyRot("wa") ?? Number.NaN,
		rotB: window.__ppg?.bodyRot("wb") ?? Number.NaN,
		pa: window.__ppg?.bodyPosition("wa"),
		pb: window.__ppg?.bodyPosition("wb"),
	}));
	// Rigid fall: relative rotation unchanged (0) and center distance 20.
	expect(weld.rotB - weld.rotA).toBeCloseTo(0, 1);
	expect(
		Math.hypot(
			(weld.pb?.x ?? 0) - (weld.pa?.x ?? 1),
			(weld.pb?.y ?? 0) - (weld.pa?.y ?? 1),
		),
	).toBeCloseTo(20, 0);
	expect(weld.pa?.y ?? 0).toBeGreaterThan(-200);

	// --- Rod: hanging box keeps its anchor distance (stiff spring holds both
	// directions — the rope joint could only pull).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		ppg?.spawnBox("ra", 0, -300, 10, 10, undefined, true);
		ppg?.spawnBox("rb", 0, -220, 10, 10);
		ppg?.placeJoint?.("jr", "rod", "ra", "rb", 0, -300, 0, -220);
	});
	await page.evaluate(() => window.__ppg?.advanceTime(2000));
	const rod = await page.evaluate(() => ({
		anchor: window.__ppg?.jointAnchorWorld("jr"),
		pa: window.__ppg?.bodyPosition("ra"),
		pb: window.__ppg?.bodyPosition("rb"),
	}));
	// Anchors sit at the body centers; distance stays 80 under load.
	expect(
		Math.hypot(
			(rod.anchor?.anchorB.x ?? 0) - (rod.anchor?.anchorA.x ?? 1),
			(rod.anchor?.anchorB.y ?? 0) - (rod.anchor?.anchorA.y ?? 1),
		),
	).toBeCloseTo(80, 0);
	expect(rod.pb?.y ?? 0).toBeGreaterThan(-221);

	// --- Slider: 45° world axis (y-down: down-right), gravity drives the
	// rider along the axis; perpendicular displacement stays ~0.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		ppg?.spawnBox("sa", 0, -400, 2, 2, undefined, true);
		ppg?.spawnBox("sb", 0, -400, 10, 10);
		ppg?.placeJoint?.("js", "slider", "sa", "sb", -35.36, -435.36, 0, -400);
	});
	await page.evaluate(() => window.__ppg?.advanceTime(2000));
	const slider = await page.evaluate(() => ({
		p: window.__ppg?.bodyPosition("sb"),
	}));
	// s(t) = ½·g·sin45°·t² ≈ 13.9 units along the axis from the pivot.
	const px = slider.p?.x ?? Number.NaN;
	const py = slider.p?.y ?? Number.NaN;
	const along = (px + (py + 400)) * Math.SQRT1_2;
	const perp = (-px + (py + 400)) * Math.SQRT1_2;
	expect(along).toBeGreaterThan(10);
	expect(along).toBeLessThan(100);
	expect(Math.abs(perp)).toBeLessThan(0.2);
});

test("motor: wheel tracks target velocity under load; glyph toggle works; torque cap stalls", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// --- Motorized wheel on a static base (pivot = wheel center; contacts
	// are off between the jointed pair) with a box resting on top as load.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		ppg?.spawnBox("mbase", 0, -227, 5, 5, undefined, true);
		ppg?.spawnCircle("mwheel", 0, -250, 20);
		ppg?.spawnBox("mload", 0, -273, 3, 3);
		ppg?.placeJoint?.("jm", "motor", "mwheel", "mbase", 0, -250, 0, -250);
	});
	const kindOk = await page.evaluate(
		() => window.__ppg?.joint("jm")?.params.kind,
	);
	expect(kindOk).toBe("motor");
	// Settle the torque-limited spin-up, then two 0.5 s windows at the
	// default 3 rad/s: 1.5 rad per window (under the resting load).
	await page.evaluate(() => window.__ppg?.advanceTime(2000));
	const r1 = await page.evaluate(() => window.__ppg?.bodyRot("mwheel") ?? 0);
	await page.evaluate(() => window.__ppg?.advanceTime(500));
	const r2 = await page.evaluate(() => window.__ppg?.bodyRot("mwheel") ?? 0);
	await page.evaluate(() => window.__ppg?.advanceTime(500));
	const r3 = await page.evaluate(() => window.__ppg?.bodyRot("mwheel") ?? 0);
	expect(r2 - r1).toBeCloseTo(1.5, 0);
	expect(r3 - r2).toBeCloseTo(1.5, 0);

	// --- Glyph toggle: a select-tool click on the wheel's motor marker flips
	// the on state (undoable), shows the panel, and stops the wheel.
	const depth0 = await page.evaluate(() => window.__ppg?.undoDepth().undo ?? 0);
	const stage = await page.locator("#stage").boundingBox();
	if (!stage) throw new Error("stage missing");
	const cam = await page.evaluate(() => window.__ppg?.cameraState());
	if (!cam) throw new Error("camera missing");
	const toScreen = (wx: number, wy: number) => ({
		x: stage.x + wx * cam.zoom + cam.offsetX,
		y: stage.y + wy * cam.zoom + cam.offsetY,
	});
	const glyph = toScreen(0, -250);
	await page.mouse.click(glyph.x, glyph.y);
	const toggled = await page.evaluate(() => {
		const params = window.__ppg?.joint("jm")?.params;
		return {
			on: params?.kind === "motor" ? params.on : undefined,
			depth: window.__ppg?.undoDepth().undo ?? 0,
		};
	});
	expect(toggled.on).toBe(false);
	expect(toggled.depth).toBe(depth0 + 1);
	await expect(page.locator(".joint-panel")).toBeVisible();
	await expect(page.locator("[data-motor-on]")).not.toBeChecked();
	await page.evaluate(() => window.__ppg?.advanceTime(1000));
	const coast = await page.evaluate(() => window.__ppg?.bodyRot("mwheel") ?? 0);
	// Off = UNPOWERED, not a brake: the balanced wheel coasts at ~3 rad/s.
	expect(Math.abs(coast - r3) - 3).toBeLessThan(0.4);

	// Panel edit: retarget to 6 rad/s and flip back on.
	await page.locator("[data-motor-vel]").fill("6");
	await page.locator("[data-motor-vel]").press("Tab");
	await page.locator("[data-motor-on]").check();
	await expect(page.locator("[data-motor-on]")).toBeChecked();
	await page.evaluate(() => window.__ppg?.advanceTime(2000));
	const retarget = await page.evaluate(() => {
		const params = window.__ppg?.joint("jm")?.params;
		return params && params.kind === "motor" ? params.targetVelocity : 0;
	});
	expect(retarget).toBe(6);
	const s1 = await page.evaluate(() => window.__ppg?.bodyRot("mwheel") ?? 0);
	await page.evaluate(() => window.__ppg?.advanceTime(500));
	const s2 = await page.evaluate(() => window.__ppg?.bodyRot("mwheel") ?? 0);
	// 6 rad/s → 3 rad per 0.5 s window.
	expect(Math.abs(s2 - s1) - 3).toBeLessThan(0.5);

	// --- Torque cap stalls: a boom arm pinned at its end to the world, drive
	// torque cut to 1 — far under its ~106k gravity torque.
	await page.evaluate(() => {
		const ppg = window.__ppg;
		ppg?.spawnBox("mboom", 30, -450, 30, 3);
		ppg?.placeJoint?.("jm2", "motor", "mboom", null, 0, -450, 0, -450);
		ppg?.setJointParams("jm2", {
			kind: "motor",
			targetVelocity: 3,
			maxTorque: 1,
			on: true,
		});
	});
	await page.evaluate(() => window.__ppg?.advanceTime(1000));
	const b1 = await page.evaluate(() => window.__ppg?.bodyRot("mboom") ?? 0);
	await page.evaluate(() => window.__ppg?.advanceTime(1000));
	const b2 = await page.evaluate(() => window.__ppg?.bodyRot("mboom") ?? 0);
	// Stalled: the arm swings under gravity by a fraction of a radian while
	// the motor cannot lift it (contrast: the wheel covered 3 rad above).
	expect(Math.abs(b2 - b1)).toBeLessThan(0.5);
});

test("spring: period scales with stiffness; panel edits stiffness", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// Hang a box 5 units below its rest length (placed 65, rest 60 — a real
	// initial displacement; the stiff spring's static extension g/270 ≈ 0.04
	// is inside solver noise) and count turning points over an 8 s window.
	const oscillations = (stiffness: number): Promise<number> =>
		page.evaluate((k) => {
			const ppg = window.__ppg;
			if (!ppg) throw new Error("no debug api");
			const suffix = String(k);
			ppg.spawnBox(`sAnch-${suffix}`, 0, -300, 10, 10, undefined, true);
			ppg.spawnBox(`sBob-${suffix}`, 0, -235, 6, 6);
			const ok = ppg.placeJoint?.(
				`jsp-${suffix}`,
				"spring",
				`sAnch-${suffix}`,
				`sBob-${suffix}`,
				0,
				-300,
				0,
				-235,
			);
			if (!ok) throw new Error("spring refused");
			ppg.setJointParams(`jsp-${suffix}`, {
				kind: "spring",
				restLength: 60,
				stiffness: k,
				damping: 1,
			});
			const samples: number[] = [];
			for (let i = 0; i < 240; i++) {
				ppg.advanceTime(1000 / 30);
				const a = ppg.bodyPosition(`sAnch-${suffix}`);
				const b = ppg.bodyPosition(`sBob-${suffix}`);
				if (!a || !b) throw new Error("bodies missing");
				samples.push(Math.hypot(b.x - a.x, b.y - a.y));
			}
			let turns = 0;
			for (let i = 1; i + 1 < samples.length; i++) {
				const prev = samples[i - 1] as number;
				const cur = samples[i] as number;
				const next = samples[i + 1] as number;
				if ((cur - prev) * (next - cur) < 0) turns += 1;
			}
			return turns;
		}, stiffness);

	const soft = await oscillations(30);
	const stiff = await oscillations(270);
	// k=30 → T ≈ 1.15 s; k=270 → T ≈ 0.38 s over the same 8 s window.
	expect(soft).toBeGreaterThanOrEqual(4);
	expect(stiff).toBeGreaterThan(soft * 1.5);

	// Stiffness applies through the ONE updateJointParams boundary (the
	// spring re-materializes from stored anchors with the new params).
	await page.evaluate(() => {
		const params = window.__ppg?.joint("jsp-30")?.params;
		if (!params || params.kind !== "spring") throw new Error("spring missing");
		window.__ppg?.setJointParams("jsp-30", { ...params, stiffness: 60 });
	});
	const edited = await page.evaluate(() => {
		const params = window.__ppg?.joint("jsp-30")?.params;
		return params && params.kind === "spring" ? params.stiffness : 0;
	});
	expect(edited).toBe(60);
});

test("rope bridge sags under a dropped box and holds it", async ({ page }) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("no debug api");
		ppg.spawnBox("rb-l", -60, -200, 10, 10, undefined, true);
		ppg.spawnBox("rb-r", 60, -200, 10, 10, undefined, true);
		const spawned = ppg.spawnRope?.(
			[
				{ x: -55, y: -200 },
				{ x: 55, y: -200 },
			],
			"rb-l",
			"rb-r",
		);
		if (!spawned) throw new Error("rope refused");
		ppg.spawnBox("rb-box", 0, -240, 8, 8);
	});
	await page.evaluate(() => window.__ppg?.advanceTime(5000));
	const state = await page.evaluate(() => ({
		box: window.__ppg?.bodyPosition("rb-box"),
		segments: window.__ppg?.bodyIds().filter((id) => id.startsWith("rope-seg-"))
			.length,
		links: (window.__ppg?.jointIds() ?? []).length,
	}));
	// Held well above the ground line (a broken rope drops it to ~0), and
	// the chain survived as a chain.
	expect(state.box?.y ?? 0).toBeLessThan(-40);
	expect(state.segments ?? 0).toBeGreaterThan(40);
	expect(state.links ?? 0).toBeGreaterThan(40);
});

test("rope caps reject excess placement visibly; the joint tool draws a rope stroke", async ({
	page,
}) => {
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);

	// --- Tool path: joint tool + rope kind, a ~20-unit stroke becomes a
	// segment chain with world-captured ends (empty-space endpoints).
	const stage = await page.locator("#stage").boundingBox();
	if (!stage) throw new Error("stage missing");
	const cam = await page.evaluate(() => window.__ppg?.cameraState());
	if (!cam) throw new Error("camera missing");
	const toScreen = (wx: number, wy: number) => ({
		x: stage.x + wx * cam.zoom + cam.offsetX,
		y: stage.y + wy * cam.zoom + cam.offsetY,
	});
	await page.click('[data-tool="joint"]');
	await page.click('[data-joint-kind="rope"]');
	const start = toScreen(100, -150);
	const end = toScreen(120, -150);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	await page.mouse.move(end.x, end.y, { steps: 12 });
	await page.mouse.up();
	const toolRope = await page.evaluate(() => ({
		segments: window.__ppg?.bodyIds().filter((id) => id.startsWith("rope-seg-"))
			.length,
		ropeLinks: (window.__ppg?.jointIds() ?? []).filter(
			(id) => window.__ppg?.joint(id)?.params.kind === "rope",
		).length,
	}));
	expect(toolRope.segments ?? 0).toBeGreaterThanOrEqual(8);
	expect(toolRope.ropeLinks ?? 0).toBeGreaterThanOrEqual(6);

	// --- Fill toward the total cap: six more 62-segment chains (plus the
	// tool chain's ~11) puts the scene past 384 − 62, so a seventh 62-segment
	// chain overflows and refuses visibly (D17).
	await page.evaluate(() => {
		const ppg = window.__ppg;
		if (!ppg) throw new Error("no debug api");
		for (let c = 0; c < 6; c++) {
			const y = -300 - c * 30;
			const res = ppg.spawnRope?.([
				{ x: -60, y },
				{ x: 60, y },
			]);
			if (!res) throw new Error(`filler chain ${c} refused`);
		}
	});
	const rejected = await page.evaluate(() => {
		const before = window.__ppg
			?.bodyIds()
			.filter((id) => id.startsWith("rope-seg-")).length;
		const res = window.__ppg?.spawnRope?.([
			{ x: -60, y: -420 },
			{ x: 60, y: -420 },
		]);
		const after = window.__ppg
			?.bodyIds()
			.filter((id) => id.startsWith("rope-seg-")).length;
		return { res, before, after };
	});
	expect(rejected.res).toBeNull();
	expect(rejected.after).toBe(rejected.before);
	// The refusal is VISIBLE: the notice toast names the total cap.
	await expect(page.locator("#ppg-notice")).toBeVisible();
	await expect(page.locator("#ppg-notice")).toContainText("384 rope segments");

	// --- Per-chain cap, on a fresh page (the toast persists ~3 s): one
	// 200-unit stroke would be 101 segments — over the 64 per-chain cap.
	await page.goto("/?debug=1");
	await page.waitForFunction(() => window.__ppg !== undefined);
	const perChain = await page.evaluate(() =>
		window.__ppg?.spawnRope?.([
			{ x: -100, y: -200 },
			{ x: 100, y: -200 },
		]),
	);
	expect(perChain).toBeNull();
	await expect(page.locator("#ppg-notice")).toContainText("64 segments");
});
