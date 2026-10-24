import { describe, expect, test } from "bun:test";
import type { Vec2 } from "../../src/lib/triangulate";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * Polygon spawning against a real Rapier world (loads in bun): convex input
 * gets a single hull collider, concave gets one collider per triangulated
 * part under one body, and degenerate input spawns nothing.
 */
describe("spawnPolygon", () => {
	test("convex triangle → one collider, one body", async () => {
		const world = await PhysicsWorld.create();
		const tri: Vec2[] = [
			{ x: 0, y: -2 },
			{ x: 2, y: 2 },
			{ x: -2, y: 2 },
		];
		const body = world.spawnPolygon("tri", tri);
		expect(body).toBeDefined();
		expect(body?.numColliders()).toBe(1);
		const spawned = world.doc.get("tri");
		if (!spawned || spawned.kind !== "body")
			throw new Error("triangle not in document");
		expect(spawned.shape.kind).toBe("polygon");
		expect(spawned.x).toBeCloseTo(0, 9);
		// Triangle's centroid: mean of vertices for equilateral-ish triangle.
		const c = world.doc.get("tri");
		if (c?.kind !== "body") throw new Error("triangle not spawned");
		// Centroid of this triangle: area-weighted, y = (-2 + 2 + 2)/3 = 2/3.
		expect(c.y).toBeCloseTo(2 / 3, 9);
	}, 10_000);

	test("concave L → one body, one collider per triangulated part", async () => {
		const world = await PhysicsWorld.create();
		const l: Vec2[] = [
			{ x: 0, y: 0 },
			{ x: 3, y: 0 },
			{ x: 3, y: 1 },
			{ x: 1, y: 1 },
			{ x: 1, y: 3 },
			{ x: 0, y: 3 },
		];
		const body = world.spawnPolygon("L", l);
		expect(body).toBeDefined();
		// 6-vertex L → 4 triangles → 4 colliders under one body.
		expect(body?.numColliders()).toBe(4);
		expect(world.bodies.get("L")).toBeDefined();
	}, 10_000);

	test("degenerate polygon spawns nothing", async () => {
		const world = await PhysicsWorld.create();
		expect(
			world.spawnPolygon("bad", [
				{ x: 0, y: 0 },
				{ x: 1, y: 0 },
				{ x: 2, y: 0 },
			]),
		).toBeUndefined();
		expect(world.doc.get("bad")).toBeUndefined();
		expect(world.bodies.has("bad")).toBe(false);
	}, 10_000);

	test("polygon duplicates, moves, and rotates like any body", async () => {
		const world = await PhysicsWorld.create();
		const tri: Vec2[] = [
			{ x: 0, y: -2 },
			{ x: 2, y: 2 },
			{ x: -2, y: 2 },
		];
		world.spawnPolygon("tri", tri);
		const dup = world.duplicateBody("tri", "copy", 1, -1);
		expect(dup).toBe("copy");
		const copy = world.doc.get("copy");
		if (copy?.kind !== "body") throw new Error("copy missing");
		expect(copy.shape.kind).toBe("polygon");
		world.moveBody("tri", 5, -50);
		expect(world.bodyPosition("tri")?.x).toBe(5);
		world.rotateBody("tri", 0.5);
		expect(world.bodyRotation("tri")).toBeCloseTo(0.5, 9);
		// A few ticks: the polygon falls under gravity without exploding.
		for (let i = 0; i < 10; i++) world.step();
		const p = world.bodyPosition("tri");
		expect(p?.y).toBeGreaterThan(-50);
		expect(Number.isFinite(p?.y ?? NaN)).toBe(true);
	}, 10_000);
});
