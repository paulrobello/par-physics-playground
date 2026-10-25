/**
 * P4-T5 thruster: entity math (world pose), force application while on (and
 * none while off), off-center mount torque, removal cascade, param updates,
 * and rebuild fidelity through the ordinary document snapshot path.
 */
import { describe, expect, test } from "bun:test";
import { makeJoint } from "../../src/lib/joint";
import {
	clampThrusterDuration,
	THRUSTER_DEFAULT_STRENGTH,
	THRUSTER_MAX_DURATION,
	type ThrusterEntity,
	thrusterWorldPose,
} from "../../src/lib/thruster";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

/** Mount a thruster on a fresh free box at the world origin area. */
function mountThruster(
	world: PhysicsWorld,
	patch: Partial<ThrusterEntity> = {},
): void {
	world.spawnBox("tb", 0, -200, 10, 10);
	world.spawnThruster({
		kind: "thruster",
		id: "th",
		bodyId: "tb",
		anchorX: 0,
		anchorY: 0,
		angle: 0,
		strength: 12_000,
		on: true,
		...patch,
	});
}

/** Live linear velocity of a registered body (the debug API's probe shape). */
function linvel(world: PhysicsWorld, id: string): { x: number; y: number } {
	const v = world.bodies.get(id)?.linvel();
	return v ? { x: v.x, y: v.y } : { x: Number.NaN, y: Number.NaN };
}

describe("thruster pose math", () => {
	test("world pose follows the mounted body's rotation", () => {
		const pose = thrusterWorldPose(
			{
				kind: "thruster",
				id: "t",
				bodyId: "b",
				anchorX: 10,
				anchorY: 0,
				angle: Math.PI / 2,
				strength: 1,
				on: true,
			},
			{ x: 100, y: 200, rot: Math.PI / 2 },
		);
		// Anchor rotates with the body; world angle = body rot + local angle.
		expect(pose?.x).toBeCloseTo(100, 5);
		expect(pose?.y).toBeCloseTo(210, 5);
		expect(pose?.angle).toBeCloseTo(Math.PI, 5);
	});

	test("undefined pose when the transform is missing", () => {
		expect(
			thrusterWorldPose(
				{
					kind: "thruster",
					id: "t",
					bodyId: "b",
					anchorX: 0,
					anchorY: 0,
					angle: 0,
					strength: 1,
					on: true,
				},
				undefined,
			),
		).toBeUndefined();
	});
});

describe("thruster force application", () => {
	test("on: continuous force along the direction while running", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world);
		for (let i = 0; i < 30; i++) world.step();
		const v = linvel(world, "tb");
		// impulse = strength·dt per tick → dv = strength/mass per second.
		// Box 20×20 area 400, ink density 1 → mass 400; 0.5 s of ticks at
		// dv/s = 12000/400 = 30 → vx ≈ 15.
		expect(v?.x ?? 0).toBeGreaterThan(13);
	});

	test("off: no force, body keeps zero horizontal velocity", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world, { on: false });
		for (let i = 0; i < 60; i++) world.step();
		// No thrust → no x velocity (the body still falls — no floor here).
		expect(linvel(world, "tb")?.x ?? 1).toBe(0);
	});

	test("off-center mount point also torques the body", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world, { anchorX: 0, anchorY: -10 });
		for (let i = 0; i < 60; i++) world.step();
		// Thrust through a point above the centre line spins the box.
		expect(Math.abs(world.bodyRotation("tb") ?? 0)).toBeGreaterThan(0.05);
	});

	test("mounted body missing at spawn is refused", async () => {
		const world = await PhysicsWorld.create();
		expect(
			world.spawnThruster({
				kind: "thruster",
				id: "t",
				bodyId: "ghost",
				anchorX: 0,
				anchorY: 0,
				angle: 0,
				strength: THRUSTER_DEFAULT_STRENGTH,
				on: true,
			}),
		).toBe(false);
		expect(world.thrusterEntities()).toHaveLength(0);
	});
});

describe("thruster lifecycle", () => {
	test("deleting the body removes the mounted thruster (no orphans)", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world);
		world.removeBody("tb");
		expect(world.thrusterEntities()).toHaveLength(0);
	});

	test("updateThruster patch (panel path) changes the applied force", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world);
		expect(world.updateThruster("th", { on: false })).toBe(true);
		for (let i = 0; i < 30; i++) world.step();
		expect(linvel(world, "tb")?.x ?? 1).toBe(0);
		expect(world.updateThruster("th", { on: true, strength: 4000 })).toBe(true);
		for (let i = 0; i < 60; i++) world.step();
		// dv/s = 4000/400 = 10 → after 1 s of ticks, vx ≈ 10.
		expect(linvel(world, "tb")?.x ?? 0).toBeGreaterThan(8);
		expect(linvel(world, "tb")?.x ?? 0).toBeLessThan(12);
	});

	test("rebuild fidelity: undo restores the thruster", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world);
		// A pin joint holding a SEPARATE body, so the snapshot exercises both
		// entity kinds while the thruster's own body stays free to move.
		world.spawnBox("other", 300, -200, 10, 10);
		world.spawnJoint(
			makeJoint(
				"j",
				{ kind: "pin" },
				"other",
				null,
				{ x: 300, y: -200 },
				{
					x: 300,
					y: -200,
					rot: 0,
				},
				null,
			),
		);
		const undo = new UndoStack(
			() => world.doc.all(),
			(entities) => world.restoreSnapshot(entities),
		);
		undo.commit();
		undo.beginAction();
		world.removeBody("tb");
		undo.commit();
		expect(world.thrusterEntities()).toHaveLength(0);
		expect(undo.undo()).toBe(true);
		// Restored: thruster and joint both back, force flowing again.
		expect(world.thrusterEntities().map((t) => t.id)).toEqual(["th"]);
		expect(world.jointEntities().map((j) => j.id)).toEqual(["j"]);
		for (let i = 0; i < 30; i++) world.step();
		expect(linvel(world, "tb")?.x ?? 0).toBeGreaterThan(13);
	});
});

describe("thruster burn duration", () => {
	test("clampThrusterDuration normalizes panel/scene values", () => {
		expect(clampThrusterDuration(1.234)).toBe(1.23);
		expect(clampThrusterDuration(1.2)).toBe(1.2);
		expect(clampThrusterDuration(0.001)).toBe(0.01);
		expect(clampThrusterDuration(999)).toBe(THRUSTER_MAX_DURATION);
		expect(clampThrusterDuration(0)).toBeUndefined();
		expect(clampThrusterDuration(-1)).toBeUndefined();
		expect(clampThrusterDuration(Number.NaN)).toBeUndefined();
	});

	test("a thruster stops applying force once its duration burns out", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world, { duration: 0.05 });
		// 0.05 s = 3 thrusting ticks, then coasting: velocity plateaus.
		for (let i = 0; i < 6; i++) world.step();
		const vx = linvel(world, "tb")?.x ?? 0;
		expect(vx).toBeGreaterThan(0);
		expect(world.thrusterFiring("th")).toBe(false);
		for (let i = 0; i < 3; i++) world.step();
		expect(linvel(world, "tb")?.x ?? 0).toBeCloseTo(vx, 9);

		// A duration edit restarts the countdown: firing (and accelerating) again.
		expect(world.updateThruster("th", { duration: 0.05 })).toBe(true);
		expect(world.thrusterFiring("th")).toBe(true);
		const before = linvel(world, "tb")?.x ?? 0;
		for (let i = 0; i < 2; i++) world.step();
		expect(linvel(world, "tb")?.x ?? 0).toBeGreaterThan(before);
	});

	test("restore replays the burn: the elapsed clock is sim state, not document data", async () => {
		const world = await PhysicsWorld.create();
		mountThruster(world, { duration: 0.05 });
		for (let i = 0; i < 6; i++) world.step();
		expect(world.thrusterFiring("th")).toBe(false);
		world.restoreSnapshot(world.doc.all());
		// The rebuilt world starts the burn window fresh.
		expect(world.thrusterFiring("th")).toBe(true);
	});
});
