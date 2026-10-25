import { describe, expect, test } from "bun:test";
import {
	ANGLE_SNAP_STEP,
	circleFromCenterDrag,
	DEFAULT_GRID_SIZE,
	rectFromDrag,
	snapAngle,
	snapToGrid,
	ToolSession,
} from "../../src/lib/tools";

describe("draw option helpers", () => {
	test("snapToGrid rounds to the nearest multiple", () => {
		expect(snapToGrid(45, 32)).toBe(32);
		expect(snapToGrid(50, 32)).toBe(64);
		expect(snapToGrid(-10, 32)).toBeCloseTo(0, 12);
		expect(snapToGrid(0, 32)).toBe(0);
		expect(snapToGrid(31.9, 32)).toBe(32);
	});

	test("snapAngle quantizes to 15° steps, including negatives", () => {
		expect(snapAngle(0.01)).toBeCloseTo(0, 12);
		expect(snapAngle(Math.PI / 5)).toBeCloseTo(Math.PI / 6, 12); // 36° → 30°
		expect(snapAngle(-Math.PI / 5)).toBeCloseTo(-Math.PI / 6, 12);
		expect(snapAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
		expect(snapAngle(Math.PI / 2 + 0.1)).toBeCloseTo(Math.PI / 2, 12);
		expect(ANGLE_SNAP_STEP).toBeCloseTo(Math.PI / 12, 12);
	});

	test("rectFromDrag square flag: the larger drag dimension wins", () => {
		const r = rectFromDrag(0, 0, 100, 40, true);
		expect(r.halfWidth).toBe(50);
		expect(r.halfHeight).toBe(50);
		expect(r.cx).toBe(50);
		expect(r.cy).toBe(20);
		// Without the flag the drag rect is unchanged.
		const free = rectFromDrag(0, 0, 100, 40);
		expect(free.halfWidth).toBe(50);
		expect(free.halfHeight).toBe(20);
	});

	test("rectFromDrag square flag keeps the minimum half-size floor", () => {
		const r = rectFromDrag(0, 0, 0.2, 0.2, true);
		expect(r.halfWidth).toBeGreaterThanOrEqual(0.5);
		expect(r.halfWidth).toBe(r.halfHeight);
	});

	test("circleFromCenterDrag anchors at the press point", () => {
		const c = circleFromCenterDrag(10, 20, 60, 45);
		expect(c.cx).toBe(10);
		expect(c.cy).toBe(20);
		// max(|50|, |25|) = 50
		expect(c.radius).toBe(50);
	});

	test("circleFromCenterDrag floors at the minimum radius", () => {
		const c = circleFromCenterDrag(5, 5, 5.2, 5.1);
		expect(c.radius).toBeGreaterThanOrEqual(0.5);
		expect(c.cx).toBe(5);
	});

	test("DEFAULT_GRID_SIZE matches the 1x-zoom adaptive default", () => {
		expect(DEFAULT_GRID_SIZE).toBe(32);
	});
});

/** Full-event recorder session (mirrors the thruster-aim test harness). */
function makeOptionsSession() {
	const spawned: {
		boxes: Array<{
			cx: number;
			cy: number;
			halfWidth: number;
			halfHeight: number;
		}>;
		circles: Array<{ cx: number; cy: number; radius: number }>;
	} = { boxes: [], circles: [] };
	const session = new ToolSession(
		{
			onBeginAction() {},
			onCancelAction() {},
			labelAt: () => undefined,
			onSpawnBox(shape) {
				spawned.boxes.push(shape);
			},
			onSpawnCircle(shape) {
				spawned.circles.push(shape);
			},
			onSpawnPolygon() {},
			onSpawnLine() {},
			onSpawnFreehand() {},
			onCreateLabel() {
				return "l1";
			},
			onCommitLabel() {},
			onDragStart() {},
			onDragMove() {},
			onDragEnd() {},
			onRotateStart() {},
			onRotate() {},
			onRotateEnd() {},
			onDelete() {},
			onDuplicate() {
				return [];
			},
		},
		() => undefined,
		() => [],
	);
	return { session, spawned };
}

describe("ToolSession draw options", () => {
	test("grid snap snaps box drags to the spacing", () => {
		const { session, spawned } = makeOptionsSession();
		session.gridSnap = true;
		session.gridSize = 32;
		session.setTool("box");
		session.pointerDown(3, 7);
		session.pointerMove(45, 60);
		session.pointerUp();
		expect(spawned.boxes).toHaveLength(1);
		// Snapped corners: (0,0) → (32,64): center (16,32), halves (16,32).
		const b = spawned.boxes[0]!;
		expect(b.cx).toBe(16);
		expect(b.cy).toBe(32);
		expect(b.halfWidth).toBe(16);
		expect(b.halfHeight).toBe(32);
	});

	test("snap off leaves box drags free", () => {
		const { session, spawned } = makeOptionsSession();
		session.setTool("box");
		session.pointerDown(3, 7);
		session.pointerMove(45, 60);
		session.pointerUp();
		const b = spawned.boxes[0]!;
		expect(b.cx).toBeCloseTo(24, 10);
		expect(b.halfWidth).toBeCloseTo(21, 10);
	});

	test("circle from center: center at the press point", () => {
		const { session, spawned } = makeOptionsSession();
		session.circleFromCenter = true;
		session.setTool("circle");
		session.pointerDown(100, 100);
		session.pointerMove(160, 130);
		session.pointerUp();
		const c = spawned.circles[0]!;
		expect(c.cx).toBe(100);
		expect(c.cy).toBe(100);
		expect(c.radius).toBe(60); // max(|60|, |30|)
	});

	test("circle without center toggle keeps midpoint behavior", () => {
		const { session, spawned } = makeOptionsSession();
		session.setTool("circle");
		session.pointerDown(100, 100);
		session.pointerMove(160, 130);
		session.pointerUp();
		const c = spawned.circles[0]!;
		expect(c.cx).toBe(130);
		expect(c.cy).toBe(115);
		expect(c.radius).toBe(30); // half the larger side
	});

	test("square constrain forces equal halves", () => {
		const { session, spawned } = makeOptionsSession();
		session.constrainBox = true;
		session.setTool("box");
		session.pointerDown(0, 0);
		session.pointerMove(100, 40);
		session.pointerUp();
		const b = spawned.boxes[0]!;
		expect(b.halfWidth).toBe(50);
		expect(b.halfHeight).toBe(50);
	});

	test("line drawing snaps both endpoints under snap", () => {
		const { session } = makeOptionsSession();
		const lines: number[] = [];
		// Rebuild a session whose onSpawnLine records geometry.
		const s = new ToolSession(
			{
				onBeginAction() {},
				onCancelAction() {},
				labelAt: () => undefined,
				onSpawnBox() {},
				onSpawnCircle() {},
				onSpawnPolygon() {},
				onSpawnLine(beam) {
					lines.push(
						beam.cx,
						beam.cy,
						beam.rot,
						beam.halfLength,
						beam.halfWidth,
					);
				},
				onSpawnFreehand() {},
				onCreateLabel() {
					return "l1";
				},
				onCommitLabel() {},
				onDragStart() {},
				onDragMove() {},
				onDragEnd() {},
				onRotateStart() {},
				onRotate() {},
				onRotateEnd() {},
				onDelete() {},
				onDuplicate() {
					return [];
				},
			},
			() => undefined,
			() => [],
		);
		s.gridSnap = true;
		s.gridSize = 32;
		s.setTool("line");
		s.pointerDown(10, 3);
		s.pointerMove(90, 28);
		s.pointerUp();
		// Snapped (0,0)→(96,32): center (48,16), angle atan2(32,96), length.
		expect(lines[0]).toBe(48);
		expect(lines[1]).toBe(16);
	});

	test("preview reflects center/square toggles", () => {
		const { session } = makeOptionsSession();
		session.circleFromCenter = true;
		session.constrainBox = true;
		session.setTool("circle");
		session.pointerDown(50, 50);
		session.pointerMove(80, 65);
		const circle = session.preview();
		expect(circle && circle.kind === "circle" && circle.cx === 50).toBe(true);
		session.setTool("box");
		session.pointerDown(0, 0);
		session.pointerMove(80, 40);
		const rect = session.preview();
		expect(
			rect && rect.kind === "rect" && rect.halfWidth === rect.halfHeight,
		).toBe(true);
	});
});
