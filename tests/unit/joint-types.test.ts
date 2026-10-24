/**
 * P4-T2 joint types: placement builders (makePlacedJoint — params math,
 * y-down slider axis, rod endpoints), Rapier materialization (weld = fixed,
 * rod = stiff spring, slider = prismatic with limits), the rebuild-refusal
 * rule (loud, no silent doc drop), per-type physical behavior under the
 * fixed-step sim (weld rigidity, rod length holding, slider on-axis limits),
 * and params editing through updateJointParams + undo.
 */
import { describe, expect, test } from "bun:test";
import {
	isPlaceableJointKind,
	makeJoint,
	makePlacedJoint,
} from "../../src/lib/joint";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

/** Local anchor → world (mirrors localPointToWorld for readability). */
function local(
	l: { x: number; y: number },
	t: { x: number; y: number; rot: number },
): { x: number; y: number } {
	const cos = Math.cos(t.rot);
	const sin = Math.sin(t.rot);
	return {
		x: t.x + l.x * cos - l.y * sin,
		y: t.y + l.x * sin + l.y * cos,
	};
}

const A = { x: 0, y: 0, rot: 0 };
const B = { x: 40, y: -10, rot: 0.7 };

describe("makePlacedJoint placement math", () => {
	test("pin and weld keep coincident anchors at the second click", () => {
		for (const kind of ["pin", "weld"] as const) {
			const e = makePlacedJoint(
				"j",
				kind,
				"a",
				"b",
				{ x: 3, y: -3 },
				{ x: 20, y: 30 },
				A,
				B,
			);
			if (!e) throw new Error("refused");
			const wa = local(e.anchorA, A);
			const wb = local(e.anchorB, B);
			expect(wa.x).toBeCloseTo(20, 9);
			expect(wa.y).toBeCloseTo(30, 9);
			expect(Math.abs(wb.x - 20)).toBeLessThan(1e-6);
			expect(wb.y).toBeCloseTo(30, 9);
		}
	});

	test("weld stores the placement relative rotation (rotB − rotA)", () => {
		const e = makePlacedJoint(
			"j",
			"weld",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 20, y: 30 },
			A,
			B,
		);
		if (!e) throw new Error("refused");
		if (e.params.kind !== "weld") throw new Error("kind");
		expect(e.params.relRot).toBeCloseTo(0.7, 9);
	});

	test("slider axis: world click direction → bodyA-local (y-down math)", () => {
		// Unrotated body: a world 45° down-right axis stays (0.707, 0.707).
		const flat = makePlacedJoint(
			"s",
			"slider",
			"a",
			null,
			{ x: -30, y: -30 },
			{ x: 0, y: 0 },
			A,
			null,
		);
		if (!flat) throw new Error("refused");
		if (flat.params.kind !== "slider") throw new Error("kind");
		expect(flat.params.axisX).toBeCloseTo(Math.SQRT1_2, 9);
		expect(flat.params.axisY).toBeCloseTo(Math.SQRT1_2, 9);
		expect(flat.params.min).toBe(-100);
		expect(flat.params.max).toBe(100);
		// BodyA rotated +90° (y-down world): world +x reads as local (0, −1).
		const rot = makePlacedJoint(
			"s2",
			"slider",
			"a",
			null,
			{ x: -30, y: 0 },
			{ x: 0, y: 0 },
			{ x: 0, y: 0, rot: Math.PI / 2 },
			null,
		);
		if (!rot) throw new Error("refused");
		if (rot.params.kind !== "slider") throw new Error("kind");
		expect(rot.params.axisX).toBeCloseTo(0, 9);
		expect(rot.params.axisY).toBeCloseTo(-1, 9);
	});

	test("degenerate slider clicks default the axis to +x", () => {
		const e = makePlacedJoint(
			"s",
			"slider",
			"a",
			null,
			{ x: 5, y: 5 },
			{ x: 5, y: 5 },
			A,
			null,
		);
		if (!e) throw new Error("refused");
		if (e.params.kind !== "slider") throw new Error("kind");
		expect(e.params.axisX).toBeCloseTo(1, 9);
		expect(e.params.axisY).toBeCloseTo(0, 9);
	});

	test("rod uses the two clicks as ENDPOINTS and derives its length", () => {
		const e = makePlacedJoint(
			"r",
			"rod",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 30, y: 40 },
			A,
			B,
		);
		if (!e) throw new Error("refused");
		if (e.params.kind !== "rod") throw new Error("kind");
		expect(e.params.length).toBeCloseTo(50, 9);
		const wa = local(e.anchorA, A);
		const wb = local(e.anchorB, B);
		expect(wa.x).toBeCloseTo(0, 9);
		expect(wa.y).toBeCloseTo(0, 9);
		expect(wb.x).toBeCloseTo(30, 9);
		expect(wb.y).toBeCloseTo(40, 9);
	});

	test("makePlacedJoint takes only placeable kinds (type-level union)", () => {
		// The runtime refusal for unmaterialized types lives in spawnJoint
		// (materialization describe); the builder's union excludes them by
		// construction — assert the guard helper instead.
		expect(isPlaceableJointKind("motor")).toBe(true);
		expect(isPlaceableJointKind("spring")).toBe(true);
		expect(isPlaceableJointKind("rope")).toBe(true);
		expect(isPlaceableJointKind("rod")).toBe(true);
	});
});

describe("joint type materialization", () => {
	test("all seven joint types materialize (P4-T4 completes the union)", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("a", 0, -200, 10, 10, undefined, true);
		world.spawnBox("b", 20, -200, 10, 10);
		expect(
			world.spawnJoint(
				makeJoint(
					"jw",
					{ kind: "weld", relRot: 0 },
					"a",
					"b",
					{ x: 10, y: -200 },
					{ x: 0, y: -200, rot: 0 },
					{ x: 20, y: -200, rot: 0 },
				),
			),
		).toBe(true);
		expect(
			world.spawnJoint(
				makeJoint(
					"jr",
					{ kind: "rod", length: 40 },
					"b",
					null,
					{ x: 20, y: -200 },
					{ x: 20, y: -200, rot: 0 },
					null,
					{ x: 20, y: -160 },
				),
			),
		).toBe(true);
		expect(
			world.spawnJoint(
				makeJoint(
					"js",
					{ kind: "slider", axisX: 1, axisY: 0, min: -50, max: 50 },
					"b",
					null,
					{ x: 20, y: -200 },
					{ x: 20, y: -200, rot: 0 },
					null,
				),
			),
		).toBe(true);
		expect(world.joints.size).toBe(3);
		// Motor (P4-T3) materializes.
		expect(
			world.spawnJoint(
				makeJoint(
					"jm",
					{ kind: "motor", targetVelocity: 2, maxTorque: 500_000, on: true },
					"b",
					null,
					{ x: 0, y: 0 },
					{ x: 0, y: 0, rot: 0 },
					null,
				),
			),
		).toBe(true);
		expect(world.joints.size).toBe(4);
		// P4-T4: the spring materializes — the params union is complete.
		expect(
			world.spawnJoint(
				makeJoint(
					"jsp",
					{
						kind: "spring",
						restLength: 10,
						stiffness: 1600,
						damping: 80,
					},
					"b",
					null,
					{ x: 0, y: 0 },
					{ x: 0, y: 0, rot: 0 },
					null,
				),
			),
		).toBe(true);
		expect(world.joints.size).toBe(5);
		// And the rope link: max-distance-only is exactly a rope link (it
		// pulls, never pushes) — the chain approach's constraint.
		expect(
			world.spawnJoint(
				makeJoint(
					"jrope",
					{ kind: "rope", length: 2 },
					"a",
					"b",
					{ x: 10, y: -200 },
					{ x: 0, y: -200, rot: 0 },
					{ x: 20, y: -200, rot: 0 },
				),
			),
		).toBe(true);
		expect(world.joints.size).toBe(6);
		expect(world.doc.joints().length).toBe(6);
	}, 10_000);
});

describe("weld rigidity", () => {
	test("a welded pair falls as one rigid unit, preserving the placed relative rotation", async () => {
		const world = await PhysicsWorld.create();
		// Adjacent boxes (edges touching at x=10), rotated differently: a rigid
		// weld must NOT snap the rotations equal.
		world.spawnBox("a", 0, -200, 10, 10, undefined, false);
		world.spawnBox("b", 20, -200, 10, 10, undefined, false);
		world.rotateBody("a", 0.3);
		world.rotateBody("b", -0.5);
		world.spawnJoint(
			makeJoint(
				"jw",
				{ kind: "weld", relRot: -0.8 },
				"a",
				"b",
				{ x: 10, y: -200 },
				{ x: 0, y: -200, rot: 0.3 },
				{ x: 20, y: -200, rot: -0.5 },
			),
		);
		for (let i = 0; i < 120; i++) world.step();
		const rotA = world.bodyRotation("a") ?? 9;
		const rotB = world.bodyRotation("b") ?? 9;
		expect(rotB - rotA).toBeCloseTo(-0.8, 1);
		// Rigid: the center distance stays at the placed 20 (±solver slop).
		const pa = world.bodyPosition("a");
		const pb = world.bodyPosition("b");
		if (!pa || !pb) throw new Error("bodies missing");
		expect(Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeCloseTo(20, 0);
		// And the pair fell.
		expect(pa.y).toBeGreaterThan(-200);
	}, 10_000);
});

describe("rod holds distance", () => {
	test("hanging body keeps the anchor distance (stiff spring, sag < 0.5)", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("a", 0, -200, 10, 10, undefined, true);
		world.spawnBox("b", 0, -120, 10, 10);
		world.spawnJoint(
			makeJoint(
				"jr",
				{ kind: "rod", length: 80 },
				"a",
				"b",
				{ x: 0, y: -200 },
				{ x: 0, y: -200, rot: 0 },
				{ x: 0, y: -120, rot: 0 },
				{ x: 0, y: -120 },
			),
		);
		for (let i = 0; i < 120; i++) world.step();
		const pa = world.bodyPosition("a");
		const pb = world.bodyPosition("b");
		if (!pa || !pb) throw new Error("bodies missing");
		// The rod anchors sit at the two body centers; the spring holds the
		// distance to the placed 80 within solver slop.
		expect(Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeCloseTo(80, 0);
		// The load actually hung (the constraint carried weight, distance held
		// from ABOVE as well as below — the rope joint could not do this).
		expect(pb.y).toBeGreaterThan(-121);
	}, 10_000);
});

describe("slider on-axis limits", () => {
	test("gravity slides the rider along the 45° axis to the +limit and holds it there", async () => {
		const world = await PhysicsWorld.create();
		// Static base + rider centered on the shared pivot, 45° world axis
		// (down-right in the y-down world), tight +limit so the run reaches it.
		world.spawnBox("base", 0, -150, 2, 2, undefined, true);
		world.spawnBox("rider", 0, -150, 10, 10);
		world.spawnJoint(
			makeJoint(
				"js",
				{
					kind: "slider",
					axisX: Math.SQRT1_2,
					axisY: Math.SQRT1_2,
					min: -100,
					max: 10,
				},
				"base",
				"rider",
				{ x: 0, y: -150 },
				{ x: 0, y: -150, rot: 0 },
				{ x: 0, y: -150, rot: 0 },
			),
		);
		for (let i = 0; i < 240; i++) world.step();
		const pr = world.bodyPosition("rider");
		if (!pr) throw new Error("rider missing");
		// Slide coordinate along the 45° axis FROM THE PIVOT (0, −150),
		// clamped to the +10 limit: expected rest = pivot + 10·(0.707, 0.707).
		const along = (pr.x + pr.y + 150) * Math.SQRT1_2;
		const perp = (-pr.x + pr.y + 150) * Math.SQRT1_2;
		expect(along).toBeCloseTo(10, 0);
		// On-axis: perpendicular displacement stays ~0 (the prismatic locks
		// the perpendicular translation — y-down world, gravity has a +axis
		// component only).
		expect(Math.abs(perp)).toBeLessThan(0.2);
	}, 10_000);
});

describe("updateJointParams", () => {
	test("rod length edit re-materializes the joint and undo restores it", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("a", 0, -200, 10, 10, undefined, true);
		world.spawnBox("b", 0, -120, 10, 10);
		expect(
			world.spawnJoint(
				makeJoint(
					"jr",
					{ kind: "rod", length: 80 },
					"a",
					"b",
					{ x: 0, y: -200 },
					{ x: 0, y: -200, rot: 0 },
					{ x: 0, y: -120, rot: 0 },
					{ x: 0, y: -120 },
				),
			),
		).toBe(true);
		world.syncLiveTransforms();
		const undo = new UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => world.restoreSnapshot(entities),
		);
		undo.commit();
		// Panel edit path (one begin/commit boundary): length 80 -> 40. The
		// impulse joint is replaced; the document entity carries the new params.
		undo.beginAction();
		expect(world.updateJointParams("jr", { kind: "rod", length: 40 })).toBe(
			true,
		);
		undo.commit();
		expect(world.joints.get("jr")).toBeDefined();
		const entity = world.doc.get("jr");
		if (!entity || entity.kind !== "joint") throw new Error("entity missing");
		if (entity.params.kind !== "rod") throw new Error("kind");
		expect(entity.params.length).toBe(40);
		// The edited constraint holds the NEW length in the sim.
		for (let i = 0; i < 120; i++) world.step();
		const pa = world.bodyPosition("a");
		const pb = world.bodyPosition("b");
		if (!pa || !pb) throw new Error("bodies missing");
		expect(Math.hypot(pb.x - pa.x, pb.y - pa.y)).toBeCloseTo(40, 0);
		// Undo restores the 80-length rod (rebuild from the snapshot entity).
		expect(undo.undo()).toBe(true);
		const restored = world.doc.get("jr");
		if (!restored || restored.kind !== "joint")
			throw new Error("entity missing");
		if (restored.params.kind !== "rod") throw new Error("kind");
		expect(restored.params.length).toBe(80);
		expect(world.joints.get("jr")).toBeDefined();
	}, 10_000);
});
