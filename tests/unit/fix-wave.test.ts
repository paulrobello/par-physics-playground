import { expect, spyOn, test } from "bun:test";
import { createToolEvents } from "../../src/lib/interaction";
import { bodiesInRect, pickLabel, ToolSession } from "../../src/lib/tools";
import * as geometry from "../../src/lib/triangulate";
import {
	cleanPolygon,
	completeDecomposition,
	polygonSignedArea,
	triangulate,
} from "../../src/lib/triangulate";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

async function fixture(paused = true) {
	const world = await PhysicsWorld.create();
	const stack = new UndoStack(
		() => {
			world.syncLiveTransforms();
			return world.doc.all();
		},
		(entities) => world.restoreSnapshot(entities),
	);
	stack.commit();
	let session: ToolSession;
	const events = createToolEvents(world, {
		isPaused: () => paused,
		selectedIds: () => session.selectedIds,
		pruneSelection: (id) => {
			session.selectedIds.delete(id);
			if (session.hoverId === id) session.hoverId = undefined;
		},
		beginAction: () => stack.beginAction(),
		cancelAction: () => stack.cancelAction(),
		recordAction: () => stack.commit(),
	});
	session = new ToolSession(
		events,
		(x, y) =>
			pickLabel(world.labels(), x, y, 10) ?? [...world.bodies.keys()][0],
		(rect) => bodiesInRect(world.doc.all(), rect),
	);
	return { world, stack, session, events };
}

test("F11 simulate-delete-undo restores the LIVE pre-delete position in one step", async () => {
	const { world, stack, events } = await fixture();
	events.onSpawnBox({ cx: 10, cy: -50, halfWidth: 1, halfHeight: 1 });
	const id = world.doc.ids()[0]!;
	for (let i = 0; i < 120; i++) world.step();
	const before = { ...world.bodyPosition(id)! };
	expect(before.y).toBeGreaterThan(-45);
	events.onDelete([id]);
	expect(stack.depths().undo).toBe(2);
	expect(stack.undo()).toBe(true);
	expect(world.bodyPosition(id)?.y).toBeCloseTo(before.y, 5);
	expect(stack.redo()).toBe(true);
	expect(world.doc.get(id)).toBeUndefined();
});

test("F11 simulate-move-undo restores gesture-start pose, not last action pose", async () => {
	const { world, stack, events, session } = await fixture();
	events.onSpawnBox({ cx: 10, cy: -50, halfWidth: 1, halfHeight: 1 });
	const id = world.doc.ids()[0]!;
	for (let i = 0; i < 120; i++) world.step();
	const before = { ...world.bodyPosition(id)! };
	session.selectedIds.add(id);
	events.onDragStart(id, before);
	events.onDragMove({ x: 30, y: -70 });
	events.onDragEnd();
	expect(stack.undo()).toBe(true);
	expect(world.bodyPosition(id)?.x).toBeCloseTo(before.x, 5);
	expect(world.bodyPosition(id)?.y).toBeCloseTo(before.y, 5);
	expect(stack.redo()).toBe(true);
	expect(world.bodyPosition(id)?.x).toBeCloseTo(30, 5);
});

test("F5 running terrain supports move, rotate, duplicate, delete and undo", async () => {
	const { world, stack, events, session } = await fixture(false);
	world.spawnCircle("terrain", 10, -30, 3, true);
	stack.commit();
	session.selectedIds.add("terrain");
	events.onDragStart("terrain", { x: 10, y: -30 });
	expect(events.activeJoint).toBeNull();
	events.onDragMove({ x: 40, y: -20 });
	events.onDragEnd();
	expect(world.bodyPosition("terrain")?.x).toBe(40);
	events.onRotateStart();
	events.onRotate(0.4);
	events.onRotateEnd();
	expect(world.bodyRotation("terrain")).toBeCloseTo(0.4);
	const copy = events.onDuplicate(["terrain"])[0]!;
	expect(world.bodies.get(copy)?.isFixed()).toBe(true);
	events.onDelete([copy]);
	expect(world.doc.get(copy)).toBeUndefined();
	stack.undo();
	expect(world.bodies.get(copy)?.isFixed()).toBe(true);
});

test("F6 running drag-delete-move-release is safe and next body is grabbable", async () => {
	const { world, events, session } = await fixture(false);
	world.spawnBox("a", 10, -30, 2, 2);
	world.spawnBox("b", 30, -30, 2, 2);
	session.pointerDown(10, -30);
	expect(events.activeJoint).not.toBeNull();
	session.requestDelete();
	expect(events.activeJoint).toBeNull();
	expect(() => {
		session.pointerMove(20, -20);
		session.pointerUp();
	}).not.toThrow();
	session.pointerDown(30, -30);
	expect(events.activeJoint).not.toBeNull();
	session.pointerUp();
});

test("F8 existing-label edit is one action and undo restores old text", async () => {
	const { world, stack, session } = await fixture();
	session.setTool("text");
	session.pointerDown(10, -30);
	session.editTextKey("old");
	session.commitText();
	const id = world.doc.ids()[0]!;
	session.pointerDown(10, -30);
	session.editTextKey(" new");
	session.commitText();
	expect(world.labels()).toHaveLength(1);
	expect(world.labelOf(id)?.text).toBe("old new");
	expect(stack.depths().undo).toBe(2);
	stack.undo();
	expect(world.labelOf(id)?.text).toBe("old");
	stack.redo();
	expect(world.labelOf(id)?.text).toBe("old new");
});

test("F9 mixed rubber-band and rotation includes labels and survives undo/redo", async () => {
	const { world, stack, events, session } = await fixture();
	world.spawnBox("b", 10, -30, 2, 2);
	world.addLabel("l", 20, -30);
	world.setLabelText("l", "tag");
	stack.commit();
	expect(
		bodiesInRect(world.doc.all(), {
			cx: 15,
			cy: -30,
			halfWidth: 10,
			halfHeight: 5,
		}),
	).toEqual(["b", "l"]);
	session.selectedIds = new Set(["b", "l"]);
	events.onRotateStart();
	events.onRotate(Math.PI / 2);
	events.onRotateEnd();
	expect(world.bodyRotation("b")).toBeCloseTo(Math.PI / 2);
	expect(world.labelOf("l")?.rot).toBeCloseTo(Math.PI / 2);
	expect(pickLabel(world.labels(), 20, -28, 10)).toBe("l");
	stack.undo();
	expect(world.labelOf("l")?.rot).toBe(0);
	stack.redo();
	expect(world.labelOf("l")?.rot).toBeCloseTo(Math.PI / 2);
});

test("F12 rejects self-intersection and degenerate rings without body or history", async () => {
	const { world, stack, events } = await fixture();
	events.onSpawnPolygon([
		{ x: 0, y: 0 },
		{ x: 5, y: 5 },
		{ x: 0, y: 5 },
		{ x: 5, y: 0 },
	]);
	expect(world.bodies.size).toBe(0);
	expect(stack.canUndo).toBe(false);
	expect(
		world.spawnPolygon("bad", [
			{ x: 0, y: 0 },
			{ x: 1, y: 0 },
			{ x: 2, y: 0 },
		]),
	).toBeUndefined();
	expect(
		world
			.spawnPolygon("good", [
				{ x: 0, y: 0 },
				{ x: 4, y: 0 },
				{ x: 2, y: 2 },
				{ x: 4, y: 4 },
				{ x: 0, y: 4 },
			])
			?.numColliders(),
	).toBe(3);
});

test("F12 nonzero-area crossing ring is rejected at the tool registration boundary", async () => {
	const { world, stack, events } = await fixture();
	const ring = [
		{ x: 10, y: -30 },
		{ x: 14, y: -30 },
		{ x: 11, y: -29 },
		{ x: 13, y: -33 },
	];
	const cleaned = cleanPolygon(ring);
	expect(cleaned).not.toBeNull();
	expect(Math.abs(polygonSignedArea(cleaned!))).toBe(1);
	expect(geometry.polygonIsSimple(cleaned!)).toBe(false);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		events.onSpawnPolygon(ring);
		expect(world.bodies.size).toBe(0);
		expect(world.world.bodies.len()).toBe(1); // built-in ground only
		expect(world.doc.ids()).toEqual([]);
		expect(stack.depths()).toEqual({ undo: 0, redo: 0 });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Polygon rejected"),
		);
	} finally {
		warn.mockRestore();
	}
});

test("F12 incomplete triangulation is rejected through spawnPolygon without registration or history", async () => {
	const { world, stack, events } = await fixture();
	const ring = [
		{ x: 10, y: -30 },
		{ x: 14, y: -30 },
		{ x: 14, y: -26 },
		{ x: 10, y: -26 },
	];
	expect(geometry.polygonIsSimple(ring)).toBe(true);
	expect(polygonSignedArea(ring)).toBe(16);
	const clipping = spyOn(geometry, "triangulate").mockReturnValue([[0, 1, 2]]);
	const warn = spyOn(console, "warn").mockImplementation(() => {});
	try {
		events.onSpawnPolygon(ring);
		expect(clipping).toHaveBeenCalled();
		expect(world.bodies.size).toBe(0);
		expect(world.world.bodies.len()).toBe(1);
		expect(world.doc.ids()).toEqual([]);
		expect(stack.depths()).toEqual({ undo: 0, redo: 0 });
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Polygon rejected"),
		);
	} finally {
		clipping.mockRestore();
		warn.mockRestore();
	}
	// The mock and rejected action must not poison the next valid commit.
	events.onSpawnPolygon(ring);
	expect(world.bodies.size).toBe(1);
	expect(stack.depths()).toEqual({ undo: 1, redo: 0 });
	stack.undo();
	expect(world.bodies.size).toBe(0);
});

test("F12 incomplete decomposition fails coverage check", () => {
	const ring = [
		{ x: 0, y: 0 },
		{ x: 4, y: 0 },
		{ x: 4, y: 4 },
		{ x: 0, y: 4 },
	];
	expect(completeDecomposition(ring, [])).toBe(false);
	expect(completeDecomposition(ring, [[0, 1, 2]])).toBe(false);
	expect(completeDecomposition(ring, triangulate(ring))).toBe(true);
});

test("F13 triangulation retains original indices through duplicates and collinear cleanup", () => {
	const ring = [
		{ x: 0, y: 0 },
		{ x: 2, y: 0 },
		{ x: 4, y: 0 },
		{ x: 4, y: 0 },
		{ x: 4, y: 4 },
		{ x: 0, y: 4 },
		{ x: 0, y: 0 },
	];
	const triangles = triangulate(ring);
	expect(triangles).toHaveLength(2);
	expect(triangles.flat()).not.toContain(1);
	expect(triangles.flat()).not.toContain(3);
	expect(completeDecomposition(ring, triangles)).toBe(true);
	expect(Math.abs(polygonSignedArea(cleanPolygon(ring)!))).toBe(16);
});

test("F14 reset notifies removal, clears handles/selection/hover and history", async () => {
	const { world, stack, events, session } = await fixture(false);
	events.onSpawnBox({ cx: 10, cy: -30, halfWidth: 2, halfHeight: 2 });
	const id = world.doc.ids()[0]!;
	session.selectedIds.add(id);
	session.hoverId = id;
	events.onDragStart(id, { x: 10, y: -30 });
	world.reset();
	stack.clear();
	expect(events.activeJoint).toBeNull();
	expect(session.selectedIds.size).toBe(0);
	expect(session.hoverId).toBeUndefined();
	expect(stack.canUndo).toBe(false);
	expect(stack.canRedo).toBe(false);
});
