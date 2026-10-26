import { describe, expect, test } from "bun:test";
import { createToolEvents } from "../../src/lib/interaction";
import { MIN_SHAPE_HALF_SIZE, ToolSession } from "../../src/lib/tools";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * The gizmo scale op end-to-end through the real wiring (world + events +
 * session): a corner drag scales the body's shape with a collider rebuild and
 * a mass recompute, floors at the degenerate-shape minimum, positions scale
 * around the box center, and the whole drag lands as ONE undo action (a
 * release, a cancel, and a tool switch each behave like the rotate-gesture
 * convention). Runs against a real Rapier world (loads in bun).
 */

/** Fixed gizmo geom the session hit-tests against: box [0,0]-[100,50]. */
const geom = (): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	zoom: number;
} => ({ minX: 0, minY: 0, maxX: 100, maxY: 50, zoom: 1 });

/** Body a's box at (0,−300) halfW 10: [−10,−310]−[10,−290]. */
const boxGeom = (): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	zoom: number;
} => ({ minX: -10, minY: -310, maxX: 10, maxY: -290, zoom: 1 });

/** The pair's combined box: [−110,−310]−[110,−290]. */
const pairGeom = (): {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
	zoom: number;
} => ({ minX: -110, minY: -310, maxX: 110, maxY: -290, zoom: 1 });

describe("gizmo scale op (world + events + session)", () => {
	test("corner drag scales a box: shape, collider, mass, position", async () => {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world, {
			selectedIds: () => session.selectedIds,
		});
		events.gizmoGeom = boxGeom;
		let pickableId: string | undefined;
		const session = new ToolSession(events, () => pickableId);
		world.spawnBox("a", 0, -300, 10, 5);
		session.selectedIds = new Set(["a"]);

		// The body's box [−10,−310]−[10,−290]; the TL corner (−10,−310),
		// anchored at BR (10,−290): a pointer at TWICE the corner→anchor
		// distance doubles the applied factor.
		session.pointerDown(-10, -310, {}, 1);
		session.pointerMove(-30, -330, {}, 1);
		session.pointerUp(1);

		const e = world.doc.get("a");
		if (e?.kind !== "body") throw new Error("box a missing");
		if (e.shape.kind !== "box") throw new Error("shape kind drifted");
		expect(e.shape.halfWidth).toBe(20);
		expect(e.shape.halfHeight).toBe(10);
		const body = world.bodies.get("a");
		if (!body) throw new Error("body gone after scale");
		// Collider rebuilt for the new geometry (the cuboid half extents).
		const collider = body.collider(0);
		if (!collider) throw new Error("collider missing after scale");
		const he = (
			collider.shape as unknown as { halfExtents: { x: number; y: number } }
		).halfExtents;
		expect(he.x).toBeCloseTo(20, 4);
		expect(he.y).toBeCloseTo(10, 4);
		// Mass recomputed from the new colliders: density 1 × area ×4.
		expect(body.mass()).toBeCloseTo(20 * 10 * 4, 4);
		// A single body's box center IS the box center: position kept.
		expect(body.translation().x).toBe(0);
		expect(body.translation().y).toBe(-300);
	}, 10_000);

	test("scale floors at the degenerate minimum per shape kind", async () => {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world, {
			selectedIds: () => session.selectedIds,
		});
		events.gizmoGeom = geom;
		const session = new ToolSession(events, () => undefined);
		world.spawnBox("b", 0, -300, 10, 10);
		world.spawnCircle("c", 200, -300, 5);
		const polygon = [
			{ x: -20, y: -20 },
			{ x: 20, y: -20 },
			{ x: 20, y: 20 },
			{ x: -20, y: 20 },
		];
		if (!world.spawnPolygon("p", polygon, false, "ink")) {
			throw new Error("polygon spawn refused");
		}
		session.selectedIds = new Set(["b", "c", "p"]);

		// Combined box of the three bodies: [−20,−310]−[210,−290]; the TL
		// corner (−20,−310), anchored at BR (210,−290): a pointer ON the
		// anchor gives factor 0, flooring every shape.
		events.gizmoGeom = () => ({
			minX: -20,
			minY: -310,
			maxX: 210,
			maxY: -290,
			zoom: 1,
		});
		session.pointerDown(-20, -310, {}, 1);
		session.pointerMove(210, -290, {}, 1);
		session.pointerUp(1);

		for (const id of ["b", "c", "p"] as const) {
			const e = world.doc.get(id);
			if (e?.kind !== "body") throw new Error(`${id} missing`);
			if (e.shape.kind === "box") {
				expect(e.shape.halfWidth).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
				expect(e.shape.halfHeight).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
			} else if (e.shape.kind === "circle") {
				expect(e.shape.radius).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
			} else {
				let max = 0;
				for (const pt of e.shape.points) {
					max = Math.max(max, Math.abs(pt.x), Math.abs(pt.y));
				}
				expect(max).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
			}
		}
	}, 10_000);

	test("multi-select scales positions around the box center in ONE undo action", async () => {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world, {
			selectedIds: () => session.selectedIds,
			beginAction: () => undo.beginAction(),
			cancelAction: () => undo.cancelAction(),
			recordAction: () => undo.commit(),
		});
		const undo = new (await import("../../src/lib/undo")).UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => {
				world.restoreSnapshot(entities);
				session.selectedIds.clear();
			},
		);
		undo.commit();
		events.gizmoGeom = pairGeom;
		const session = new ToolSession(events, () => undefined);
		world.spawnBox("a", -100, -300, 10, 10);
		world.spawnBox("b", 100, -300, 10, 10);
		session.selectedIds = new Set(["a", "b"]);

		const beforeA = world.bodyPosition("a");
		if (!beforeA) throw new Error("box a missing");
		// Box spans [-110,-310]-[110,-290]; the TL corner (−110,−310), anchored
		// at BR (110,−290): a pointer at TWICE the corner→anchor distance
		// doubles the factor around the box center (0,−300).
		session.pointerDown(-110, -310, {}, 1);
		session.pointerMove(-330, -330, {}, 1);
		session.pointerUp(1);

		const pa = world.bodyPosition("a");
		const pb = world.bodyPosition("b");
		if (!pa || !pb) throw new Error("bodies gone after scale");
		expect(pa.x).toBeCloseTo(-200, 4);
		expect(pb.x).toBeCloseTo(200, 4);
		expect(pa.y).toBeCloseTo(beforeA.y, 4);
		// ONE undo action for the whole drag (both bodies, one entry).
		expect(undo.depths().undo).toBe(1);
		expect(undo.undo()).toBe(true);
		const ra = world.bodyPosition("a");
		if (!ra) throw new Error("restore lost body a");
		expect(ra.x).toBeCloseTo(beforeA.x, 4);
	}, 10_000);

	test("cancel mid-drag leaves no leaked undo snapshot (the pulley lesson)", async () => {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world, {
			selectedIds: () => session.selectedIds,
			beginAction: () => undo.beginAction(),
			cancelAction: () => undo.cancelAction(),
			recordAction: () => undo.commit(),
		});
		const undo = new (await import("../../src/lib/undo")).UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => {
				world.restoreSnapshot(entities);
				session.selectedIds.clear();
			},
		);
		undo.commit();
		events.gizmoGeom = boxGeom;
		const session = new ToolSession(events, () => undefined);
		world.spawnBox("a", 0, -300, 10, 10);
		session.selectedIds = new Set(["a"]);

		// Start a corner drag from the TL corner (−10,−310) — anchor BR
		// (10,−290) — and Escape mid-drag at TWICE the corner→anchor distance:
		// the rotate-gesture convention commits the partial state (one entry),
		// never a dangling snapshot the next action inherits.
		session.pointerDown(-10, -310, {}, 1);
		session.pointerMove(-30, -330, {}, 1);
		session.cancel();
		expect(undo.depths().undo).toBe(1);

		// A click with no drag (press + release, zero movement) dedupes: the
		// depth stays at 1, no empty entry.
		session.pointerDown(-10, -310, {}, 1);
		session.pointerUp(1);
		expect(undo.depths().undo).toBe(1);
	}, 10_000);
});
