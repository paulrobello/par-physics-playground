/**
 * P4-T3 motor joint: placement params, Rapier materialization (powered
 * revolute), toggle semantics (off = plain revolute; flipping on spins),
 * stall at the maxTorque cap under a gravity load, and rebuild fidelity
 * (motor state survives undo/redo through the ordinary document snapshot
 * path).
 */
import { describe, expect, test } from "bun:test";
import {
	clampMotorVelocity,
	MOTOR_DEFAULT_TORQUE,
	MOTOR_DEFAULT_VELOCITY,
	MOTOR_MAX_VELOCITY,
	makeJoint,
	makePlacedJoint,
	type PlaceableJointKind,
} from "../../src/lib/joint";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

const A = { x: 0, y: -200, rot: 0 };

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

/** Free motorized wheel: circle pinned at its center, anchored to the world. */
function placeWheelMotor(
	world: PhysicsWorld,
	targetVelocity: number,
	maxTorque: number,
	on: boolean,
): void {
	world.spawnCircle("wheel", 0, -200, 20);
	world.spawnJoint(
		makeJoint(
			"jm",
			{ kind: "motor", targetVelocity, maxTorque, on },
			"wheel",
			null,
			{ x: 0, y: -200 },
			A,
			null,
		),
	);
}

/**
 * Rotation accumulator for body `id`: Rapier's `rotation()` wraps to [−π, π],
 * so a spinning body's net angle must be unwrapped from per-tick deltas.
 * Returns [net rotation in rad, final angvel].
 */
function spinMeasurement(
	world: PhysicsWorld,
	id: string,
	ticks: number,
): [number, number] {
	let net = 0;
	let prev = world.bodyRotation(id) ?? 0;
	for (let i = 0; i < ticks; i++) {
		world.step();
		const r = world.bodyRotation(id) ?? 0;
		let d = r - prev;
		while (d > Math.PI) d -= 2 * Math.PI;
		while (d < -Math.PI) d += 2 * Math.PI;
		net += d;
		prev = r;
	}
	return [net, world.bodies.get(id)?.angvel() ?? 0];
}

describe("motor placement math", () => {
	test("motor takes default drive params, ON, with pin-coincident pivots", () => {
		const B = { x: 40, y: -10, rot: 0.7 };
		const e = makePlacedJoint(
			"m",
			"motor",
			"a",
			"b",
			{ x: 3, y: -3 },
			{ x: 20, y: 30 },
			A,
			B,
		);
		if (!e) throw new Error("refused");
		if (e.params.kind !== "motor") throw new Error("kind");
		expect(e.params.targetVelocity).toBe(MOTOR_DEFAULT_VELOCITY);
		expect(e.params.maxTorque).toBe(MOTOR_DEFAULT_TORQUE);
		expect(e.params.on).toBe(true);
		// Both anchors read back to the SAME world point (the second click):
		// the powered-pin semantics.
		const wa = local(e.anchorA, A);
		const wb = local(e.anchorB, B);
		expect(wa.x).toBeCloseTo(20, 9);
		expect(wa.y).toBeCloseTo(30, 9);
		expect(wb.x).toBeCloseTo(20, 9);
		expect(wb.y).toBeCloseTo(30, 9);
	});

	test("makePlacedJoint refuses the stroke-placed rope kind (no two-click attach)", () => {
		// Rope placement is the freehand stroke path (P4-T4); the cast reaches
		// the runtime refusal branch of the two-click builder.
		const rope = makePlacedJoint(
			"rope",
			"rope" as PlaceableJointKind,
			"a",
			null,
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			A,
			null,
		);
		expect(rope).toBeUndefined();
	});
});

describe("motor materialization", () => {
	test("a balanced wheel tracks targetVelocity (rad/s) at a high torque cap", async () => {
		const world = await PhysicsWorld.create();
		placeWheelMotor(world, 5, 1_000_000, true);
		// Settle past the torque-limited spin-up (α = cap/I ≈ 4 rad/s² →
		// ~1.3 s), then measure a full second window: sustained ω = target.
		spinMeasurement(world, "wheel", 120);
		const [net, angvel] = spinMeasurement(world, "wheel", 60);
		// 1 s at 5 rad/s = 5 rad net.
		expect(Math.abs(net - 5)).toBeLessThan(0.3);
		expect(angvel).toBeCloseTo(5, 1);
	}, 10_000);

	test("toggle semantics: on=false is a plain revolute; flipping on spins", async () => {
		const world = await PhysicsWorld.create();
		placeWheelMotor(world, 5, 1_000_000, false);
		// A balanced wheel with no motor torque never rotates: the y-down
		// gravity torque about the center pivot is exactly zero.
		const [off, wOff] = spinMeasurement(world, "wheel", 120);
		expect(off).toBeCloseTo(0, 6);
		expect(wOff).toBeCloseTo(0, 6);
		// Flip on through the panel path: the impulse joint is replaced and
		// the wheel spins up to the target (settle past spin-up first).
		expect(
			world.updateJointParams("jm", {
				kind: "motor",
				targetVelocity: 5,
				maxTorque: 1_000_000,
				on: true,
			}),
		).toBe(true);
		spinMeasurement(world, "wheel", 120);
		const [net, angvel] = spinMeasurement(world, "wheel", 60);
		expect(Math.abs(net - 5)).toBeLessThan(0.3);
		expect(angvel).toBeCloseTo(5, 1);
	}, 10_000);

	test("maxTorque caps the drive: a heavy unbalanced load stalls the motor", async () => {
		const world = await PhysicsWorld.create();
		// Wheel with a box welded at the rim: gravity torque about the pivot
		// reaches 36·9.81·30 ≈ 10.6k. A 1e6 cap drives it; a 1k cap stalls.
		// The two assemblies sit 150 units apart — overlapped wheels would
		// jam each other's colliders (measured: both froze at ~5 rad/s apart).
		for (const [maxTorque, x] of [
			[1_000_000, 0],
			[1_000, 150],
		] as const) {
			const suffix = maxTorque === 1_000_000 ? "hi" : "lo";
			const transformA = { x, y: -200, rot: 0 };
			world.spawnCircle(`wheel-${suffix}`, x, -200, 20);
			world.spawnBox(`bob-${suffix}`, x + 30, -200, 3, 3);
			world.spawnJoint(
				makeJoint(
					`jw-${suffix}`,
					{ kind: "weld", relRot: 0 },
					`wheel-${suffix}`,
					`bob-${suffix}`,
					{ x: x + 30, y: -200 },
					transformA,
					{ x: x + 30, y: -200, rot: 0 },
				),
			);
			world.spawnJoint(
				makeJoint(
					`jm-${suffix}`,
					{ kind: "motor", targetVelocity: 5, maxTorque, on: true },
					`wheel-${suffix}`,
					null,
					{ x, y: -200 },
					transformA,
					null,
				),
			);
		}
		// hi wheel: [0,2] s settles it past its spin-up; the measured window
		// is [2,4] s. lo wheel: the same two windows (helper steps the world
		// as it measures, so the two runs share the one physics timeline).
		spinMeasurement(world, "wheel-hi", 120);
		const [netHi] = spinMeasurement(world, "wheel-hi", 60);
		spinMeasurement(world, "wheel-lo", 120);
		const [netLo] = spinMeasurement(world, "wheel-lo", 60);
		// High cap: sustained rotation ≈ 5 rad over the window (load is ~10×
		// under the cap; the bob's sinusoidal gravity torque modulates the
		// per-window average slightly). Low cap: stalled — under the 10.6k
		// gravity torque the wheel creeps by a fraction of the free run.
		expect(netHi).toBeGreaterThan(4);
		expect(Math.abs(netLo)).toBeLessThan(1);
	}, 10_000);

	test("rebuild fidelity: motor state survives undo/redo and keeps driving", async () => {
		const world = await PhysicsWorld.create();
		placeWheelMotor(world, 5, 1_000_000, true);
		world.syncLiveTransforms();
		const undo = new UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => world.restoreSnapshot(entities),
		);
		undo.commit();
		// A real params edit inside ONE undo boundary: target velocity 5 → 6.
		undo.beginAction();
		expect(
			world.updateJointParams("jm", {
				kind: "motor",
				targetVelocity: 6,
				maxTorque: 1_000_000,
				on: true,
			}),
		).toBe(true);
		undo.commit();
		// The edit took effect: settle past spin-up, then confirm 6 rad/s.
		spinMeasurement(world, "wheel", 120);
		const [edited] = spinMeasurement(world, "wheel", 60);
		expect(edited).toBeGreaterThan(5.7);
		// Undo restores the 5-rad/s motor through the snapshot rebuild.
		expect(undo.undo()).toBe(true);
		const entity = world.doc.get("jm");
		if (!entity || entity.kind !== "joint") throw new Error("entity missing");
		if (entity.params.kind !== "motor") throw new Error("kind");
		expect(entity.params.targetVelocity).toBe(5);
		expect(entity.params.on).toBe(true);
		expect(world.joints.get("jm")).toBeDefined();
		// Redo re-applies the 6-rad/s edit; the rebuilt motor still drives.
		expect(undo.redo()).toBe(true);
		const redone = world.doc.get("jm");
		if (!redone || redone.kind !== "joint") throw new Error("entity missing");
		if (redone.params.kind !== "motor") throw new Error("kind");
		expect(redone.params.targetVelocity).toBe(6);
		// The rebuild starts the wheel at rest (snapshot restore resets sim
		// state), so settle past spin-up before the drive assertion.
		spinMeasurement(world, "wheel", 120);
		const [net, angvel] = spinMeasurement(world, "wheel", 120);
		expect(net / 2).toBeCloseTo(6, 0);
		expect(angvel).toBeCloseTo(6, 1);
	}, 10_000);
});

describe("motor velocity clamp", () => {
	test("the panel ceiling clamps both signs; in-band values pass through", () => {
		expect(clampMotorVelocity(1e9)).toBe(MOTOR_MAX_VELOCITY);
		expect(clampMotorVelocity(-1e9)).toBe(-MOTOR_MAX_VELOCITY);
		expect(clampMotorVelocity(MOTOR_DEFAULT_VELOCITY)).toBe(
			MOTOR_DEFAULT_VELOCITY,
		);
		expect(clampMotorVelocity(-250)).toBe(-MOTOR_MAX_VELOCITY);
		expect(clampMotorVelocity(MOTOR_MAX_VELOCITY)).toBe(MOTOR_MAX_VELOCITY);
		// Non-finite input never becomes a NaN param (reads as 0).
		expect(clampMotorVelocity(Number.NaN)).toBe(0);
	});
});
