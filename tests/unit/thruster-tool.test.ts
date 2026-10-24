/**
 * P4-T5 review fix I1: the thruster placement tool. The entity machinery,
 * glyph, panel, and undo existed, but no user-facing tool could create one
 * (review 129d71c..46ebb72 Important #1). These tests pin the tool flow: a
 * single click on a body mounts a thruster at the click point (body-local
 * anchor), default strength, on; empty-space clicks refuse without consuming
 * an undo snapshot.
 */
import { describe, expect, test } from "bun:test";
import { createToolEvents } from "../../src/lib/interaction";
import { worldPointToLocal } from "../../src/lib/joint";
import { THRUSTER_DEFAULT_STRENGTH } from "../../src/lib/thruster";
import { ToolSession } from "../../src/lib/tools";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

describe("ToolSession thruster tool", () => {
	function makeSession(pickId: string | undefined) {
		const placed: {
			bodyId: string;
			x: number;
			y: number;
		}[] = [];
		const begun: number[] = [];
		const cancelled: number[] = [];
		const session = new ToolSession(
			{
				onSpawnBox() {},
				onSpawnCircle() {},
				onSpawnPolygon() {},
				onSpawnLine() {},
				onSpawnFreehand() {},
				onCreateLabel: () => "label-1",
				onCommitLabel() {},
				onDragStart() {},
				onDragMove() {},
				onDragEnd() {},
				onRotateStart() {},
				onRotate() {},
				onRotateEnd() {},
				onDelete() {},
				onDuplicate: () => [undefined],
				onPlaceThruster: (spec) => {
					placed.push(spec);
					return `thruster-${placed.length}`;
				},
				onBeginAction: () => begun.push(1),
				onCancelAction: () => cancelled.push(1),
			},
			() => pickId,
		);
		session.tool = "thruster";
		return { session, placed, begun, cancelled };
	}

	test("a press on a body places a thruster at the click point and selects it", () => {
		const { session, placed, begun, cancelled } = makeSession("box-1");
		session.pointerDown(12, -8);
		expect(placed).toEqual([{ bodyId: "box-1", x: 12, y: -8 }]);
		expect([...session.selectedIds]).toEqual(["thruster-1"]);
		expect(begun).toHaveLength(1);
		expect(cancelled).toHaveLength(0);
	});

	test("a press on empty space refuses: no placement, snapshot dropped", () => {
		const { session, placed, begun, cancelled } = makeSession(undefined);
		session.pointerDown(12, -8);
		expect(placed).toHaveLength(0);
		expect(session.selectedIds.size).toBe(0);
		expect(begun).toHaveLength(1);
		expect(cancelled).toHaveLength(1);
	});
});

describe("createToolEvents thruster wiring", () => {
	async function fixture() {
		const world = await PhysicsWorld.create();
		const stack = new UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => world.restoreSnapshot(entities),
		);
		stack.commit();
		const events = createToolEvents(world, {
			beginAction: () => stack.beginAction(),
			cancelAction: () => stack.cancelAction(),
			recordAction: () => stack.commit(),
		});
		return { world, stack, events };
	}

	test("onPlaceThruster mounts a default thruster at the click point, undoable", async () => {
		const { world, stack, events } = await fixture();
		events.onSpawnBox({ cx: 10, cy: -50, halfWidth: 3, halfHeight: 3 });
		const bodyId = world.doc.ids()[0] as string;
		const click = { x: 12, y: -48 };

		const id = events.onPlaceThruster?.({ bodyId, ...click });
		expect(id).toBeDefined();

		const entity = world.doc.get(id as string);
		expect(entity?.kind).toBe("thruster");
		if (entity?.kind !== "thruster") return;
		expect(entity.bodyId).toBe(bodyId);
		expect(entity.strength).toBe(THRUSTER_DEFAULT_STRENGTH);
		expect(entity.on).toBe(true);
		expect(entity.angle).toBe(0);
		// The anchor is the click point expressed in the body's local frame.
		const local = worldPointToLocal(click.x, click.y, 10, -50, 0);
		expect(entity.anchorX).toBeCloseTo(local.x, 6);
		expect(entity.anchorY).toBeCloseTo(local.y, 6);
		expect(world.thrusterEntities()).toHaveLength(1);

		expect(stack.undo()).toBe(true);
		expect(world.thrusterEntities()).toHaveLength(0);
	});

	test("a refused placement (body gone) returns undefined and drops the snapshot", async () => {
		const { world, stack, events } = await fixture();
		const before = stack.depths();
		const id = events.onPlaceThruster?.({
			bodyId: "nope",
			x: 0,
			y: 0,
		});
		expect(id).toBeUndefined();
		expect(world.thrusterEntities()).toHaveLength(0);
		expect(stack.depths()).toEqual(before);
	});
});
