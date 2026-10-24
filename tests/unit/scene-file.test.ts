/**
 * P5-T1/T2 scene-file serialization + validation: the unit-testable core of
 * scene persistence. The IndexedDB store and the JSON download/upload are
 * thin transports over this module (covered by e2e in a real browser).
 */
import { describe, expect, test } from "bun:test";
import { MATERIAL_PREDEFINED } from "../../src/lib/material";
import {
	applySceneFile,
	buildSceneFile,
	SCENE_SCHEMA_VERSION,
	validateSceneFile,
} from "../../src/lib/scene-file";
import type { ThrusterEntity } from "../../src/lib/thruster";
import { PhysicsWorld } from "../../src/lib/world";

async function richWorld(): Promise<PhysicsWorld> {
	const world = await PhysicsWorld.create();
	world.spawnBox("box-1", 0, -10, 4, 2);
	world.spawnCircle("ball-1", 10, -30, 3, false, "wood");
	const thruster: ThrusterEntity = {
		kind: "thruster",
		id: "thruster-1",
		bodyId: "box-1",
		anchorX: 0,
		anchorY: -2,
		angle: 0,
		strength: 5000,
		on: true,
	};
	world.spawnThruster(thruster);
	return world;
}

describe("scene file build/apply", () => {
	test("round-trips entities and custom materials through a fresh world", async () => {
		const world = await richWorld();
		expect(
			world.doc.addMaterial({
				id: "custom-lead",
				name: "Lead",
				color: "#4a5a6a",
				density: 8,
				friction: 0.4,
				restitution: 0,
			}),
		).toBe(true);
		const file = buildSceneFile(world.doc);
		expect(file.schemaVersion).toBe(SCENE_SCHEMA_VERSION);
		expect(file.customMaterials.map((m) => m.id)).toEqual(["custom-lead"]);

		const second = await PhysicsWorld.create();
		applySceneFile(second, file);
		expect(second.doc.ids().sort()).toEqual(world.doc.ids().sort());
		expect(second.doc.get("box-1")).toEqual(world.doc.get("box-1"));
		expect(second.doc.get("thruster-1")).toEqual(world.doc.get("thruster-1"));
		expect(second.doc.material("custom-lead").name).toBe("Lead");
	});

	test("build carries only custom materials (predefined stay implicit)", async () => {
		const world = await richWorld();
		const file = buildSceneFile(world.doc);
		const ids = new Set(file.customMaterials.map((m) => m.id));
		for (const m of MATERIAL_PREDEFINED) expect(ids.has(m.id)).toBe(false);
		expect(file.customMaterials).toHaveLength(0);
	});
});

describe("scene file validation", () => {
	test("accepts a file this module just built", async () => {
		const world = await richWorld();
		const result = validateSceneFile(
			JSON.parse(JSON.stringify(buildSceneFile(world.doc))),
		);
		expect(result.ok).toBe(true);
	});

	test("rejects non-objects, wrong versions, and missing arrays", () => {
		expect(validateSceneFile(null).ok).toBe(false);
		expect(validateSceneFile("nope").ok).toBe(false);
		expect(validateSceneFile({ schemaVersion: 99 }).ok).toBe(false);
		expect(validateSceneFile({ schemaVersion: 1, entities: "x" }).ok).toBe(
			false,
		);
	});

	test("rejects unknown entity kinds and out-of-bounds geometry", async () => {
		const world = await richWorld();
		const base = JSON.parse(JSON.stringify(buildSceneFile(world.doc)));

		const badKind = structuredClone(base);
		badKind.entities[0].kind = "unknown";
		expect(validateSceneFile(badKind).ok).toBe(false);

		const farOut = structuredClone(base);
		farOut.entities[0].x = 50_000;
		expect(validateSceneFile(farOut).ok).toBe(false);

		const hugeBox = structuredClone(base);
		hugeBox.entities[0].shape = { kind: "box", halfWidth: 5000, halfHeight: 2 };
		expect(validateSceneFile(hugeBox).ok).toBe(false);
	});

	test("rejects documents over the D17 safety caps", async () => {
		const world = await richWorld();
		const base = JSON.parse(JSON.stringify(buildSceneFile(world.doc)));
		// Pad past 1200 bodies with tiny valid boxes at sane coordinates.
		const pad = Array.from({ length: 1201 }, (_, i) => ({
			kind: "box",
			id: `pad-${i}`,
			x: (i % 40) * 10 - 200,
			y: -Math.floor(i / 40) * 10 - 10,
			rot: 0,
			isStatic: false,
			materialId: "ink",
			shape: { kind: "box", halfWidth: 2, halfHeight: 2 },
		}));
		base.entities = pad;
		expect(validateSceneFile(base).ok).toBe(false);
	});

	test("error strings name the offense (visible import errors)", async () => {
		const world = await richWorld();
		const base = JSON.parse(JSON.stringify(buildSceneFile(world.doc)));
		base.entities[0].x = 50_000;
		const result = validateSceneFile(base);
		if (result.ok) throw new Error("expected rejection");
		expect(result.error.length).toBeGreaterThan(5);
	});
});

describe("review fixes: id counters, atomicity, non-body bounds", () => {
	test("applySceneFile advances id minters past restored ids (C1)", async () => {
		const { freshBodyId } = await import("../../src/lib/interaction");
		const { freshRopeSegmentId } = await import("../../src/lib/rope");
		const world = await PhysicsWorld.create();
		const file = buildSceneFile(world.doc);
		// A restored scene carrying high ids must push every minter past them
		// (body, joint, thruster via the same scan; rope-seg is its own
		// counter — the P5 card's exact scenario).
		const withIds = {
			...file,
			entities: [
				...file.entities,
				{
					kind: "label",
					id: "body-41",
					x: 0,
					y: 0,
					rot: 0,
					text: "x",
				},
				{
					kind: "body",
					id: "rope-seg-40",
					x: 0,
					y: -10,
					rot: 0,
					isStatic: false,
					materialId: "ink",
					shape: { kind: "circle", radius: 1 },
				},
			] as typeof file.entities,
		};
		applySceneFile(world, withIds);
		expect(freshBodyId()).toBe("body-42");
		expect(freshRopeSegmentId()).toBe("rope-seg-41");
	});

	test("applySceneFile is atomic: an unspawnable entity leaves the world intact (I3)", async () => {
		const world = await richWorld();
		const beforeIds = [...world.doc.ids()].sort();
		const bodiesBefore = world.bodies.size;
		const file = buildSceneFile(world.doc);
		// A bowtie polygon: shape-valid, but spawnEntity refuses it.
		const bad = {
			...file,
			entities: [
				...file.entities,
				{
					kind: "body",
					id: "bowtie",
					x: 0,
					y: -80,
					rot: 0,
					isStatic: false,
					materialId: "ink",
					shape: {
						kind: "polygon",
						points: [
							{ x: -10, y: -10 },
							{ x: 10, y: 10 },
							{ x: 10, y: -10 },
							{ x: -10, y: 10 },
						],
					},
				},
			] as typeof file.entities,
		};
		expect(() => applySceneFile(world, bad)).toThrow();
		expect([...world.doc.ids()].sort()).toEqual(beforeIds);
		expect(world.bodies.size).toBe(bodiesBefore);
	});

	test("non-body declared bounds are enforced (I2)", async () => {
		const world = await richWorld();
		const file = JSON.parse(JSON.stringify(buildSceneFile(world.doc))) as {
			entities: unknown[];
		};
		file.entities.push({
			kind: "thruster",
			id: "t-x",
			bodyId: "box-1",
			anchorX: 0,
			anchorY: 0,
			angle: 0,
			strength: 1e308,
			on: true,
		});
		expect(validateSceneFile(file).ok).toBe(false);

		const file2 = JSON.parse(JSON.stringify(buildSceneFile(world.doc))) as {
			entities: unknown[];
		};
		file2.entities.push({
			kind: "label",
			id: "l-x",
			x: 0,
			y: 0,
			rot: 0,
			text: "x".repeat(500),
		});
		expect(validateSceneFile(file2).ok).toBe(false);
	});
});
