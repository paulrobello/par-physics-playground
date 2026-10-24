/**
 * Joint framework tests (P4-T1): anchor math (world ↔ body-local pivots),
 * placement coincidence, document/rebuild round-trip (bodies BEFORE joints,
 * Ruling 22), the body-removal cascade (deleting any body removes its
 * joints), and undo over jointed scenes.
 */
import { describe, expect, test } from "bun:test";
import { SceneDocument } from "../../src/lib/document";
import {
	JOINT_GLYPH_MAX_PX,
	JOINT_GLYPH_MIN_PX,
	type JointEntity,
	jointGlyphRadius,
	localPointToWorld,
	makeJoint,
	worldPointToLocal,
} from "../../src/lib/joint";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

describe("anchor math", () => {
	test("world→local→world round-trips through translation and rotation", () => {
		const cases = [
			{ px: 3, py: -7, x: 10, y: -4, rot: 0 },
			{ px: 3, py: -7, x: 10, y: -4, rot: Math.PI / 2 },
			{ px: -2.5, py: 1.25, x: 0, y: 0, rot: -0.7 },
			{ px: 100, py: -200, x: 40, y: -210, rot: 2.3 },
		];
		for (const c of cases) {
			const local = worldPointToLocal(c.px, c.py, c.x, c.y, c.rot);
			const world = localPointToWorld(local.x, local.y, c.x, c.y, c.rot);
			expect(world.x).toBeCloseTo(c.px, 9);
			expect(world.y).toBeCloseTo(c.py, 9);
		}
	});

	test("local pivot survives body moves and rotations (the point of body-local anchors)", () => {
		// Anchor at world (12, -10) on a body at (10, -8): local offset (2, -2).
		const anchor = worldPointToLocal(12, -10, 10, -8, 0);
		// Body moves and rotates: the same local anchor maps to the moved frame.
		const moved = localPointToWorld(anchor.x, anchor.y, 20, -30, Math.PI / 2);
		// Rotating (2,-2) by +90° (y-down): (x,y) → (-y, x) = (2, 2).
		expect(moved.x).toBeCloseTo(22, 9);
		expect(moved.y).toBeCloseTo(-28, 9);
	});

	test("makeJoint derives coincident anchors from one world point", () => {
		const world = { x: 5, y: -5 };
		const entity = makeJoint(
			"j1",
			{ kind: "pin" },
			"a",
			"b",
			world,
			{ x: 0, y: 0, rot: 0.3 },
			{ x: 9, y: -6, rot: -1.1 },
		);
		expect(entity.jointType).toBe("pin");
		expect(entity.kind).toBe("joint");
		// Both anchors must map back to the SAME world point on their bodies.
		const wa = localPointToWorld(entity.anchorA.x, entity.anchorA.y, 0, 0, 0.3);
		const wb = localPointToWorld(
			entity.anchorB.x,
			entity.anchorB.y,
			9,
			-6,
			-1.1,
		);
		expect(wa.x).toBeCloseTo(world.x, 9);
		expect(wa.y).toBeCloseTo(world.y, 9);
		expect(wb.x).toBeCloseTo(world.x, 9);
		expect(wb.y).toBeCloseTo(world.y, 9);
	});

	test("world-anchored joints (bodyB null) store the world point verbatim", () => {
		const entity = makeJoint(
			"j2",
			{ kind: "pin" },
			"a",
			null,
			{ x: -3, y: -12 },
			{ x: -1, y: -10, rot: 0 },
			null,
		);
		expect(entity.bodyB).toBeNull();
		expect(entity.anchorB).toEqual({ x: -3, y: -12 });
	});

	test("glyph radius clamps to a screen-size window shared with picking", () => {
		// Deep zoom-out: never below the CSS-px floor.
		expect(jointGlyphRadius(0.01)).toBeCloseTo(JOINT_GLYPH_MIN_PX / 0.01, 9);
		// Deep zoom-in: never above the CSS-px ceiling.
		expect(jointGlyphRadius(1000)).toBeCloseTo(JOINT_GLYPH_MAX_PX / 1000, 9);
		// At the default zoom the 5 CSS-px floor binds (0.45 world < 5/1): the
		// ring reads as 5 world units; at zoom 5, the floor yields 1.
		expect(jointGlyphRadius(1)).toBeCloseTo(5, 9);
		expect(jointGlyphRadius(5)).toBeCloseTo(1, 9);
	});
});

describe("joint document layer", () => {
	test("joints() lists joint entities; setTransform refuses joints", () => {
		const doc = new SceneDocument();
		const joint = makeJoint(
			"j",
			{ kind: "pin" },
			"a",
			null,
			{ x: 1, y: 2 },
			{ x: 0, y: 0, rot: 0 },
			null,
		);
		doc.add(joint);
		expect(doc.joints()).toEqual([joint]);
		expect(doc.get("j")?.kind).toBe("joint");
		expect(doc.setTransform("j", 5, 5, 0)).toBe(false);
	});
});

describe("joint world lifecycle", () => {
	async function pinnedWorld(): Promise<{
		world: PhysicsWorld;
		joint: JointEntity;
	}> {
		const world = await PhysicsWorld.create();
		world.spawnBox("a", -5, -50, 5, 5);
		world.spawnBox("b", 5, -50, 5, 5);
		const joint = makeJoint(
			"j-ab",
			{ kind: "pin" },
			"a",
			"b",
			{ x: 0, y: -50 },
			{ x: -5, y: -50, rot: 0 },
			{ x: 5, y: -50, rot: 0 },
		);
		expect(world.spawnJoint(joint)).toBe(true);
		return { world, joint };
	}

	test("spawnJoint registers the document entity and the Rapier joint", async () => {
		const { world } = await pinnedWorld();
		expect(world.joints.size).toBe(1);
		expect(world.doc.joints().map((j) => j.id)).toEqual(["j-ab"]);
	});

	test("spawnJoint refuses unknown endpoint bodies", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("a", 0, -50, 5, 5);
		expect(
			world.spawnJoint(
				makeJoint(
					"j-missing",
					{ kind: "pin" },
					"a",
					"ghost",
					{ x: 0, y: -50 },
					{ x: 0, y: -50, rot: 0 },
					{ x: 0, y: -50, rot: 0 },
				),
			),
		).toBe(false);
		expect(world.joints.size).toBe(0);
		expect(world.doc.joints().length).toBe(0);
	});

	test("pin constrains the anchored points together: the bodies fall and swing as one assembly", async () => {
		const { world } = await pinnedWorld();
		for (let i = 0; i < 30; i++) world.step();
		// The pin pulls the 5-unit gap closed: the anchored local pivots must
		// coincide in world space while the assembly moves and rotates.
		const joint = world.doc.joints()[0];
		if (!joint) throw new Error("joint missing");
		const a = world.jointWorldAnchor(joint);
		const bodyB = world.bodies.get("b");
		if (!a || !bodyB) throw new Error("assembly missing");
		const wb = localPointToWorld(
			joint.anchorB.x,
			joint.anchorB.y,
			bodyB.translation().x,
			bodyB.translation().y,
			bodyB.rotation(),
		);
		expect(a.x).toBeCloseTo(wb.x, 3);
		expect(a.y).toBeCloseTo(wb.y, 3);
		// And the pair actually moved (the constraint did not freeze the scene).
		const pa = world.bodyPosition("a");
		if (!pa) throw new Error("body a missing");
		expect(pa.y).toBeGreaterThan(-50);
	}, 10_000);

	test("deleting either endpoint body removes its joints (no orphans)", async () => {
		const { world } = await pinnedWorld();
		const removed: string[] = [];
		world.onRemove = (id) => removed.push(id);
		world.removeBody("b");
		expect(world.joints.size).toBe(0);
		expect(world.doc.joints().length).toBe(0);
		expect(removed).toContain("j-ab");
		// The other direction too.
		const again = await pinnedWorld();
		again.world.removeBody("a");
		expect(again.world.joints.size).toBe(0);
		expect(again.world.doc.joints().length).toBe(0);
	}, 10_000);

	test("restoreSnapshot rebuilds joints from the document (bodies BEFORE joints)", async () => {
		const { world } = await pinnedWorld();
		for (let i = 0; i < 10; i++) world.step();
		world.syncLiveTransforms();
		const snapshot = world.doc.all();
		world.removeBody("a"); // cascade clears the joint
		expect(world.joints.size).toBe(0);
		world.restoreSnapshot(snapshot);
		expect(world.joints.size).toBe(1);
		expect(world.doc.joints()[0]?.id).toBe("j-ab");
		// The rebuilt joint still constrains: anchored pivots coincide.
		for (let i = 0; i < 10; i++) world.step();
		const joint = world.doc.joints()[0];
		if (!joint) throw new Error("joint missing after rebuild");
		const a = world.jointWorldAnchor(joint);
		const bodyB = world.bodies.get("b");
		if (!a || !bodyB) throw new Error("rebuilt assembly missing");
		const wb = localPointToWorld(
			joint.anchorB.x,
			joint.anchorB.y,
			bodyB.translation().x,
			bodyB.translation().y,
			bodyB.rotation(),
		);
		expect(a.x).toBeCloseTo(wb.x, 3);
		expect(a.y).toBeCloseTo(wb.y, 3);
	}, 10_000);

	test("undo/redo covers joint placement through the snapshot boundary", async () => {
		const { world } = await pinnedWorld();
		world.syncLiveTransforms();
		const undo = new UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => world.restoreSnapshot(entities),
		);
		undo.commit(); // seed: jointed scene
		// New action: delete a body (removes the joint via the cascade).
		world.removeBody("b");
		undo.commit();
		expect(world.doc.joints().length).toBe(0);
		expect(undo.undo()).toBe(true);
		expect(world.doc.joints()[0]?.id).toBe("j-ab");
		expect(world.joints.size).toBe(1);
		expect(undo.redo()).toBe(true);
		expect(world.doc.joints().length).toBe(0);
	}, 10_000);

	test("reset() removes joints with their bodies without double-firing", async () => {
		const { world } = await pinnedWorld();
		const removed: string[] = [];
		world.onRemove = (id) => removed.push(id);
		world.reset();
		expect(world.joints.size).toBe(0);
		expect(world.doc.ids().length).toBe(0);
		expect(removed.filter((id) => id === "j-ab").length).toBe(1);
	}, 10_000);
});
