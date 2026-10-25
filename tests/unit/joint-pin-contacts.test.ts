/**
 * Pin contacts policy: a TWO-BODY pin joins bodies that usually overlap
 * (wheel on mount, axle in a socket) — the same contact-vs-constraint fight
 * the motor/slider/rope rule silences (world.ts spawnJoint): contact
 * impulses at the overlap dwarf any drive and lock the pin (regression:
 * pinned circle + tangential rocket thruster froze at 2.1e6 contact
 * impulses vs ~167/tick of thrust). So two-body pins materialize with the
 * joined pair's contacts OFF. World-anchored pins (bodyB null → the GROUND
 * body) keep contacts — the pinned body must still hit the floor — unless
 * the explicit rope-capture `contactsOff` flag says otherwise (that flag
 * stays honored for save compatibility).
 *
 * All sims are fixed-tick deterministic with ZERO gravity, so any motion is
 * thruster-driven and rotation is unambiguous.
 */
import { describe, expect, test } from "bun:test";
import { makeJoint } from "../../src/lib/joint";
import type { ThrusterEntity } from "../../src/lib/thruster";
import { PhysicsWorld } from "../../src/lib/world";

/** Assembly height: clear of the ground slab (top y=0) — zero-g sims must
 * not touch it (a circle crossing the slab band picks up ground friction). */
const RIG_Y = -200;

/** Unwrapped net rotation of a body over `ticks` fixed steps (rad). */
function netRotation(world: PhysicsWorld, id: string, ticks: number): number {
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
	return net;
}

function tangentialThruster(bodyId: string, strength = 10_000): ThrusterEntity {
	// Rim mount at local (40, 0), firing +y-local: tangential at placement.
	return {
		kind: "thruster",
		id: `th-${bodyId}`,
		bodyId,
		anchorX: 40,
		anchorY: 0,
		angle: Math.PI / 2,
		strength,
		on: true,
	};
}

/** Static square (half 60 at origin-relative) with a circle pinned onto it. */
function pinnedWheel(
	world: PhysicsWorld,
	circleX: number,
	pivotX: number,
): string {
	const id = circleX === 0 ? "axle" : "wheel";
	world.spawnBox("mount", 0, RIG_Y, 60, 60, undefined, true);
	world.spawnCircle(id, circleX, RIG_Y, 40);
	world.spawnJoint(
		makeJoint(
			"pin",
			{ kind: "pin" },
			id,
			"mount",
			{ x: pivotX, y: RIG_Y },
			{ x: circleX, y: RIG_Y, rot: 0 },
			{ x: 0, y: RIG_Y, rot: 0 },
		),
	);
	world.spawnThruster(tangentialThruster(id));
	return id;
}

describe("pin contacts policy (spawnJoint)", () => {
	test("two-body pin materializes contacts-off for the joined pair", async () => {
		const world = await PhysicsWorld.create();
		world.setGravity(0, 0);
		pinnedWheel(world, 45, 20);
		expect(world.joints.get("pin")?.contactsEnabled()).toBe(false);
	}, 10_000);

	test("regression: pinned overlapping wheel spins under tangential thrust", async () => {
		const world = await PhysicsWorld.create();
		world.setGravity(0, 0);
		const id = pinnedWheel(world, 45, 20);
		// The pivot (20,0) is off the circle center (45,0): thrust spins AND
		// orbits the wheel like a crank. The pin must hold the pair together
		// while the thrust turns it — contacts at the overlap must not lock it.
		// Measured (fixed-tick, zero-g): locked ≈ 0.00001 rad, free ≈ 4.5 rad.
		const net = netRotation(world, id, 600);
		const angvel = world.bodies.get(id)?.angvel() ?? 0;
		expect(Math.abs(net)).toBeGreaterThan(1);
		expect(Math.abs(angvel)).toBeGreaterThan(0.5);
	}, 10_000);

	test("regression: centered axle on an overlapping mount spins", async () => {
		const world = await PhysicsWorld.create();
		world.setGravity(0, 0);
		const id = pinnedWheel(world, 0, 0);
		// Pure spin (pivot at the circle center): the unambiguous signal that
		// the pair contact, not the drive, was the blocker. Measured: locked
		// ≈ 0.00001 rad, free ≈ 4.98 rad over 600 ticks.
		const net = netRotation(world, id, 600);
		expect(Math.abs(net)).toBeGreaterThan(1);
	}, 10_000);

	test("pin silences only the joined pair: a third body still collides", async () => {
		const world = await PhysicsWorld.create();
		world.setGravity(0, 0);
		pinnedWheel(world, 45, 20);
		// Free circle overlapping the wheel's rim (wheel spans to x=85).
		world.spawnCircle("debris", 88, RIG_Y, 10);
		for (let i = 0; i < 30; i++) world.step();
		// Rapier pushes the overlap apart along +x; the wheel is joint-held.
		const x = world.bodyPosition("debris")?.x ?? 0;
		expect(x).toBeGreaterThan(89);
	}, 10_000);

	test("world-anchored pin keeps contacts: the pinned body still rests on the ground", async () => {
		const world = await PhysicsWorld.create();
		// Default gravity: box resting on the ground slab (top y=0), pinned to
		// the world. Ground contact must hold it up — disabling the pair would
		// drop it through the floor.
		world.spawnBox("hanger", 0, -10, 10, 10);
		world.spawnJoint(
			makeJoint(
				"hpin",
				{ kind: "pin" },
				"hanger",
				null,
				{ x: 0, y: -10 },
				{ x: 0, y: -10, rot: 0 },
				null,
			),
		);
		expect(world.joints.get("hpin")?.contactsEnabled()).toBe(true);
		for (let i = 0; i < 240; i++) world.step();
		const y = world.bodyPosition("hanger")?.y ?? Number.NaN;
		expect(y).toBeLessThan(-5);
	}, 10_000);

	test("explicit contactsOff flag stays honored (rope-capture save compat)", async () => {
		const world = await PhysicsWorld.create();
		world.setGravity(0, 0);
		world.spawnBox("mount", 0, 0, 60, 60, undefined, true);
		world.spawnCircle("wheel", 45, 0, 40);
		world.spawnJoint(
			makeJoint(
				"flagpin",
				{ kind: "pin", contactsOff: true },
				"wheel",
				"mount",
				{ x: 20, y: 0 },
				{ x: 45, y: 0, rot: 0 },
				{ x: 0, y: 0, rot: 0 },
			),
		);
		expect(world.joints.get("flagpin")?.contactsEnabled()).toBe(false);
	}, 10_000);
});
