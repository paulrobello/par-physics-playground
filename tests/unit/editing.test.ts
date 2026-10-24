import { describe, expect, test } from "bun:test";
import { defaultBody, SceneDocument } from "../../src/lib/document";
import { createToolEvents, freshBodyId } from "../../src/lib/interaction";
import {
	angleFromVerticalDrag,
	bodiesInRect,
	DUPLICATE_OFFSET,
	type PickableBody,
	rubberRect,
	ToolSession,
	type ToolSessionEvents,
} from "../../src/lib/tools";
import { PhysicsWorld } from "../../src/lib/world";

function box(
	id: string,
	x: number,
	y: number,
	hw: number,
	hh: number,
	rot = 0,
): PickableBody {
	return {
		id,
		shape: { kind: "box", halfWidth: hw, halfHeight: hh },
		x,
		y,
		rot,
	};
}

describe("SceneDocument", () => {
	test("add/get/remove keep insertion order and transform updates", () => {
		const doc = new SceneDocument();
		doc.add(
			defaultBody("a", { kind: "box", halfWidth: 1, halfHeight: 1 }, 0, 0),
		);
		doc.add(defaultBody("b", { kind: "circle", radius: 2 }, 5, 5));
		expect(doc.ids()).toEqual(["a", "b"]);
		const b = doc.get("b");
		if (b?.kind !== "body") throw new Error("body b missing");
		expect(b.shape.kind).toBe("circle");
		expect(b.materialId).toBe("ink");
		expect(b.isStatic).toBe(false);
		expect(doc.setTransform("b", 7, 8, Math.PI / 2)).toBe(true);
		expect(doc.get("b")?.x).toBe(7);
		expect(doc.get("b")?.rot).toBeCloseTo(Math.PI / 2);
		expect(doc.setTransform("missing", 0, 0, 0)).toBe(false);
		expect(doc.remove("a")).toBe(true);
		expect(doc.ids()).toEqual(["b"]);
		expect(doc.remove("a")).toBe(false);
	});

	test("duplicate math: DUPLICATE_OFFSET and defaultBody copy carry shape + transform", () => {
		expect(DUPLICATE_OFFSET).toEqual({ x: 1, y: -1 });
		const entity = defaultBody(
			"src",
			{ kind: "box", halfWidth: 2, halfHeight: 3 },
			10,
			-20,
			0.5,
		);
		const copy = {
			...entity,
			id: "copy",
			x: entity.x + DUPLICATE_OFFSET.x,
			y: entity.y + DUPLICATE_OFFSET.y,
		};
		expect(copy.x).toBe(11);
		expect(copy.y).toBe(-21);
		expect(copy.rot).toBe(0.5);
		expect(copy.shape).toEqual(entity.shape);
	});

	test("angleFromVerticalDrag scales vertical travel to radians", () => {
		expect(angleFromVerticalDrag(0, 100)).toBeCloseTo(1.0, 9); // 0.01 rad/unit
		expect(angleFromVerticalDrag(50, -50)).toBeCloseTo(-1.0, 9);
		expect(angleFromVerticalDrag(3, 3)).toBe(0);
	});
});

describe("bodiesInRect (rubber-band selection)", () => {
	const bodies = [
		box("in1", 0, 0, 5, 5),
		box("in2", 20, -10, 5, 5),
		box("edge", 30, 0, 5, 5),
		box("out", 100, 100, 5, 5),
	];

	test("centers inside the band are selected in pick order", () => {
		const rect = rubberRect(-10, -20, 25, 20);
		expect(bodiesInRect(bodies, rect)).toEqual(["in1", "in2"]);
	});

	test("boundary counts as inside (inclusive edges)", () => {
		const rect = rubberRect(25, -5, 35, 5);
		expect(bodiesInRect(bodies, rect)).toEqual(["edge"]);
	});

	test("empty band (click) selects nothing", () => {
		expect(bodiesInRect(bodies, rubberRect(3, 3, 3, 3))).toEqual([]);
	});
});

function makeSession(
	pick: (x: number, y: number) => string | undefined,
	pickRect?: (rect: {
		cx: number;
		cy: number;
		halfWidth: number;
		halfHeight: number;
	}) => readonly string[],
): { session: ToolSession; log: Array<[string, unknown]> } {
	const log: Array<[string, unknown]> = [];
	const events: ToolSessionEvents = {
		onSpawnBox(shape) {
			log.push(["box", shape]);
		},
		onCreateLabel(pos) {
			log.push(["create-label", pos]);
			return `label-${log.length}`;
		},
		onCommitLabel(id, text) {
			log.push(["commit-label", { id, text }]);
		},
		onSpawnCircle(shape) {
			log.push(["circle", shape]);
		},
		onSpawnPolygon(points) {
			log.push(["polygon", points]);
		},
		onSpawnLine(beam) {
			log.push(["line", beam]);
		},
		onSpawnFreehand(result) {
			log.push(["freehand", result.kind]);
		},
		onDragStart(id, grab) {
			log.push(["dragStart", { id, grab }]);
		},
		onDragMove(target) {
			log.push(["dragMove", target]);
		},
		onDragEnd() {
			log.push(["dragEnd", null]);
		},
		onRotateStart() {
			log.push(["rotateStart", null]);
		},
		onRotate(delta) {
			log.push(["rotate", delta]);
		},
		onRotateEnd() {
			log.push(["rotateEnd", null]);
		},
		onDelete(ids) {
			log.push(["delete", ids]);
		},
		onDuplicate(ids) {
			log.push(["duplicate", ids]);
			return ids.map((id) => `copy-${id}`);
		},
	};
	return { session: new ToolSession(events, pick, pickRect), log };
}

describe("ToolSession — multi-select and editing (P2-T1)", () => {
	const pickHit = (x: number, y: number) =>
		x === 5 && y === 5 ? "b1" : x === 50 && y === 50 ? "b2" : undefined;

	test("rubber-band replaces the selection on release", () => {
		const { session } = makeSession(pickHit, (rect) =>
			rect.halfWidth > 1 ? ["b1", "b2"] : [],
		);
		session.pointerDown(0, 0);
		session.pointerMove(30, 30);
		expect(session.rubberBand()).toEqual({
			cx: 15,
			cy: 15,
			halfWidth: 15,
			halfHeight: 15,
		});
		session.pointerUp();
		expect(session.selectedIds.size).toBe(2);
		expect(session.rubberBand()).toBeNull();
	});

	test("shift+drag rubber-band adds to the existing selection", () => {
		const { session } = makeSession(pickHit, () => ["b2"]);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.pointerDown(0, 0, { shift: true });
		session.pointerMove(20, 20);
		session.pointerUp();
		expect([...session.selectedIds].sort()).toEqual(["b1", "b2"]);
	});

	test("plain band after a selection replaces it; click clears", () => {
		const { session } = makeSession(pickHit, (rect) =>
			rect.halfWidth > 1 ? ["b1"] : [],
		);
		session.pointerDown(0, 0);
		session.pointerMove(20, 20);
		session.pointerUp();
		expect([...session.selectedIds]).toEqual(["b1"]);
		session.pointerDown(9, 9); // zero-size band = click = clear
		session.pointerUp();
		expect(session.selectedIds.size).toBe(0);
	});

	test("shift-click toggles membership; toggling off starts no drag", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.pointerDown(50, 50, { shift: true });
		expect([...session.selectedIds].sort()).toEqual(["b1", "b2"]);
		session.pointerMove(60, 60); // hover only — no drag started
		session.pointerUp();
		session.pointerDown(50, 50, { shift: true }); // toggle b2 off
		expect([...session.selectedIds]).toEqual(["b1"]);
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragEnd", null],
		]);
	});

	test("drag from a selected body moves the set; new-body press selects solo", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.pointerDown(50, 50, { shift: true });
		session.pointerUp(); // shift-click added b2 without starting a drag
		session.pointerDown(50, 50); // plain press on selected b2 keeps the set
		expect(session.selectedIds.size).toBe(2);
		session.pointerMove(55, 55);
		session.pointerUp();
		const starts = log.filter(([kind]) => kind === "dragStart");
		expect(starts).toHaveLength(2);
		expect(starts[1]).toEqual([
			"dragStart",
			{ id: "b2", grab: { x: 50, y: 50 } },
		]);
	});

	test("R+press starts a rotate gesture with cumulative deltas", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.pointerDown(5, 5, { rotate: true });
		expect(log).toContainEqual(["rotateStart", null]);
		session.pointerMove(5, 150);
		session.pointerMove(5, 250);
		const rotates = log.filter(([kind]) => kind === "rotate");
		expect(rotates[0]?.[1]).toBeCloseTo(1.45, 9);
		expect(rotates[1]?.[1]).toBeCloseTo(2.45, 9);
		session.pointerUp();
		session.pointerMove(5, 5000); // after release: hover, no rotate
		expect(rotates).toHaveLength(2);
	});

	test("requestDelete emits onDelete and clears the selection", () => {
		const { session, log } = makeSession(pickHit);
		expect(session.requestDelete()).toBe(false);
		session.pointerDown(5, 5);
		session.pointerUp();
		expect(session.requestDelete()).toBe(true);
		expect(log).toContainEqual(["delete", ["b1"]]);
		expect(session.selectedIds.size).toBe(0);
	});

	test("requestDuplicate selects the copies returned by onDuplicate", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		expect(session.requestDuplicate()).toBe(true);
		expect(log).toContainEqual(["duplicate", ["b1"]]);
		expect([...session.selectedIds]).toEqual(["copy-b1"]);
	});

	test("Escape clears the selection when idle (already selected set)", () => {
		const { session } = makeSession(pickHit, () => ["b1", "b2"]);
		session.pointerDown(0, 0);
		session.pointerMove(30, 30);
		session.pointerUp();
		session.cancel();
		expect(session.selectedIds.size).toBe(0);
	});
});

describe("PhysicsWorld editing operations", () => {
	test("moveBody/rotateBody update document and simulation; wake applies", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("a", 0, -50, 5, 5);
		world.moveBody("a", 10, -60);
		expect(world.bodyPosition("a")).toEqual({ x: 10, y: -60 });
		expect(world.doc.get("a")?.x).toBe(10);
		world.rotateBody("a", 0.5);
		expect(world.bodyRotation("a")).toBeCloseTo(0.5, 6);
		expect(world.doc.get("a")?.rot).toBeCloseTo(0.5, 6);
	}, 10_000);

	test("duplicateBody offsets a copy with the same shape; removeBody removes both views", async () => {
		const world = await PhysicsWorld.create();
		world.spawnCircle("src", 0, -50, 4);
		const newId = world.duplicateBody(
			"src",
			"dup",
			DUPLICATE_OFFSET.x,
			DUPLICATE_OFFSET.y,
		);
		expect(newId).toBe("dup");
		expect(world.bodyPosition("dup")).toEqual({ x: 1, y: -51 });
		expect(world.shapeOf("dup")).toEqual({ kind: "circle", radius: 4 });
		expect(world.doc.ids()).toEqual(["src", "dup"]);
		world.removeBody("src");
		expect(world.bodies.has("src")).toBe(false);
		expect(world.doc.get("src")).toBeUndefined();
		expect(world.bodyPosition("src")).toBeUndefined();
		expect(world.duplicateBody("missing", "x", 1, 1)).toBeUndefined();
	}, 10_000);

	test("createToolEvents duplicate routes through the world with fresh ids", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("a", 0, -50, 5, 5);
		const events = createToolEvents(world);
		const [newId] = events.onDuplicate(["a"]);
		expect(newId).toBeDefined();
		const id = freshBodyId();
		expect(id).toMatch(/^body-\d+$/);
		expect(id).not.toBe(newId);
	}, 10_000);

	test("duplicateBody copies the LIVE transform, not the stale document one", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("faller", 0, -100, 5, 5);
		// Let it fall well below the spawn point (y-down world: falls are +y).
		for (let i = 0; i < 60; i++) world.step();
		const live = world.bodyPosition("faller");
		if (!live) throw new Error("faller missing");
		expect(live.y).toBeGreaterThan(-99); // moved from the spawn point
		world.duplicateBody("faller", "copy", 1, -1);
		const copy = world.bodyPosition("copy");
		if (!copy) throw new Error("copy missing");
		expect(copy.x).toBeCloseTo(live.x + 1, 6);
		expect(copy.y).toBeCloseTo(live.y - 1, 6);
	}, 10_000);

	test("syncLiveTransforms folds live sim transforms into the document", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("faller", 0, -100, 5, 5);
		// Spawn-time doc coords: (0, -100). The sim then moves the body.
		for (let i = 0; i < 60; i++) world.step();
		expect(world.doc.get("faller")?.y).toBe(-100); // stale before sync
		world.syncLiveTransforms();
		const live = world.bodyPosition("faller");
		if (!live) throw new Error("faller missing");
		const doc = world.doc.get("faller");
		if (!doc) throw new Error("doc entry missing");
		expect(doc.x).toBeCloseTo(live.x, 9);
		expect(doc.y).toBeCloseTo(live.y, 9);
		expect(doc.rot).toBeCloseTo(world.bodyRotation("faller") ?? NaN, 9);
		// A second sync is idempotent once the doc matches.
		world.syncLiveTransforms();
		expect(world.doc.get("faller")?.y).toBeCloseTo(live.y, 9);
	}, 10_000);

	test("culling a selected body prunes it from the selection set", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("faller", 0, -100, 5, 5);
		const selection = new Set<string>(["faller"]);
		// Side effect only: createToolEvents installs world.onRemove.
		createToolEvents(world, {
			pruneSelection: (id) => {
				selection.delete(id);
			},
		});
		expect(selection.has("faller")).toBe(true);
		const body = world.bodies.get("faller");
		if (!body) throw new Error("spawned body missing");
		body.setTranslation({ x: 0, y: 2000 }, true);
		world.step(); // culls "faller" and fires onRemove
		expect(world.bodies.has("faller")).toBe(false);
		expect(selection.has("faller")).toBe(false);
	}, 10_000);
});
