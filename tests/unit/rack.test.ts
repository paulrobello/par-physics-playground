/**
 * Post-MVP rack-and-pinion joint: placement (makePlacedJoint — circle pinion
 * + box rack, the rack's long axis captured body-local like the slider's),
 * the velocity-level LINEAR-ANGULAR solve (the gears.ts arc-length impulse
 * law applied through a rack-axis Jacobian in world.ts — phase-anchored at
 * placement, sign from which side of the pinion the rack passes), fixed-step
 * sim behavior (pinion drives rack at v = −sign·r·ω, rack impulse spins the
 * pinion, static pinion locks the rack along the axis, static rack stops the
 * pinion), serialization round-trip, validation bounds, and assembly
 * stamping (rack params carry no world points).
 */
import { describe, expect, test } from "bun:test";
import { captureAssembly, stampAssembly } from "../../src/lib/assembly";
import { makePlacedJoint, rackPlacement } from "../../src/lib/joint";
import {
	applySceneFile,
	buildSceneFile,
	validateSceneFile,
} from "../../src/lib/scene-file";
import { PhysicsWorld } from "../../src/lib/world";

/** Placement transforms shared by the placement tests. */
const TA = { x: 0, y: 0, rot: 0.3 };
const TB = { x: 0, y: 60, rot: -0.2 };
const RACK_A = { radiusA: 20, axisX: 1, axisY: 0 };

describe("rackPlacement (shape proof)", () => {
	test("a box carries its long dimension as the rack-local axis", () => {
		expect(
			rackPlacement(
				{ kind: "circle", radius: 20 },
				{ kind: "box", halfWidth: 60, halfHeight: 8 },
			),
		).toEqual({ radiusA: 20, axisX: 1, axisY: 0 });
		expect(
			rackPlacement(
				{ kind: "circle", radius: 20 },
				{ kind: "box", halfWidth: 8, halfHeight: 60 },
			),
		).toEqual({ radiusA: 20, axisX: 0, axisY: 1 });
		// A square box has no long dimension; the wide reading wins.
		expect(
			rackPlacement(
				{ kind: "circle", radius: 5 },
				{ kind: "box", halfWidth: 8, halfHeight: 8 },
			),
		).toEqual({ radiusA: 5, axisX: 1, axisY: 0 });
	});

	test("refuses a non-circle pinion or a non-box rack (line beams commit as boxes, polygons have no long axis)", () => {
		expect(
			rackPlacement(
				{ kind: "box", halfWidth: 10, halfHeight: 10 },
				{ kind: "box", halfWidth: 60, halfHeight: 8 },
			),
		).toBeUndefined();
		expect(
			rackPlacement(
				{ kind: "circle", radius: 20 },
				{ kind: "circle", radius: 10 },
			),
		).toBeUndefined();
		expect(
			rackPlacement(
				{ kind: "circle", radius: 20 },
				{
					kind: "polygon",
					points: [
						{ x: 0, y: 0 },
						{ x: 10, y: 0 },
						{ x: 0, y: 10 },
					],
				},
			),
		).toBeUndefined();
		expect(
			rackPlacement(undefined, { kind: "box", halfWidth: 60, halfHeight: 8 }),
		).toBeUndefined();
		expect(
			rackPlacement(
				{ kind: "circle", radius: 0 },
				{ kind: "box", halfWidth: 60, halfHeight: 8 },
			),
		).toBeUndefined();
	});
});

describe("rack placement", () => {
	test("params capture the pitch radius, placement phases, rack-local axis, and the geometry sign; the rack anchor is the pitch foot", () => {
		const e = makePlacedJoint(
			"j",
			"rack",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 0, y: 60 },
			TA,
			TB,
			undefined,
			undefined,
			RACK_A,
		);
		if (!e) throw new Error("refused");
		expect(e.jointType).toBe("rack");
		expect(e.params).toEqual({
			kind: "rack",
			ratio: 20,
			phasePinion: 0.3,
			phaseRack: -0.2,
			axisX: 1,
			axisY: 0,
			sign: -1,
		});
		// The pinion anchor is the circle center; the rack anchor is the foot
		// of the perpendicular from the pinion center onto the axis line — on
		// the rack's local long axis (y = 0) through the rack center.
		expect(e.anchorA).toEqual({ x: 0, y: 0 });
		expect(e.anchorB.y).toBeCloseTo(0, 9);
	});

	test("a rotated rack still anchors on its own long axis", () => {
		const e = makePlacedJoint(
			"j",
			"rack",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 0, y: 60 },
			TA,
			TB,
			undefined,
			undefined,
			{ radiusA: 20, axisX: 0, axisY: 1 },
		);
		if (!e) throw new Error("refused");
		if (e.params.kind !== "rack") throw new Error("wrong kind");
		// Rack-local axis (0, 1) rotated by −0.2 → world axis ≈ (0.19867, 0.98007).
		expect(e.params.axisX).toBeCloseTo(0, 9);
		expect(e.params.axisY).toBeCloseTo(1, 9);
		// The foot sits on the rack's local LONG axis — for a (0, 1) axis the
		// perpendicular offset is the local x coordinate.
		expect(e.anchorB.x).toBeCloseTo(0, 9);
	});

	test("refuses without a rack record (wrong flow), a degenerate radius or axis", () => {
		const place = (rack?: { radiusA: number; axisX: number; axisY: number }) =>
			makePlacedJoint(
				"j",
				"rack",
				"a",
				"b",
				{ x: 0, y: 0 },
				{ x: 0, y: 60 },
				TA,
				TB,
				undefined,
				undefined,
				rack,
			);
		expect(place()).toBeUndefined();
		expect(place({ radiusA: 0, axisX: 1, axisY: 0 })).toBeUndefined();
		expect(place({ radiusA: -4, axisX: 1, axisY: 0 })).toBeUndefined();
		expect(place({ radiusA: 20, axisX: 0, axisY: 0 })).toBeUndefined();
	});

	test("refuses without a second body and on the same body twice (self-rack)", () => {
		expect(
			makePlacedJoint(
				"j",
				"rack",
				"a",
				null,
				{ x: 0, y: 0 },
				{ x: 0, y: 60 },
				TA,
				null,
				undefined,
				undefined,
				RACK_A,
			),
		).toBeUndefined();
		expect(
			makePlacedJoint(
				"j",
				"rack",
				"a",
				"a",
				{ x: 0, y: 0 },
				{ x: 0, y: 60 },
				TA,
				TA,
				undefined,
				undefined,
				RACK_A,
			),
		).toBeUndefined();
	});
});

/** Zero-g fixture: r=20 pinion above a wide rack whose axis passes 60 units
 * below the pinion center (no contact — the constraint is the only coupling).
 * The rack sits below in the y-down world, so the placement sign is −1 and
 * the coupled rate is v = −20·ω. */
async function fixture(
	opts: { pinionStatic?: boolean; rackStatic?: boolean } = {},
): Promise<PhysicsWorld> {
	const w = await PhysicsWorld.create();
	w.setGravity(0, 0);
	w.spawnCircle("a", 0, -120, 20, opts.pinionStatic ?? false);
	w.spawnBox("b", 0, -60, 60, 8, undefined, opts.rackStatic ?? false);
	const e = makePlacedJoint(
		"g",
		"rack",
		"a",
		"b",
		{ x: 0, y: 0 },
		{ x: 0, y: -60 },
		{ x: 0, y: -120, rot: 0 },
		{ x: 0, y: -60, rot: 0 },
		undefined,
		undefined,
		RACK_A,
	);
	if (!e || !w.spawnJoint(e)) throw new Error("rack refused");
	return w;
}

/** Live rack velocity along +x (the rack never rotates in these fixtures). */
function rackVx(w: PhysicsWorld): number {
	return w.bodies.get("b")!.linvel().x;
}

describe("rack physics", () => {
	test("a spinning pinion drives the rack at v = −r·ω (rack below the pinion)", async () => {
		const w = await fixture();
		w.bodies.get("a")!.setAngvel(2, true);
		for (let i = 0; i < 300; i++) w.step();
		const v = rackVx(w);
		const omega = w.bodies.get("a")!.angvel();
		expect(Math.abs(v)).toBeGreaterThan(1);
		expect(Math.abs(omega)).toBeGreaterThan(0.01);
		expect(v + 20 * omega).toBeCloseTo(0, 1);
	});

	test("a motor on the pinion drives the rack toward v = −r·targetVelocity", async () => {
		const w = await fixture();
		const a = w.bodies.get("a")!;
		w.spawnJoint({
			kind: "joint",
			id: "m",
			jointType: "motor",
			bodyA: "a",
			anchorA: { x: 0, y: 0 },
			bodyB: null,
			anchorB: { x: 0, y: -120 },
			params: {
				kind: "motor",
				targetVelocity: 3,
				maxTorque: 1_000_000,
				on: true,
			},
		});
		for (let i = 0; i < 300; i++) w.step();
		expect(Math.abs(a.angvel())).toBeGreaterThan(1);
		expect(rackVx(w) + 20 * a.angvel()).toBeCloseTo(0, 1);
		expect(rackVx(w)).toBeLessThan(-10);
	});

	test("an impulse on the rack spins the pinion (two-sided exchange)", async () => {
		const w = await fixture();
		// J = 1000 on a 60·16·1 = 960-mass rack → v0 ≈ 1.04 along +x.
		w.bodies.get("b")!.applyImpulse({ x: 1000, y: 0 }, true);
		for (let i = 0; i < 300; i++) w.step();
		const v = rackVx(w);
		const omega = w.bodies.get("a")!.angvel();
		expect(Math.abs(v)).toBeGreaterThan(0.1);
		expect(v + 20 * omega).toBeCloseTo(0, 1);
	});

	test("a static pinion locks the rack along the axis", async () => {
		const w = await fixture({ pinionStatic: true });
		w.bodies.get("b")!.setLinvel({ x: 5, y: 0 }, true);
		for (let i = 0; i < 60; i++) w.step();
		const lv = w.bodies.get("b")!.linvel();
		expect(Math.hypot(lv.x, lv.y)).toBeLessThan(0.01);
	});

	test("a static rack stops the pinion", async () => {
		const w = await fixture({ rackStatic: true });
		w.bodies.get("a")!.setAngvel(2, true);
		for (let i = 0; i < 60; i++) w.step();
		expect(Math.abs(w.bodies.get("a")!.angvel())).toBeLessThan(0.01);
	});

	test("phase holds under sustained drive (teeth stay meshed)", async () => {
		const w = await fixture();
		w.bodies.get("a")!.setAngvel(2, true);
		let d = 0;
		let theta = 0;
		let lastX = 0;
		let lastA = 0;
		for (let i = 0; i < 600; i++) {
			w.step();
			const t = w.bodies.get("b")!.translation();
			const a = w.bodies.get("a")!.rotation();
			const wrap = (x: number) => Math.atan2(Math.sin(x), Math.cos(x));
			d += t.x - lastX;
			theta += wrap(a - lastA);
			lastX = t.x;
			lastA = a;
		}
		// Rack below the pinion (sign −1): the phase error is Δd − sign·r·Δθ
		// = Δd + 20·Δθ; the anchor keeps it near zero while the pair runs.
		expect(Math.abs(d + 20 * theta)).toBeLessThan(0.5);
	});
});

describe("rack serialization, assemblies, validation", () => {
	test("buildSceneFile → applySceneFile round-trip keeps the drive coupled", async () => {
		const w = await fixture();
		const file = buildSceneFile(w.doc);
		expect(validateSceneFile(file).ok).toBe(true);
		const restored = await PhysicsWorld.create();
		restored.setGravity(0, 0);
		applySceneFile(restored, file);
		const joint = restored.doc.get("g");
		if (joint?.kind !== "joint") throw new Error("joint missing");
		expect(joint.params).toEqual({
			kind: "rack",
			ratio: 20,
			phasePinion: 0,
			phaseRack: 0,
			axisX: 1,
			axisY: 0,
			sign: -1,
		});
		restored.bodies.get("a")!.setAngvel(2, true);
		for (let i = 0; i < 300; i++) restored.step();
		const v = restored.bodies.get("b")!.linvel().x;
		const omega = restored.bodies.get("a")!.angvel();
		expect(Math.abs(v)).toBeGreaterThan(1);
		expect(v + 20 * omega).toBeCloseTo(0, 1);
	}, 10_000);

	test("assembly capture/stamp: rack params carry no world points, nothing translates", async () => {
		const w = await fixture();
		const captured = captureAssembly(w.doc, new Set(["a", "b"]), "p");
		if (!captured.ok) throw new Error(captured.error);
		const ids = stampAssembly(w, captured.assembly.file, 400, -200);
		const e = w.doc.get(ids[2] ?? "");
		if (e?.kind !== "joint") throw new Error("stamped joint missing");
		expect(e.params).toEqual({
			kind: "rack",
			ratio: 20,
			phasePinion: 0,
			phaseRack: 0,
			axisX: 1,
			axisY: 0,
			sign: -1,
		});
	});

	test("scene-file validation rejects mistyped or out-of-bounds rack params", async () => {
		const w = await fixture();
		const base = buildSceneFile(w.doc);
		const good = base.entities.find(
			(e): e is Extract<(typeof base.entities)[number], { kind: "joint" }> =>
				e.kind === "joint",
		);
		if (!good) throw new Error("joint missing");
		const bad = (patch: Record<string, unknown>) =>
			validateSceneFile({
				...base,
				entities: [
					{ ...good, params: { ...good.params, ...patch } } as typeof good,
				],
			}).ok;
		// ratio (the pitch radius) keeps the gear bounds: (0, maxHalfExtent].
		expect(bad({ ratio: 0 })).toBe(false);
		expect(bad({ ratio: -20 })).toBe(false);
		expect(bad({ ratio: Number.NaN })).toBe(false);
		expect(bad({ ratio: 1001 })).toBe(false);
		expect(bad({ ratio: "20" })).toBe(false);
		expect(bad({ ratio: 0.5 })).toBe(true);
		// The rack-local axis is a unit vector: components within [−1, 1].
		expect(bad({ axisX: 2 })).toBe(false);
		expect(bad({ axisX: Number.NaN })).toBe(false);
		expect(bad({ axisY: -1.5 })).toBe(false);
		// The coupling sign is ±1 exactly.
		expect(bad({ sign: 0 })).toBe(false);
		expect(bad({ sign: 2 })).toBe(false);
		expect(bad({ sign: -1 })).toBe(true);
	});
});
