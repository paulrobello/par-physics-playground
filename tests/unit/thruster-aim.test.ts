/**
 * Thruster drag-to-aim: press mounts the thruster, dragging previews the
 * thrust direction, release converts the drag to a body-local angle (via
 * the events layer) and lands mount + aim as ONE undo step. A drag below
 * THRUSTER_AIM_MIN_DRAG, Escape, or a tool switch commits null (keeps the
 * placed angle, never drops the snapshot). Aim math + session phases
 * pinned here.
 */
import { describe, expect, test } from "bun:test";
import { aimAngleLocal } from "../../src/lib/thruster";
import { ToolSession, type ToolSessionEvents } from "../../src/lib/tools";

describe("aimAngleLocal", () => {
	test("drag right on an unrotated body aims along +x (0)", () => {
		expect(aimAngleLocal(50, 0, 0)).toBeCloseTo(0, 9);
	});

	test("drag up (−y in a y-down world) aims up (−π/2)", () => {
		expect(aimAngleLocal(0, -50, 0)).toBeCloseTo(-Math.PI / 2, 9);
	});

	test("the body's rotation is subtracted (angle is body-local)", () => {
		expect(aimAngleLocal(50, 0, Math.PI / 4)).toBeCloseTo(-Math.PI / 4, 9);
	});

	test("result wraps into (−π, π]", () => {
		// world π minus rot −π = 2π → wraps to 0
		expect(aimAngleLocal(-1, 0, -Math.PI)).toBeCloseTo(0, 9);
	});
});

/** Full required-events stub: logs onPlaceThruster/onThrusterAim/onCancelAction. */
function makeAimSession(pick: (x: number, y: number) => string | undefined): {
	session: ToolSession;
	placed: Array<{ bodyId: string; x: number; y: number }>;
	aimed: Array<{ id: string; worldAngle: number | null }>;
	cancelCount(): number;
} {
	const placed: Array<{ bodyId: string; x: number; y: number }> = [];
	const aimed: Array<{ id: string; worldAngle: number | null }> = [];
	let cancels = 0;
	const noop = () => undefined;
	const events: ToolSessionEvents = {
		onSpawnBox: noop,
		onSpawnCircle: noop,
		onSpawnPolygon: noop,
		onSpawnLine: noop,
		onSpawnFreehand: noop,
		onCreateLabel: () => "label-1",
		onCommitLabel: noop,
		onDragStart: noop,
		onDragMove: noop,
		onDragEnd: noop,
		onRotateStart: noop,
		onRotate: noop,
		onRotateEnd: noop,
		onDelete: noop,
		onDuplicate: (ids) => [...ids],
		onPlaceThruster: (spec) => {
			placed.push(spec);
			return "thr-1";
		},
		onThrusterAim: (spec) => {
			aimed.push(spec);
		},
		onCancelAction: () => {
			cancels += 1;
		},
	};
	return {
		session: new ToolSession(events, pick),
		placed,
		aimed,
		cancelCount: () => cancels,
	};
}

describe("thruster-aim tool session", () => {
	test("press-mount then drag then release commits the drag angle", () => {
		const { session, placed, aimed } = makeAimSession(() => "body-1");
		session.setTool("thruster");
		session.pointerDown(0, 0);
		session.pointerMove(30, 30);
		session.pointerMove(60, 60);
		session.pointerUp();
		expect(placed).toHaveLength(1);
		expect(aimed).toHaveLength(1);
		expect(aimed[0]!.id).toBe("thr-1");
		expect(aimed[0]!.worldAngle).toBeCloseTo(Math.PI / 4, 9);
	});

	test("a tiny drag commits with a null angle (keeps 0)", () => {
		const { session, aimed } = makeAimSession(() => "body-1");
		session.setTool("thruster");
		session.pointerDown(0, 0);
		session.pointerMove(1, 0);
		session.pointerUp();
		expect(aimed).toHaveLength(1);
		expect(aimed[0]!.worldAngle).toBeNull();
	});

	test("cancel during aim commits as-is (null) — the mount is kept", () => {
		const { session, aimed, cancelCount } = makeAimSession(() => "body-1");
		session.setTool("thruster"); // fires the generic idle-switch cancel
		expect(cancelCount()).toBe(1); // pre-existing generic switch semantics
		session.pointerDown(0, 0);
		session.pointerMove(20, 0);
		session.cancel(); // Escape during aim
		expect(aimed).toHaveLength(1);
		expect(aimed[0]!.worldAngle).toBeNull();
		expect(cancelCount()).toBe(1); // unchanged: no snapshot drop
	});
});
