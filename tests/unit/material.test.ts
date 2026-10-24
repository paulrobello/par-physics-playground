import { describe, expect, test } from "bun:test";
import {
	colliderArea,
	defaultBody,
	massProperties,
	SceneDocument,
} from "../../src/lib/document";
import {
	MATERIAL_DEFAULT_ID,
	MATERIAL_INK,
	MATERIAL_PREDEFINED,
	type Material,
} from "../../src/lib/material";
import { polygonCentroid } from "../../src/lib/triangulate";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * Material data model + predefined palette (P3-T1): the registry seeds every
 * document, mass/inertia derive from geometry × density, colliders take the
 * entity material's friction/restitution, and duplicate/restore preserve the
 * materialId (the phase-2 restitution-override-lost-on-duplicate defect
 * closes structurally — there is no per-spawn override left to lose).
 */
describe("predefined palette", () => {
	test("six materials with unique ids; ink is the default", () => {
		const ids = MATERIAL_PREDEFINED.map((m) => m.id);
		expect(ids).toHaveLength(6);
		expect(new Set(ids).size).toBe(6);
		expect(MATERIAL_DEFAULT_ID).toBe("ink");
		expect(MATERIAL_INK.id).toBe("ink");
		expect(MATERIAL_PREDEFINED.map((m) => m.id)).toEqual([
			"ink",
			"wood",
			"stone",
			"metal",
			"rubber",
			"ice",
		]);
	});

	test("brief-pinned wood and stone values; each material has a color", () => {
		const byId = new Map(MATERIAL_PREDEFINED.map((m) => [m.id, m]));
		const wood = byId.get("wood") as Material;
		const stone = byId.get("stone") as Material;
		expect([wood.density, wood.friction, wood.restitution]).toEqual([
			0.25, 0.7, 0.2,
		]);
		expect([stone.density, stone.friction, stone.restitution]).toEqual([
			2.5, 0.9, 0.05,
		]);
		for (const m of MATERIAL_PREDEFINED) {
			expect(m.color).toMatch(/^#[0-9a-f]{6}$/);
			expect(m.name.length).toBeGreaterThan(0);
			expect(m.density).toBeGreaterThan(0);
		}
	});

	test("the document registry seeds the palette; addMaterial rejects duplicates", () => {
		const doc = new SceneDocument();
		expect(doc.allMaterials().map((m) => m.id)).toEqual([
			"ink",
			"wood",
			"stone",
			"metal",
			"rubber",
			"ice",
		]);
		expect(doc.addMaterial({ ...MATERIAL_INK, id: "wood" })).toBe(false);
		expect(
			doc.addMaterial({
				id: "glass",
				name: "Glass",
				color: "#cfe8ef",
				density: 2.5,
				friction: 0.1,
				restitution: 0.1,
			}),
		).toBe(true);
		expect(doc.material("glass").name).toBe("Glass");
	});

	test("unknown materialId falls back to ink", () => {
		const doc = new SceneDocument();
		expect(doc.material("nonexistent").id).toBe("ink");
	});
});

describe("mass/inertia derivation from geometry + material", () => {
	test("colliderArea per shape kind", () => {
		expect(colliderArea({ kind: "box", halfWidth: 2, halfHeight: 1 })).toBe(8); // (2·2)·(2·1)
		expect(colliderArea({ kind: "circle", radius: 3 })).toBeCloseTo(
			Math.PI * 9,
		);
		const tri = [
			{ x: 0, y: 0 },
			{ x: 4, y: 0 },
			{ x: 0, y: 3 },
		];
		expect(colliderArea({ kind: "polygon", points: tri })).toBeCloseTo(6);
	});

	test("massProperties closed forms: box and circle", () => {
		const box = massProperties(
			{ kind: "box", halfWidth: 2, halfHeight: 1 },
			2.5,
		);
		expect(box.mass).toBeCloseTo(20); // 2.5 · 8
		expect(box.inertia).toBeCloseTo((20 * (16 + 4)) / 12);
		const circle = massProperties({ kind: "circle", radius: 3 }, 0.25);
		expect(circle.mass).toBeCloseTo(0.25 * Math.PI * 9);
		expect(circle.inertia).toBeCloseTo((circle.mass * 9) / 2);
	});

	test("massProperties polygon: shoelace second moment matches the triangle form", () => {
		// Right triangle centered at its centroid; known centroidal moments:
		// Ixx = b·h³/36, Iyy = b³·h/36 (legs along the axes, about own centroid).
		const b = 4;
		const h = 3;
		const density = 2;
		// Vertices relative to the centroid (b/3, h/3).
		const tri = [
			{ x: -b / 3, y: (2 * h) / 3 },
			{ x: (2 * b) / 3, y: -h / 3 },
			{ x: -b / 3, y: -h / 3 },
		];
		const props = massProperties({ kind: "polygon", points: tri }, density);
		const mass = density * ((b * h) / 2);
		expect(props.mass).toBeCloseTo(mass);
		expect(props.inertia).toBeCloseTo(
			density * ((b * h * h * h) / 36 + (b * b * b * h) / 36),
		);
	});

	test("Rapier bodies derive the same mass/inertia from each shape kind + material", async () => {
		const world = await PhysicsWorld.create();
		const wood = world.doc.material("wood");
		const stone = world.doc.material("stone");

		// Box 4×2 (half 2×1): area 8.
		world.spawnEntity({
			...defaultBody(
				"box",
				{ kind: "box", halfWidth: 2, halfHeight: 1 },
				0,
				-50,
			),
			materialId: "wood",
		});
		const boxBody = world.bodies.get("box");
		if (!boxBody) throw new Error("box missing");
		const boxProps = massProperties(
			{ kind: "box", halfWidth: 2, halfHeight: 1 },
			wood.density,
		);
		expect(boxBody.mass()).toBeCloseTo(boxProps.mass);
		expect(boxBody.principalInertia()).toBeCloseTo(boxProps.inertia);

		// Circle r=3.
		world.spawnEntity({
			...defaultBody("ball", { kind: "circle", radius: 3 }, 0, -50),
			materialId: "stone",
		});
		const ballBody = world.bodies.get("ball");
		if (!ballBody) throw new Error("ball missing");
		const ballProps = massProperties(
			{ kind: "circle", radius: 3 },
			stone.density,
		);
		expect(ballBody.mass()).toBeCloseTo(ballProps.mass);
		expect(ballBody.principalInertia()).toBeCloseTo(ballProps.inertia);

		// Polygon (convex quad). spawnPolygon recenters points to the area
		// centroid and massProperties assumes body-local points (origin at the
		// centroid), so the comparison fixture is centered the same way
		// (fix-wave T1: the expected value previously used the original quad).
		const quad = [
			{ x: -2, y: -1 },
			{ x: 2, y: -1 },
			{ x: 2.5, y: 1 },
			{ x: -2, y: 1 },
		];
		world.spawnPolygon("poly", quad, false, "wood");
		const polyBody = world.bodies.get("poly");
		if (!polyBody) throw new Error("poly missing");
		const centroid = polygonCentroid(quad);
		const centered = quad.map((p) => ({
			x: p.x - centroid.x,
			y: p.y - centroid.y,
		}));
		const polyProps = massProperties(
			{ kind: "polygon", points: centered },
			wood.density,
		);
		expect(polyBody.mass()).toBeCloseTo(polyProps.mass);
		expect(polyBody.principalInertia()).toBeCloseTo(polyProps.inertia);
	});

	test("colliders take the entity material's friction and restitution", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("rub", 0, -50, 1, 1, "rubber");
		world.spawnBox("ice", 0, -50, 1, 1, "ice");
		world.spawnBox("ink", 0, -50, 1, 1);
		const rub = world.bodies.get("rub")?.collider(0);
		const ice = world.bodies.get("ice")?.collider(0);
		const ink = world.bodies.get("ink")?.collider(0);
		if (!rub || !ice || !ink) throw new Error("colliders missing");
		expect(rub.restitution()).toBeCloseTo(0.85);
		expect(rub.friction()).toBeCloseTo(0.9);
		expect(ice.friction()).toBeCloseTo(0.02);
		expect(ink.friction()).toBeCloseTo(0.5);
		expect(ink.restitution()).toBeCloseTo(0.1);
	});
});

describe("materialId preservation", () => {
	test("duplicateBody carries the materialId and its derived collider", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("src", 0, -50, 2, 2, "stone");
		expect(world.duplicateBody("src", "copy", 10, 0)).toBe("copy");
		const entity = world.doc.get("copy");
		if (entity?.kind !== "body") throw new Error("copy missing");
		expect(entity.materialId).toBe("stone");
		const copyCollider = world.bodies.get("copy")?.collider(0);
		if (!copyCollider) throw new Error("copy body missing");
		expect(copyCollider.restitution()).toBeCloseTo(0.05);
		expect(copyCollider.friction()).toBeCloseTo(0.9);
		expect(world.bodies.get("copy")?.mass()).toBeCloseTo(
			world.bodies.get("src")?.mass() ?? 0,
		);
	});

	test("restoreSnapshot preserves materialId and derived colliders", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("keep", 0, -50, 2, 2, "rubber");
		const snapshot = world.doc.all();
		world.restoreSnapshot(snapshot);
		const entity = world.doc.get("keep");
		if (entity?.kind !== "body") throw new Error("body missing after restore");
		expect(entity.materialId).toBe("rubber");
		const collider = world.bodies.get("keep")?.collider(0);
		if (!collider) throw new Error("body missing after restore");
		expect(collider.restitution()).toBeCloseTo(0.85);
	});
});
