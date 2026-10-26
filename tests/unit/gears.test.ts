/**
 * Post-MVP gear + belt joint: placement (makePlacedJoint with the pair of
 * circle radii), the two-sided velocity-level angular solve (gears.ts —
 * phase-anchored arc-length coupling with Baumgarte correction), and the
 * fixed-step sim behavior per mode (gear = opposite spins, belt = same
 * direction; ratio = the circles' radius ratio), plus serialization
 * round-trip and assembly stamping (gears are plain joints — nothing extra
 * rides in params to translate).
 */
import { describe, expect, test } from "bun:test";
import { captureAssembly, stampAssembly } from "../../src/lib/assembly";
import {
	GEAR_BAUMGARTE,
	GEAR_MAX_CORRECTION,
	GEAR_SLOP,
	solveGearImpulse,
	wrapAngleDelta,
} from "../../src/lib/gears";
import { makePlacedJoint } from "../../src/lib/joint";
import {
	applySceneFile,
	buildSceneFile,
	SCENE_BOUNDS,
	validateSceneFile,
} from "../../src/lib/scene-file";
import { PhysicsWorld } from "../../src/lib/world";

const DT = 1 / 60;

/** Placement transforms shared by the placement tests. */
const TA = { x: 0, y: 0, rot: 0.3 };
const TB = { x: 60, y: 0, rot: -0.2 };

describe("gear/belt placement", () => {
	test("gear: params capture the radius ratio and placement phases; anchors are the circle centers", () => {
		const e = makePlacedJoint(
			"j",
			"gear",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 60, y: 0 },
			TA,
			TB,
			undefined,
			{ radiusA: 20, radiusB: 10 },
		);
		if (!e) throw new Error("refused");
		expect(e.jointType).toBe("gear");
		expect(e.params).toEqual({
			kind: "gear",
			ratio: 2,
			phaseA: 0.3,
			phaseB: -0.2,
		});
		// Anchors are the centers: body-local (0, 0) for both circles.
		expect(e.anchorA).toEqual({ x: 0, y: 0 });
		expect(e.anchorB).toEqual({ x: 0, y: 0 });
	});

	test("belt: same params shape, mode differs only in kind", () => {
		const e = makePlacedJoint(
			"j",
			"belt",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 60, y: 0 },
			TA,
			TB,
			undefined,
			{ radiusA: 8, radiusB: 24 },
		);
		if (!e) throw new Error("refused");
		expect(e.jointType).toBe("belt");
		expect(e.params).toEqual({
			kind: "belt",
			ratio: 8 / 24,
			phaseA: 0.3,
			phaseB: -0.2,
		});
	});

	test("refuses degenerate or missing radii", () => {
		const place = (radii?: { radiusA: number; radiusB: number }) =>
			makePlacedJoint(
				"j",
				"gear",
				"a",
				"b",
				{ x: 0, y: 0 },
				{ x: 60, y: 0 },
				TA,
				TB,
				undefined,
				radii,
			);
		expect(place()).toBeUndefined(); // no radii carried (wrong flow)
		expect(place({ radiusA: 0, radiusB: 10 })).toBeUndefined();
		expect(place({ radiusA: 10, radiusB: 0 })).toBeUndefined();
		expect(place({ radiusA: -4, radiusB: 10 })).toBeUndefined();
	});

	test("refuses a ratio beyond the scene-file bound (placement parity with save validation)", () => {
		// Scene-file validation caps ratio at (0, SCENE_BOUNDS.maxHalfExtent];
		// a pair placed beyond it could never pass its own save/reload, so
		// placement refuses up front (undefined → the tool's standard refusal
		// notice, like every other gear placement guard).
		const place = (radii: { radiusA: number; radiusB: number }) =>
			makePlacedJoint(
				"j",
				"gear",
				"a",
				"b",
				{ x: 0, y: 0 },
				{ x: 60, y: 0 },
				TA,
				TB,
				undefined,
				radii,
			);
		expect(
			place({ radiusA: 20, radiusB: 20 / (SCENE_BOUNDS.maxHalfExtent + 1) }),
		).toBeUndefined();
		expect(
			place({ radiusA: SCENE_BOUNDS.maxHalfExtent + 1, radiusB: 1 }),
		).toBeUndefined();
		// Exactly at the bound still places.
		expect(
			place({ radiusA: 20, radiusB: 20 / SCENE_BOUNDS.maxHalfExtent }),
		).toBeDefined();
	});

	test("refuses without a second body (belt between a body and the world is meaningless)", () => {
		expect(
			makePlacedJoint(
				"j",
				"belt",
				"a",
				null,
				{ x: 0, y: 0 },
				{ x: 60, y: 0 },
				TA,
				null,
				undefined,
				{ radiusA: 20, radiusB: 10 },
			),
		).toBeUndefined();
	});
});

describe("wrapAngleDelta", () => {
	test("in-band differences pass through; out-of-band wrap to (−π, π]", () => {
		expect(wrapAngleDelta(0.1)).toBeCloseTo(0.1, 12);
		expect(wrapAngleDelta(Math.PI + 0.1)).toBeCloseTo(-Math.PI + 0.1, 12);
		expect(wrapAngleDelta(-Math.PI - 0.1)).toBeCloseTo(Math.PI - 0.1, 12);
		expect(wrapAngleDelta(3 * Math.PI)).toBeCloseTo(Math.PI, 12);
		expect(wrapAngleDelta(-3 * Math.PI)).toBeCloseTo(Math.PI, 12);
		expect(wrapAngleDelta(Number.NaN)).toBe(0);
	});
});

describe("solveGearImpulse (pure)", () => {
	test("inside the slop band: the impulse exactly cancels the constraint velocity (two-sided)", () => {
		expect(solveGearImpulse(0, 2, 0.5, DT)).toBeCloseTo(-4, 9);
		expect(solveGearImpulse(0, -2, 0.5, DT)).toBeCloseTo(4, 9);
		expect(solveGearImpulse(GEAR_SLOP, 3, 1, DT)).toBeCloseTo(-3, 9);
	});

	test("outside the slop band: Ċ is driven to −bias (phase reels back, either sign)", () => {
		const bias = (GEAR_BAUMGARTE * (1 - GEAR_SLOP)) / DT;
		expect(solveGearImpulse(1, 0, 1, DT)).toBeCloseTo(-bias, 9);
		expect(solveGearImpulse(-1, 0, 1, DT)).toBeCloseTo(bias, 9);
	});

	test("the bias is capped (a teleport cannot rocket the pair)", () => {
		expect(solveGearImpulse(1000, 0, 1, DT)).toBeCloseTo(
			-GEAR_MAX_CORRECTION,
			9,
		);
		expect(solveGearImpulse(-1000, 0, 1, DT)).toBeCloseTo(
			GEAR_MAX_CORRECTION,
			9,
		);
	});

	test("degenerate guards: zero inverse mass, NaN, dt ≤ 0 give zero", () => {
		expect(solveGearImpulse(1, 0, 0, DT)).toBe(0);
		expect(solveGearImpulse(Number.NaN, 0, 1, DT)).toBe(0);
		expect(solveGearImpulse(0, Number.NaN, 1, DT)).toBe(0);
		expect(solveGearImpulse(1, 0, Number.POSITIVE_INFINITY, DT)).toBe(0);
		expect(solveGearImpulse(1, 0, 1, 0)).toBe(0);
		expect(solveGearImpulse(1, 0, 1, -DT)).toBe(0);
	});
});

async function fixture(
	kind: "gear" | "belt",
	fixed = false,
): Promise<PhysicsWorld> {
	const w = await PhysicsWorld.create();
	w.setGravity(0, 0);
	w.spawnCircle("a", 0, -120, 20);
	w.spawnCircle("b", 100, -120, 10, fixed);
	const e = makePlacedJoint(
		"g",
		kind,
		"a",
		"b",
		TA,
		TB,
		{ x: 0, y: -120, rot: 0 },
		{ x: 100, y: -120, rot: 0 },
		undefined,
		{ radiusA: 20, radiusB: 10 },
	);
	if (!e || !w.spawnJoint(e)) throw new Error("gear refused");
	return w;
}
describe("gear physics", () => {
	for (const kind of ["gear", "belt"] as const) {
		test(`${kind} couples free spins and holds phase for 600 ticks`, async () => {
			const w = await fixture(kind);
			w.bodies.get("a")!.setAngvel(2, true);
			let a = 0,
				b = 0,
				pa = 0,
				pb = 0;
			for (let i = 0; i < 600; i++) {
				w.step();
				const ra = w.bodyRotation("a")!,
					rb = w.bodyRotation("b")!;
				a += wrapAngleDelta(ra - pa);
				b += wrapAngleDelta(rb - pb);
				pa = ra;
				pb = rb;
			}
			expect(a).toBeGreaterThan(1);
			expect(
				Math.abs(20 * a + (kind === "gear" ? 1 : -1) * 10 * b),
			).toBeLessThan(0.05);
		});
	}
	test("static gear stops its dynamic partner", async () => {
		const w = await fixture("gear", true);
		w.bodies.get("a")!.setAngvel(2, true);
		for (let i = 0; i < 60; i++) w.step();
		expect(Math.abs(w.bodies.get("a")!.angvel())).toBeLessThan(0.01);
	});
});

describe("gear/belt serialization, assemblies, validation", () => {
	test("buildSceneFile → applySceneFile round-trip keeps the train coupled", async () => {
		const w = await fixture("gear");
		const file = buildSceneFile(w.doc);
		expect(validateSceneFile(file).ok).toBe(true);
		const restored = await PhysicsWorld.create();
		restored.setGravity(0, 0);
		applySceneFile(restored, file);
		const joint = restored.doc.get("g");
		if (joint?.kind !== "joint") throw new Error("joint missing");
		expect(joint.params).toEqual({
			kind: "gear",
			ratio: 2,
			phaseA: 0,
			phaseB: 0,
		});
		restored.bodies.get("a")!.setAngvel(2, true);
		let a = 0;
		let b = 0;
		let pa = 0;
		let pb = 0;
		for (let i = 0; i < 120; i++) {
			restored.step();
			const ra = restored.bodyRotation("a") ?? 0;
			const rb = restored.bodyRotation("b") ?? 0;
			a += wrapAngleDelta(ra - pa);
			b += wrapAngleDelta(rb - pb);
			pa = ra;
			pb = rb;
		}
		expect(Math.abs(20 * a + 10 * b)).toBeLessThan(0.05);
	}, 10_000);

	test("assembly capture/stamp: gear params carry no world points, nothing translates", async () => {
		const w = await fixture("gear");
		const captured = captureAssembly(w.doc, new Set(["a", "b"]), "p");
		if (!captured.ok) throw new Error(captured.error);
		const ids = stampAssembly(w, captured.assembly.file, 400, -200);
		const e = w.doc.get(ids[2] ?? "");
		if (e?.kind !== "joint") throw new Error("stamped joint missing");
		// The stamped gear keeps the ratio and placement phases exactly —
		// unlike the pulley's wheel, no gear param is a scene point.
		expect(e.params).toEqual({ kind: "gear", ratio: 2, phaseA: 0, phaseB: 0 });
	});

	test("scene-file validation rejects a mistyped or unbounded ratio", async () => {
		const w = await fixture("gear");
		const base = buildSceneFile(w.doc);
		const good = base.entities.find(
			(e): e is Extract<(typeof base.entities)[number], { kind: "joint" }> =>
				e.kind === "joint",
		);
		if (!good) throw new Error("joint missing");
		const bad = (ratio: unknown) =>
			validateSceneFile({
				...base,
				entities: [
					{ ...good, params: { ...good.params, ratio } } as typeof good,
				],
			}).ok;
		expect(bad(0)).toBe(false);
		expect(bad(-2)).toBe(false);
		expect(bad(Number.NaN)).toBe(false);
		expect(bad(1001)).toBe(false);
		expect(bad("2")).toBe(false);
		expect(bad(0.5)).toBe(true);
	});
});
