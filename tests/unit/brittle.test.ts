import { describe, expect, test } from "bun:test";
import {
	BRITTLE_IMPULSE_THRESHOLD,
	BRITTLE_MIN_GRAVITY,
	BRITTLE_MIN_HALF_SIZE,
	brittleMinHalfExtent,
	fragmentEntities,
	fragmentSpecs,
	shouldShatter,
} from "../../src/lib/brittle";
import type { BodyShape } from "../../src/lib/document";
import { validateSceneFile } from "../../src/lib/scene-file";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * Brittle materials extra: the pure shatter decision + fragment geometry,
 * the world-level shatter on a hard drop (deterministic fixed ticks), the
 * cascade guard, and the scene-file flag round-trip.
 *
 * Threshold evidence (mass-4 unit box, gravity 9.81): the shatter/no-shatter
 * drop boundary measured at roughly a 5-unit fall height — ratio of impact
 * force to resting load crosses 60x there (resting sits at ~1x, a hard 25+
 * unit drop peaks ~100x+). 60 separates the regimes with margin on both
 * sides; the tests below pin resting + 1-unit-drop intact, 28-unit drop
 * shattered.
 */

const GLASS = {
	id: "glass",
	name: "Glass",
	color: "#cfe3ef",
	density: 1,
	friction: 0.5,
	restitution: 0.1,
	brittle: true,
};

async function glassWorld(): Promise<PhysicsWorld> {
	const world = await PhysicsWorld.create();
	world.doc.addMaterial({ ...GLASS });
	return world;
}

function tick(world: PhysicsWorld, n: number): void {
	for (let i = 0; i < n; i++) world.step();
}

describe("shouldShatter decision", () => {
	const box1: BodyShape = { kind: "box", halfWidth: 1, halfHeight: 1 };
	const tiny: BodyShape = { kind: "box", halfWidth: 0.5, halfHeight: 0.5 };
	const circle1: BodyShape = { kind: "circle", radius: 1 };
	const poly: BodyShape = {
		kind: "polygon",
		points: [
			{ x: 1, y: 1 },
			{ x: -1, y: 1 },
			{ x: 0, y: -1 },
		],
	};
	const base = { brittle: true, isStatic: false, mass: 4, gravity: 9.81 };

	test("non-brittle and static bodies never shatter", () => {
		expect(
			shouldShatter({ ...base, brittle: false, shape: box1, impactForce: 1e9 }),
		).toBe(false);
		expect(
			shouldShatter({ ...base, isStatic: true, shape: box1, impactForce: 1e9 }),
		).toBe(false);
	});

	test("polygons and below-minimum shapes never shatter", () => {
		expect(brittleMinHalfExtent(poly)).toBeNull();
		expect(brittleMinHalfExtent(circle1)).toBe(1);
		expect(shouldShatter({ ...base, shape: poly, impactForce: 1e9 })).toBe(
			false,
		);
		expect(shouldShatter({ ...base, shape: tiny, impactForce: 1e9 })).toBe(
			false,
		);
		expect(BRITTLE_MIN_HALF_SIZE).toBe(1);
	});

	test("resting-load forces never shatter; threshold-multiple impacts do", () => {
		expect(shouldShatter({ ...base, shape: box1, impactForce: 4 * 9.81 })).toBe(
			false,
		);
		expect(
			shouldShatter({
				...base,
				shape: box1,
				impactForce: BRITTLE_IMPULSE_THRESHOLD * 4 * 9.81,
			}),
		).toBe(true);
	});

	test("gravity floor keeps zero-g touches below the threshold", () => {
		expect(
			shouldShatter({
				...base,
				shape: box1,
				gravity: 0,
				impactForce: BRITTLE_IMPULSE_THRESHOLD * 4 * 0.5,
			}),
		).toBe(false);
		expect(
			shouldShatter({
				...base,
				shape: box1,
				gravity: 0,
				impactForce: BRITTLE_IMPULSE_THRESHOLD * 4 * BRITTLE_MIN_GRAVITY,
			}),
		).toBe(true);
	});
});

describe("fragment geometry", () => {
	const box1: BodyShape = { kind: "box", halfWidth: 1, halfHeight: 1 };
	const circle2: BodyShape = { kind: "circle", radius: 2 };
	const poly: BodyShape = {
		kind: "polygon",
		points: [
			{ x: 1, y: 1 },
			{ x: -1, y: 1 },
			{ x: 0, y: -1 },
		],
	};

	test("box: 2x2 grid of half-size boxes, area conserved", () => {
		const specs = fragmentSpecs(box1);
		if (!specs) throw new Error("box has no fragment specs");
		expect(specs).toHaveLength(4);
		let area = 0;
		for (const s of specs) {
			if (s.shape.kind !== "box") throw new Error("fragment is not a box");
			area += 4 * s.shape.halfWidth * s.shape.halfHeight;
		}
		expect(area).toBe(4);
		expect(specs).toEqual([
			{
				shape: { kind: "box", halfWidth: 0.5, halfHeight: 0.5 },
				dx: -0.5,
				dy: -0.5,
			},
			{
				shape: { kind: "box", halfWidth: 0.5, halfHeight: 0.5 },
				dx: 0.5,
				dy: -0.5,
			},
			{
				shape: { kind: "box", halfWidth: 0.5, halfHeight: 0.5 },
				dx: -0.5,
				dy: 0.5,
			},
			{
				shape: { kind: "box", halfWidth: 0.5, halfHeight: 0.5 },
				dx: 0.5,
				dy: 0.5,
			},
		]);
	});

	test("circle: 4 half-radius discs at quadrant centres, area conserved", () => {
		const specs = fragmentSpecs(circle2);
		if (!specs) throw new Error("circle has no fragment specs");
		expect(specs).toHaveLength(4);
		let area = 0;
		for (const s of specs) {
			if (s.shape.kind !== "circle")
				throw new Error("fragment is not a circle");
			area += Math.PI * s.shape.radius * s.shape.radius;
			expect(Math.abs(s.dx)).toBe(1);
			expect(Math.abs(s.dy)).toBe(1);
		}
		expect(area).toBeCloseTo(Math.PI * 4, 10);
	});

	test("polygon: no fragment specs", () => {
		expect(fragmentSpecs(poly)).toBeNull();
	});

	test("fragmentEntities: ids minted in order; offsets rotate with the parent", () => {
		const parent = {
			kind: "body",
			id: "pane",
			shape: box1,
			x: 0,
			y: 0,
			rot: 0,
			materialId: "glass",
			isStatic: false,
		} as const;
		let n = 0;
		const frags = fragmentEntities(() => "frag-" + String(++n), parent, {
			x: 10,
			y: 20,
			rot: 0,
		});
		expect(frags.map((f) => f.id)).toEqual([
			"frag-1",
			"frag-2",
			"frag-3",
			"frag-4",
		]);
		for (const f of frags) {
			expect(f.materialId).toBe("glass");
			expect(f.isStatic).toBe(false);
			expect(f.rot).toBe(0);
		}
		// Rotated 90 degrees: local (-0.5, -0.5) lands at world (10.5, 19.5).
		const rotated = fragmentEntities(() => "f", parent, {
			x: 10,
			y: 20,
			rot: Math.PI / 2,
		});
		const first = rotated[0];
		if (!first) throw new Error("missing rotated fragment");
		expect(first.x).toBeCloseTo(10.5, 10);
		expect(first.y).toBeCloseTo(19.5, 10);
	});
});

describe("world shatter on impact", () => {
	test("hard-dropped brittle box shatters into 4 same-material fragments", async () => {
		const world = await glassWorld();
		world.spawnBox("pane", 0, -30, 1, 1, "glass");
		tick(world, 240);
		expect(world.bodies.has("pane")).toBe(false);
		expect(world.doc.get("pane")).toBeUndefined();
		const frags = world.doc.all().filter((e) => e.kind === "body");
		expect(frags).toHaveLength(4);
		expect(world.bodies.size).toBe(4);
		for (const f of frags) {
			if (f.kind !== "body") throw new Error("fragment is not a body");
			expect(f.materialId).toBe("glass");
			expect(f.isStatic).toBe(false);
			expect(f.shape).toEqual({ kind: "box", halfWidth: 0.5, halfHeight: 0.5 });
			expect(Math.abs(f.x)).toBeCloseTo(0.5, 1);
			expect(Math.abs(f.y + 1)).toBeCloseTo(0.5, 0);
		}
	}, 10_000);

	test("resting and gently-dropped brittle boxes stay intact", async () => {
		const world = await glassWorld();
		world.spawnBox("slab", 0, -1, 1, 1, "glass");
		world.spawnBox("gentle", 0, -2, 1, 1, "glass");
		tick(world, 300);
		expect(world.bodies.has("slab")).toBe(true);
		expect(world.bodies.has("gentle")).toBe(true);
		expect(world.doc.all().filter((e) => e.kind === "body")).toHaveLength(2);
	}, 10_000);

	test("hard-dropped brittle circle shatters into 4 quadrant discs", async () => {
		const world = await glassWorld();
		world.spawnCircle("ball", 0, -30, 2, false, "glass");
		tick(world, 240);
		expect(world.bodies.has("ball")).toBe(false);
		const frags = world.doc.all().filter((e) => e.kind === "body");
		expect(frags).toHaveLength(4);
		for (const f of frags) {
			if (f.kind !== "body") throw new Error("fragment is not a body");
			expect(f.shape).toEqual({ kind: "circle", radius: 1 });
			expect(f.materialId).toBe("glass");
			expect(Math.abs(f.x)).toBeCloseTo(1, 1);
			expect(Math.abs(f.y + 2)).toBeCloseTo(1, 0);
		}
	}, 10_000);

	test("below-minimum brittle body survives a hard drop (cascade guard)", async () => {
		const world = await glassWorld();
		world.spawnBox("tiny", 0, -30, 0.5, 0.5, "glass");
		tick(world, 240);
		expect(world.bodies.has("tiny")).toBe(true);
		expect(world.doc.all().filter((e) => e.kind === "body")).toHaveLength(1);
	}, 10_000);

	test("brittle polygons never fragment (documented skip)", async () => {
		const world = await glassWorld();
		world.spawnPolygon(
			"poly",
			[
				{ x: 1, y: -29 },
				{ x: -1, y: -29 },
				{ x: 0, y: -31 },
			],
			false,
			"glass",
		);
		tick(world, 240);
		expect(world.bodies.has("poly")).toBe(true);
	}, 10_000);

	test("fragment ids come from the wired minter", async () => {
		const world = await glassWorld();
		let n = 0;
		world.fragmentIdMinter = () => "frag-" + String(++n);
		world.spawnBox("pane", 0, -30, 1, 1, "glass");
		tick(world, 240);
		const ids = world.doc
			.all()
			.filter((e) => e.kind === "body")
			.map((e) => e.id)
			.sort();
		expect(ids).toEqual(["frag-1", "frag-2", "frag-3", "frag-4"]);
	}, 10_000);
});

describe("scene-file brittle round-trip", () => {
	const base = {
		id: "custom-9",
		name: "Glass",
		color: "#cfe3ef",
		density: 1,
		friction: 0.5,
		restitution: 0.1,
	};
	const file = (brittle?: boolean) => ({
		schemaVersion: 1,
		entities: [],
		customMaterials: [
			brittle === undefined ? { ...base } : { ...base, brittle },
		],
		savedAt: 1,
	});

	test("boolean flag round-trips; non-boolean rejected", () => {
		const truthy = validateSceneFile(file(true));
		expect(truthy.ok).toBe(true);
		if (truthy.ok) expect(truthy.file.customMaterials[0]?.brittle).toBe(true);
		const falsy = validateSceneFile(file(false));
		expect(falsy.ok).toBe(true);
		if (falsy.ok) expect(falsy.file.customMaterials[0]?.brittle).toBe(false);
		const absent = validateSceneFile(file());
		expect(absent.ok).toBe(true);
		if (absent.ok)
			expect(absent.file.customMaterials[0]?.brittle).toBeUndefined();
		const bad = validateSceneFile(file("yes" as unknown as boolean));
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("brittle");
	});
});
