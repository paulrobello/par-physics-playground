import { describe, expect, test } from "bun:test";
import { defaultBody } from "../../src/lib/document";
import { createToolEvents } from "../../src/lib/interaction";
import { classifyEditKey } from "../../src/lib/tools";
import { UNDO_LIMIT, UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

describe("classifyEditKey", () => {
	const key = (
		over: Partial<{
			code: string;
			key: string;
			ctrlKey: boolean;
			metaKey: boolean;
			altKey: boolean;
		}> = {},
	) => ({
		code: "",
		key: "",
		ctrlKey: false,
		metaKey: false,
		altKey: false,
		...over,
	});

	test("modifier combos are ignored — the edit must not undo/commit or type them", () => {
		expect(
			classifyEditKey(key({ code: "KeyZ", key: "z", metaKey: true })),
		).toBe("ignore");
		expect(
			classifyEditKey(key({ code: "KeyZ", key: "z", ctrlKey: true })),
		).toBe("ignore");
		expect(
			classifyEditKey(key({ code: "KeyA", key: "a", ctrlKey: true })),
		).toBe("ignore");
		expect(
			classifyEditKey(key({ code: "Escape", key: "Escape", altKey: true })),
		).toBe("ignore");
	});

	test("Enter/Escape commit, Backspace deletes, printable inserts", () => {
		expect(classifyEditKey(key({ code: "Enter", key: "Enter" }))).toBe(
			"commit",
		);
		expect(classifyEditKey(key({ code: "Escape", key: "Escape" }))).toBe(
			"commit",
		);
		expect(classifyEditKey(key({ code: "Backspace", key: "Backspace" }))).toBe(
			"backspace",
		);
		// Delete edits text like Backspace during an inline label edit (it
		// was a silent no-op — the UX card's "delete-while-editing").
		expect(classifyEditKey(key({ code: "Delete", key: "Delete" }))).toBe(
			"backspace",
		);
		expect(classifyEditKey(key({ code: "KeyA", key: "a" }))).toBe("insert");
		// Non-printables without modifiers are swallowed too.
		expect(classifyEditKey(key({ code: "ArrowLeft", key: "ArrowLeft" }))).toBe(
			"ignore",
		);
	});
});

/**
 * P2-T5: bounded snapshot undo/redo. Stack bounds, redo-clears-on-new-action,
 * boundary coverage for each mutation kind, and rebuild fidelity — undo of a
 * mid-sim action restores the LIVE transforms (Ruling 14), not spawn-time
 * coordinates.
 */

/** UndoStack wired to a real world. */
function makeStack(world: PhysicsWorld, limit = UNDO_LIMIT): UndoStack {
	return new UndoStack(
		() => {
			world.syncLiveTransforms();
			return world.doc.all();
		},
		(entities) => world.restoreSnapshot(entities),
		limit,
	);
}

describe("UndoStack", () => {
	test("commit/undo/redo walk states; undoing past the oldest fails", async () => {
		const world = await PhysicsWorld.create();
		const stack = makeStack(world);
		stack.commit(); // seed: empty scene
		world.spawnBox("a", 0, -50, 1, 1);
		stack.commit();
		world.spawnBox("b", 5, -50, 1, 1);
		stack.commit();
		expect(stack.depths()).toEqual({ undo: 2, redo: 0 });
		expect(stack.undo()).toBe(true);
		expect(world.doc.get("b")).toBeUndefined();
		expect(world.doc.get("a")).toBeDefined();
		expect(stack.undo()).toBe(true);
		expect(world.doc.ids()).toEqual([]);
		expect(stack.undo()).toBe(false); // seeded initial state
		expect(stack.redo()).toBe(true);
		expect(stack.redo()).toBe(true);
		expect(world.doc.ids()).toEqual(["a", "b"]);
		expect(stack.redo()).toBe(false);
	}, 10_000);

	test("bounded: committing past the limit drops the oldest state", async () => {
		const world = await PhysicsWorld.create();
		const stack = makeStack(world, UNDO_LIMIT);
		stack.commit(); // seed: empty
		for (let i = 0; i < 60; i++) {
			world.spawnBox(`b${i}`, i, -50, 0.5, 0.5);
			stack.commit();
		}
		expect(stack.depths().undo).toBe(UNDO_LIMIT - 1);
		// Undo everything: 49 undos land on the state after the
		// (60 - (UNDO_LIMIT - 1)) = 11th draw — the 11 oldest snapshots were
		// dropped.
		let undos = 0;
		while (stack.undo()) undos++;
		expect(undos).toBe(UNDO_LIMIT - 1);
		expect(world.bodies.size).toBe(11);
		// Redo everything: back to all 60.
		let redos = 0;
		while (stack.redo()) redos++;
		expect(redos).toBe(UNDO_LIMIT - 1);
		expect(world.bodies.size).toBe(60);
	}, 10_000);

	test("no-op commits dedupe (a click-drag that moved nothing)", async () => {
		const world = await PhysicsWorld.create();
		const stack = makeStack(world);
		stack.commit(); // seed
		world.spawnBox("a", 0, -50, 1, 1);
		stack.commit();
		stack.commit(); // identical state: dedupes
		stack.commit();
		expect(stack.depths()).toEqual({ undo: 1, redo: 0 });
	}, 10_000);

	test("redo clears on a new action", async () => {
		const world = await PhysicsWorld.create();
		const stack = makeStack(world);
		stack.commit();
		world.spawnBox("a", 0, -50, 1, 1);
		stack.commit();
		expect(stack.undo()).toBe(true);
		expect(stack.canRedo).toBe(true);
		world.spawnBox("b", 5, -50, 1, 1);
		stack.commit(); // new action after undo: the undone {a} tail is gone
		expect(stack.canRedo).toBe(false);
		expect(stack.depths()).toEqual({ undo: 1, redo: 0 });
	}, 10_000);

	test("rebuild fidelity: undoing a mid-sim action restores LIVE transforms (Ruling 14)", async () => {
		const world = await PhysicsWorld.create();
		const stack = makeStack(world);
		stack.commit(); // seed
		// A box spawns at y=-50, then falls while the sim runs.
		world.spawnBox("faller", 0, -50, 5, 5);
		for (let i = 0; i < 30; i++) world.step();
		const live = world.bodyPosition("faller");
		expect(live?.y).toBeGreaterThan(-50); // it fell
		// Mid-sim move boundary: a paused-style drag teleports the body.
		const selected = new Set<string>(["faller"]);
		const events = createToolEvents(world, {
			isPaused: () => true,
			selectedIds: () => selected,
			recordAction: () => stack.commit(),
		});
		events.onDragStart("faller", { x: 0, y: live?.y ?? -50 });
		events.onDragMove({ x: 40, y: (live?.y ?? -50) - 30 });
		events.onDragEnd(); // move-end boundary → commit
		expect(world.bodyPosition("faller")?.x).toBe(40);
		// Another action, then undo the drag: the body returns to where it was
		// SEEN at the drag boundary — live coordinates, not spawn-time (0,-50).
		world.spawnBox("other", 100, -300, 2, 2);
		stack.commit();
		expect(stack.undo()).toBe(true);
		expect(world.bodyPosition("faller")?.x).toBeCloseTo(40, 6);
		const fellDoc = world.doc.get("faller");
		const fellY = fellDoc?.kind === "body" ? fellDoc.y : Number.NaN;
		expect(fellY).toBeCloseTo((live?.y ?? -50) - 30, 6);
		expect(world.doc.get("other")).toBeUndefined();
		// The rebuilt body stays dynamic after rebuild and keeps simulating.
		expect(world.bodies.get("faller")?.isFixed()).toBe(false);
		// Static terrain rebuilds as a fixed body too (D19 uniformity).
		world.spawnEntity({
			...defaultBody(
				"terrain",
				{ kind: "box", halfWidth: 20, halfHeight: 1 },
				0,
				-200,
			),
			isStatic: true,
		});
		stack.commit();
		expect(stack.undo()).toBe(true); // undo past the terrain
		expect(world.doc.get("terrain")).toBeUndefined();
		expect(stack.redo()).toBe(true); // rebuild brings it back, still fixed
		expect(world.bodies.get("terrain")?.isFixed()).toBe(true);
	}, 10_000);

	test("boundary coverage: every mutation kind records an undo state", async () => {
		const world = await PhysicsWorld.create();
		const stack = makeStack(world);
		stack.commit(); // seed
		const events = createToolEvents(world, {
			recordAction: () => stack.commit(),
		});
		// Shape commits: box, circle, polygon, line/beam — each deepens by 1.
		const d0 = stack.depths().undo;
		events.onSpawnBox({ cx: 0, cy: -50, halfWidth: 1, halfHeight: 1 });
		expect(stack.depths().undo).toBe(d0 + 1);
		events.onSpawnCircle({ cx: 5, cy: -50, radius: 1 });
		expect(stack.depths().undo).toBe(d0 + 2);
		events.onSpawnPolygon([
			{ x: 10, y: -50 },
			{ x: 14, y: -50 },
			{ x: 12, y: -54 },
		]);
		expect(stack.depths().undo).toBe(d0 + 3);
		events.onSpawnLine({
			cx: 20,
			cy: -50,
			rot: 0.3,
			halfLength: 5,
			halfWidth: 0.25,
		});
		expect(stack.depths().undo).toBe(d0 + 4);
		// Delete boundary: remove the box, depth +1, undo restores it.
		const boxId = world.doc.ids()[0] as string;
		events.onDelete([boxId]);
		expect(stack.depths().undo).toBe(d0 + 5);
		expect(stack.undo()).toBe(true);
		expect(world.doc.get(boxId)).toBeDefined();
		// Duplicate boundary (after the undo, depth is back at d0 + 4):
		// duplicate a real body (a miss would no-op and dedupe), depth +1,
		// undo removes the copy.
		const circleId = [...world.bodies.keys()][1] as string;
		events.onDuplicate([circleId]);
		expect(stack.depths().undo).toBe(d0 + 5);
		expect(stack.undo()).toBe(true); // depth back to d0 + 4
		// Label commit boundary.
		const id = events.onCreateLabel({ x: -5, y: -20 });
		events.onCommitLabel(id, "tag");
		expect(stack.depths().undo).toBe(d0 + 5);
	}, 10_000);

	test("rebuild preserves insertion order (draw order/picking) and labels", async () => {
		const world = await PhysicsWorld.create();
		const stack = makeStack(world);
		stack.commit(); // seed
		world.spawnBox("b1", 0, -50, 1, 1);
		stack.commit();
		world.addLabel("l1", 2, -3);
		world.setLabelText("l1", "tag");
		stack.commit();
		world.spawnCircle("c1", 5, -50, 1);
		stack.commit();
		expect(stack.undo()).toBe(true);
		// Back to the box-only state, then one more: seed.
		expect(stack.undo()).toBe(true);
		expect(world.doc.ids()).toEqual(["b1"]);
		// Redo all the way: order survives the rebuild.
		expect(stack.redo()).toBe(true);
		expect(stack.redo()).toBe(true);
		expect(world.doc.ids()).toEqual(["b1", "l1", "c1"]);
		expect(world.labelOf("l1")?.text).toBe("tag");
	}, 10_000);
});
