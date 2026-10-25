import { describe, expect, test } from "bun:test";
import { SIM_DT_SECONDS } from "../../src/lib/clock";
import {
	BURN_SECONDS,
	EXHAUST_IGNITION_REACH,
	isBurnedOut,
} from "../../src/lib/flammable";
import { validateSceneFile } from "../../src/lib/scene-file";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * Flammable materials extra: thruster-exhaust ignition, contact spread while
 * burning, the fixed burn that ends in body removal, and the scene-file flag
 * round-trip. Fire state is runtime-only — asserted here through the
 * restoreSnapshot extinguish (a reload mid-fire does not stay lit).
 *
 * Geometry convention in these tests (y-down world, world.ts): the thruster
 * mounts on a static "mount" box at the origin area with thrust angle 0
 * (+x), so the exhaust ray shoots −x; every target sits on that beam.
 */

const PAPER = {
	id: "paper",
	name: "Paper",
	color: "#e8dcc8",
	density: 1,
	friction: 0.5,
	restitution: 0.1,
	flammable: true,
};

const BURN_TICKS = Math.ceil(BURN_SECONDS / SIM_DT_SECONDS);

async function flammableWorld(): Promise<PhysicsWorld> {
	const world = await PhysicsWorld.create();
	world.setGravity(0, 0);
	world.doc.addMaterial({ ...PAPER });
	return world;
}

/** Static mount box at (0, -10) with a firing thruster exhausting −x. */
function mountThruster(world: PhysicsWorld): void {
	world.spawnBox("mount", 0, -10, 1, 1, "ink", true);
	world.spawnThruster({
		kind: "thruster",
		id: "th",
		bodyId: "mount",
		anchorX: 0,
		anchorY: 0,
		angle: 0,
		strength: 10_000,
		on: true,
	});
}

function tick(world: PhysicsWorld, n: number): void {
	for (let i = 0; i < n; i++) world.step();
}

describe("flammable constants", () => {
	test("owner-approved spec values are pinned", () => {
		expect(BURN_SECONDS).toBe(4);
		expect(EXHAUST_IGNITION_REACH).toBeGreaterThan(0);
	});

	test("burn-out comparison tolerates accumulated tick fractions", () => {
		expect(isBurnedOut(BURN_SECONDS)).toBe(true);
		expect(isBurnedOut(BURN_SECONDS - SIM_DT_SECONDS * 2)).toBe(false);
	});
});

describe("thruster exhaust ignition", () => {
	test("exhaust ignites a flammable body in reach; fixed burn consumes it", async () => {
		const world = await flammableWorld();
		mountThruster(world);
		world.spawnBox("page1", -8, -10, 1, 1, "paper");
		expect(world.isBurning("page1")).toBe(false);
		tick(world, 1);
		expect(world.isBurning("page1")).toBe(true);
		expect(world.isBurning("mount")).toBe(false);
		tick(world, BURN_TICKS - 2);
		expect(world.bodies.has("page1")).toBe(true);
		tick(world, 2);
		expect(world.bodies.has("page1")).toBe(false);
		expect(world.doc.get("page1")).toBeUndefined();
	}, 10_000);

	test("out-of-reach flammable body never ignites", async () => {
		const world = await flammableWorld();
		mountThruster(world);
		// Near face at −19: beyond EXHAUST_IGNITION_REACH from the mount.
		world.spawnBox("far", -20, -10, 1, 1, "paper");
		tick(world, 30);
		expect(world.isBurning("far")).toBe(false);
		expect(world.bodies.has("far")).toBe(true);
	}, 10_000);

	test("a non-flammable body blocks the exhaust", async () => {
		const world = await flammableWorld();
		mountThruster(world);
		world.spawnBox("wall", -4, -10, 1, 1, "ink", true);
		world.spawnBox("behind", -8, -10, 1, 1, "paper");
		tick(world, 30);
		expect(world.isBurning("behind")).toBe(false);
	}, 10_000);
});

describe("contact spread while burning", () => {
	test("a burning body ignites the body resting on it; a distant one stays unlit", async () => {
		// Gravity ON for this one: A rests ON TOP of B, so the A↔B contact
		// carries A's weight every tick and the armed pair keeps producing
		// the contact-force events the spread drain needs (zero-g
		// barely-touching boxes separate within a tick or two and the
		// pairing dies).
		const world = await PhysicsWorld.create();
		world.doc.addMaterial({ ...PAPER });
		// The static mount sits ON the ground line here so its beam (y = −1)
		// grazes the resting boxes.
		world.spawnBox("mount", 0, -1, 1, 1, "ink", true);
		world.spawnThruster({
			kind: "thruster",
			id: "th",
			bodyId: "mount",
			anchorX: 0,
			anchorY: 0,
			angle: 0,
			strength: 10_000,
			on: true,
		});
		// The beam (y = −1) grazes B (spans y ∈ [−2, 0]) and never reaches A
		// (spans y ∈ [−4, −2]): B ignites from the exhaust ray, A only
		// through the contact spread.
		world.spawnBox("B", -4, -1, 1, 1, "paper");
		world.spawnBox("A", -4, -3, 1, 1, "paper");
		world.spawnBox("C", 20, -1, 1, 1, "paper");
		tick(world, 2);
		expect(world.isBurning("B")).toBe(true);
		expect(world.isBurning("A")).toBe(true);
		expect(world.isBurning("C")).toBe(false);
		// A ignited about one tick after B: both burn out within the same
		// generous window, and untouched C survives.
		tick(world, BURN_TICKS);
		expect(world.bodies.has("A")).toBe(false);
		expect(world.bodies.has("B")).toBe(false);
		expect(world.bodies.has("C")).toBe(true);
	}, 10_000);
});

describe("fire state is runtime-only", () => {
	test("restoreSnapshot extinguishes; the restored scene re-ignites naturally", async () => {
		const world = await flammableWorld();
		mountThruster(world);
		world.spawnBox("page1", -8, -10, 1, 1, "paper");
		tick(world, 2);
		expect(world.isBurning("page1")).toBe(true);
		world.restoreSnapshot(world.doc.all());
		expect(world.isBurning("page1")).toBe(false);
		// The restored thruster is still firing at the restored page: the
		// scene re-ignites on the next tick — only the fire STATE was lost.
		tick(world, 1);
		expect(world.isBurning("page1")).toBe(true);
	}, 10_000);

	test("repainting a burning body to a non-flammable material extinguishes it", async () => {
		const world = await flammableWorld();
		mountThruster(world);
		world.spawnBox("page1", -8, -10, 1, 1, "paper");
		tick(world, 2);
		expect(world.isBurning("page1")).toBe(true);
		expect(world.setBodyMaterial("page1", "ink")).toBe(true);
		expect(world.isBurning("page1")).toBe(false);
		// And it survives its would-be burn-out window.
		tick(world, BURN_TICKS);
		expect(world.bodies.has("page1")).toBe(true);
	}, 10_000);
});

describe("scene-file flammable round-trip", () => {
	const base = {
		id: "custom-9",
		name: "Paper",
		color: "#e8dcc8",
		density: 1,
		friction: 0.5,
		restitution: 0.1,
	};
	const file = (flammable?: boolean) => ({
		schemaVersion: 1,
		entities: [],
		customMaterials: [
			flammable === undefined ? { ...base } : { ...base, flammable },
		],
		savedAt: 1,
	});

	test("boolean flag round-trips; non-boolean rejected", () => {
		const truthy = validateSceneFile(file(true));
		expect(truthy.ok).toBe(true);
		if (truthy.ok) expect(truthy.file.customMaterials[0]?.flammable).toBe(true);
		const falsy = validateSceneFile(file(false));
		expect(falsy.ok).toBe(true);
		if (falsy.ok) expect(falsy.file.customMaterials[0]?.flammable).toBe(false);
		const absent = validateSceneFile(file());
		expect(absent.ok).toBe(true);
		if (absent.ok)
			expect(absent.file.customMaterials[0]?.flammable).toBeUndefined();
		const bad = validateSceneFile(file("yes" as unknown as boolean));
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("flammable");
	});
});
