import { describe, expect, test } from "bun:test";
import {
	BEAM_HALF_WIDTH,
	beamFromSegment,
	circleFromDrag,
	constrainSegment,
	MIN_SPAWN_HALF_SIZE,
	type PickableBody,
	pickAllBodies,
	pickBody,
	pickBodyAtDepth,
	rectFromDrag,
	ToolSession,
	type ToolSessionEvents,
} from "../../src/lib/tools";

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

function circle(id: string, x: number, y: number, r: number): PickableBody {
	return { id, shape: { kind: "circle", radius: r }, x, y, rot: 0 };
}

describe("rectFromDrag", () => {
	test("center and size from two corners", () => {
		const r = rectFromDrag(0, 0, 100, 60);
		expect(r.cx).toBe(50);
		expect(r.cy).toBe(30);
		expect(r.halfWidth).toBe(50);
		expect(r.halfHeight).toBe(30);
	});

	test("handles reversed and negative drags", () => {
		const r = rectFromDrag(100, 60, 0, 0);
		expect(r.cx).toBe(50);
		expect(r.cy).toBe(30);
		expect(r.halfWidth).toBe(50);
		expect(r.halfHeight).toBe(30);
	});

	test("a click (zero drag) clamps to the minimum half-size", () => {
		const r = rectFromDrag(7, -3, 7, -3);
		expect(r.cx).toBe(7);
		expect(r.cy).toBe(-3);
		expect(r.halfWidth).toBe(MIN_SPAWN_HALF_SIZE);
		expect(r.halfHeight).toBe(MIN_SPAWN_HALF_SIZE);
	});
});

describe("circleFromDrag", () => {
	test("center is the drag midpoint, radius is half the larger side", () => {
		const c = circleFromDrag(0, 0, 100, 40);
		expect(c.cx).toBe(50);
		expect(c.cy).toBe(20);
		expect(c.radius).toBe(50);
	});

	test("tall drag: radius follows the vertical side", () => {
		const c = circleFromDrag(0, 0, 40, 100);
		expect(c.radius).toBe(50);
	});

	test("click clamps to the minimum radius", () => {
		expect(circleFromDrag(5, 5, 5, 5).radius).toBe(MIN_SPAWN_HALF_SIZE);
	});
});

describe("pickBody", () => {
	const bodies = [
		box("back", 0, 0, 10, 10),
		box("rotated", 50, 0, 10, 5, Math.PI / 4),
		circle("ball", 100, 0, 8),
	];

	test("box hit and miss", () => {
		expect(pickBody(bodies, 5, 5)).toBe("back");
		expect(pickBody(bodies, 11, 0)).toBeUndefined();
	});

	test("rotated box: point inside the rotated frame hits", () => {
		const d = 10 / Math.SQRT2;
		expect(pickBody(bodies, 50 + d / 2, d / 2)).toBe("rotated");
		expect(pickBody(bodies, 50 + 9, 0)).toBeUndefined();
	});

	test("circle boundary: on the radius hits, just outside misses", () => {
		expect(pickBody(bodies, 108, 0)).toBe("ball");
		expect(pickBody(bodies, 108.5, 0)).toBeUndefined();
	});

	test("later bodies win (topmost)", () => {
		const stacked = [box("bottom", 0, 0, 10, 10), box("top", 0, 0, 5, 5)];
		expect(pickBody(stacked, 0, 0)).toBe("top");
		expect(pickBody(stacked, 8, 0)).toBe("bottom");
	});
});

type Recorded = Array<[string, unknown]>;

function makeSession(pick: (x: number, y: number) => string | undefined): {
	session: ToolSession;
	log: Recorded;
} {
	const log: Recorded = [];
	const events: ToolSessionEvents = {
		onSpawnBox(shape) {
			log.push(["box", shape]);
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
		onCreateLabel(pos) {
			log.push(["create-label", pos]);
			return `label-${log.length}`;
		},
		onCommitLabel(id, text) {
			log.push(["commit-label", { id, text }]);
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
	return { session: new ToolSession(events, pick), log };
}

describe("ToolSession — draw tools", () => {
	test("box drag commits on release with the sized rect", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("box");
		session.pointerDown(0, -50);
		session.pointerMove(80, -10);
		expect(session.preview()).toEqual({
			kind: "rect",
			cx: 40,
			cy: -30,
			halfWidth: 40,
			halfHeight: 20,
		});
		session.pointerUp();
		expect(log).toEqual([
			["box", { cx: 40, cy: -30, halfWidth: 40, halfHeight: 20 }],
		]);
	});

	test("circle drag commits with the midpoint/radius convention", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("circle");
		session.pointerDown(0, 0);
		session.pointerMove(20, 60);
		session.pointerUp();
		expect(log).toEqual([["circle", { cx: 10, cy: 30, radius: 30 }]]);
	});

	test("Escape cancels drawing without spawning", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("box");
		session.pointerDown(0, 0);
		session.pointerMove(30, 30);
		session.cancel();
		session.pointerUp();
		expect(log).toEqual([]);
	});

	test("click without drag still spawns a minimum-size shape", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("circle");
		session.pointerDown(3, 4);
		session.pointerUp();
		expect(log).toEqual([
			["circle", { cx: 3, cy: 4, radius: MIN_SPAWN_HALF_SIZE }],
		]);
	});
});

describe("ToolSession — select tool", () => {
	const pickHit = (x: number, y: number) =>
		x === 5 && y === 5 ? "b1" : undefined;

	test("down on a body selects and starts the drag; move retargets; release ends", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerMove(20, 0);
		session.pointerUp();
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragMove", { x: 20, y: 0 }],
			["dragEnd", null],
		]);
		expect(session.selectedIds.has("b1")).toBe(true);
	});

	test("down on empty space deselects on release (zero-size rubber-band)", () => {
		const { session } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.pointerDown(0, 0);
		expect(session.selectedIds.size).toBe(1); // still selected during the band
		session.pointerUp();
		expect(session.selectedIds.size).toBe(0);
	});

	test("Escape during a drag ends the drag but keeps the selection", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.cancel();
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragEnd", null],
		]);
		expect(session.selectedIds.has("b1")).toBe(true);
	});

	test("Escape when idle clears the selection", () => {
		const { session } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.cancel();
		expect(session.selectedIds.size).toBe(0);
	});

	test("switching tool mid-drag releases the body and the release is a no-op", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.setTool("box");
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragEnd", null],
		]);
		// The subsequent move and release belong to no gesture: no retarget,
		// no second dragEnd.
		session.pointerMove(20, 0);
		session.pointerUp();
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragEnd", null],
		]);
	});
});

describe("ToolSession — tool change terminates gestures (F4)", () => {
	const pickHit = (x: number, y: number) =>
		x === 5 && y === 5 ? "b1" : undefined;

	test("drawing box → circle: the abandoned draw commits nothing on release", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("box");
		session.pointerDown(0, -50);
		session.pointerMove(80, -10);
		session.setTool("circle");
		expect(session.preview()).toBeNull();
		session.pointerMove(90, -20);
		session.pointerUp();
		expect(log).toEqual([]);
	});

	test("drawing circle → select: no commit on release, hover resumes", () => {
		const { session, log } = makeSession(pickHit);
		session.setTool("circle");
		session.pointerDown(0, 0);
		session.pointerMove(20, 60);
		session.setTool("select");
		session.pointerMove(5, 5);
		session.pointerUp();
		expect(log).toEqual([]);
		expect(session.hoverId).toBe("b1");
	});

	test("dragging → box: the release after the switch spawns nothing and ends no drag", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.setTool("box");
		session.pointerMove(30, 30);
		session.pointerUp();
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragEnd", null],
		]);
	});
});

describe("ToolSession — cancel semantics (F6)", () => {
	test("cancel during a drag, then release, ends the drag exactly once", () => {
		const pickHit = (x: number, y: number) =>
			x === 5 && y === 5 ? "b1" : undefined;
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.cancel();
		session.pointerUp();
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragEnd", null],
		]);
	});

	test("cancel during drawing, then release, spawns nothing and the next draw works", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("box");
		session.pointerDown(0, 0);
		session.pointerMove(30, 30);
		session.cancel();
		session.pointerUp();
		expect(log).toEqual([]);
		session.pointerDown(10, 10);
		session.pointerMove(50, 50);
		session.pointerUp();
		expect(log).toEqual([
			["box", { cx: 30, cy: 30, halfWidth: 20, halfHeight: 20 }],
		]);
	});
});

describe("constrainSegment", () => {
	test("keeps already-aligned directions", () => {
		expect(constrainSegment(0, 0, 30, 0)).toEqual({ x: 30, y: 0 });
		const vert = constrainSegment(0, 0, 0, -20);
		expect(vert.x).toBeCloseTo(0, 9);
		expect(vert.y).toBeCloseTo(-20, 9);
		const diag = constrainSegment(0, 0, 10, 10);
		expect(diag.x).toBeCloseTo(10, 9);
		expect(diag.y).toBeCloseTo(10, 9);
	});

	test("snaps near-axis directions to horizontal with length preserved", () => {
		const b = constrainSegment(0, 0, 30, 10);
		const len = Math.hypot(b.x, b.y);
		expect(b.y).toBe(0);
		expect(len).toBeCloseTo(Math.hypot(30, 10), 9);
	});

	test("snaps 30 degrees to 45 degrees", () => {
		const b = constrainSegment(
			0,
			0,
			Math.cos(Math.PI / 6) * 10,
			Math.sin(Math.PI / 6) * 10,
		);
		expect(b.x).toBeCloseTo(Math.cos(Math.PI / 4) * 10, 9);
		expect(b.y).toBeCloseTo(Math.sin(Math.PI / 4) * 10, 9);
	});

	test("zero-length segment stays put", () => {
		expect(constrainSegment(5, 5, 5, 5)).toEqual({ x: 5, y: 5 });
	});
});

describe("beamFromSegment", () => {
	test("centered on the midpoint, oriented along the segment", () => {
		const beam = beamFromSegment(0, 0, 40, 20);
		expect(beam.cx).toBe(20);
		expect(beam.cy).toBe(10);
		expect(beam.rot).toBeCloseTo(Math.atan2(20, 40), 9);
		expect(beam.halfLength).toBeCloseTo(Math.hypot(40, 20) / 2, 9);
		expect(beam.halfWidth).toBe(BEAM_HALF_WIDTH);
	});

	test("reversed direction gives the same box geometry", () => {
		const a = beamFromSegment(0, 0, 40, 0);
		const b = beamFromSegment(40, 0, 0, 0);
		expect(a.cx).toBe(b.cx);
		expect(a.cy).toBe(b.cy);
		expect(Math.abs(a.rot - b.rot)).toBeCloseTo(Math.PI, 9);
	});

	test("a click (zero segment) clamps to the minimum half-length", () => {
		const beam = beamFromSegment(3, 4, 3, 4);
		expect(beam.cx).toBe(3);
		expect(beam.cy).toBe(4);
		expect(beam.halfLength).toBe(MIN_SPAWN_HALF_SIZE);
	});
});

describe("pickBody — polygon", () => {
	const poly: PickableBody = {
		id: "poly",
		shape: {
			kind: "polygon",
			points: [
				{ x: -2, y: -2 },
				{ x: 2, y: -2 },
				{ x: 2, y: 2 },
				{ x: -2, y: 2 },
			],
		},
		x: 10,
		y: -10,
		rot: 0,
	};

	test("hit inside and miss outside, unrotated", () => {
		expect(pickBody([poly], 10, -10)).toBe("poly");
		expect(pickBody([poly], 13, -10)).toBeUndefined();
	});

	test("rotated polygon: local-space test respects the rotation", () => {
		const rotated: PickableBody = { ...poly, rot: Math.PI / 2 };
		// Local point (2,0) maps to world (10,-12) under rot = π/2 in y-down.
		expect(pickBody([rotated], 10, -12)).toBe("poly");
		expect(pickBody([rotated], 13, -10)).toBeUndefined();
	});

	test("concave polygon: the notch misses", () => {
		const lShape: PickableBody = {
			id: "l",
			shape: {
				kind: "polygon",
				points: [
					{ x: 0, y: 0 },
					{ x: 4, y: 0 },
					{ x: 4, y: 1 },
					{ x: 1, y: 1 },
					{ x: 1, y: 4 },
					{ x: 0, y: 4 },
				],
			},
			x: 0,
			y: 0,
			rot: 0,
		};
		expect(pickBody([lShape], 0.5, 2)).toBe("l");
		expect(pickBody([lShape], 3, 3)).toBeUndefined(); // inside the notch
	});
});

describe("ToolSession — polygon tool", () => {
	test("clicks place vertices; close click emits the polygon", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("polygon");
		session.pointerDown(0, 0);
		session.pointerUp();
		session.pointerDown(50, 0);
		session.pointerUp();
		session.pointerMove(25, -20);
		const pv = session.preview();
		if (!pv || pv.kind !== "polygon")
			throw new Error("expected polygon preview");
		expect(pv.points).toHaveLength(3);
		expect(pv.closable).toBe(false);
		session.pointerDown(25, -20);
		session.pointerUp();
		expect(session.closePolygon()).toBe(true);
		expect(log).toEqual([
			[
				"polygon",
				[
					{ x: 0, y: 0 },
					{ x: 50, y: 0 },
					{ x: 25, y: -20 },
				],
			],
		]);
	});

	test("clicking near the first vertex closes without Enter", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("polygon");
		session.pointerDown(0, 0);
		session.pointerUp();
		session.pointerDown(30, 0);
		session.pointerUp();
		session.pointerDown(15, -20);
		session.pointerUp();
		session.pointerMove(0.2, -0.2);
		const pv = session.preview();
		if (!pv || pv.kind !== "polygon")
			throw new Error("expected polygon preview");
		expect(pv.closable).toBe(true);
		session.pointerDown(0.2, -0.2);
		expect(log).toEqual([
			[
				"polygon",
				[
					{ x: 0, y: 0 },
					{ x: 30, y: 0 },
					{ x: 15, y: -20 },
				],
			],
		]);
	});

	test("the close radius is zoom-aware: 12 screen px, not the 0.75-unit floor", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("polygon");
		session.pointerDown(0, 0, {}, 0.5);
		session.pointerUp(0.5);
		session.pointerDown(30, 0, {}, 0.5);
		session.pointerUp(0.5);
		session.pointerDown(15, -20, {}, 0.5);
		session.pointerUp(0.5);
		session.pointerMove(0, -23, {}, 0.5);
		const pv = session.preview();
		if (!pv || pv.kind !== "polygon")
			throw new Error("expected polygon preview");
		// 12 screen px at zoom 0.5 = a 24-world-unit ring; the cursor sits 23
		// units from the first vertex — inside, so closable and a click closes.
		expect(pv.closeRadius).toBeCloseTo(24, 6);
		expect(pv.closable).toBe(true);
		session.pointerDown(0, -23, {}, 0.5);
		expect(log).toHaveLength(1);
	});

	test("Enter with fewer than three vertices does nothing", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("polygon");
		session.pointerDown(0, 0);
		session.pointerUp();
		session.pointerDown(10, 0);
		session.pointerUp();
		expect(session.closePolygon()).toBe(false);
		expect(log).toEqual([]);
	});

	test("Escape discards the in-progress polygon; the tool keeps working", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("polygon");
		session.pointerDown(0, 0);
		session.pointerUp();
		session.pointerDown(10, 0);
		session.pointerUp();
		session.pointerDown(5, -5);
		session.pointerUp();
		session.cancel();
		expect(session.closePolygon()).toBe(false);
		expect(log).toEqual([]);
		session.pointerDown(1, 1);
		expect(session.preview()).not.toBeNull();
	});

	test("switching tool discards the in-progress polygon", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("polygon");
		session.pointerDown(0, 0);
		session.pointerUp();
		session.pointerDown(10, 0);
		session.pointerUp();
		session.pointerDown(5, -5);
		session.pointerUp();
		session.setTool("select");
		session.pointerUp();
		expect(session.closePolygon()).toBe(false);
		expect(log).toEqual([]);
	});
});

describe("ToolSession — line tool", () => {
	test("drag commits the beam on release", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("line");
		session.pointerDown(0, 0);
		session.pointerMove(40, 0);
		expect(session.preview()).toEqual({
			kind: "line",
			cx: 20,
			cy: 0,
			rot: 0,
			halfLength: 20,
			halfWidth: BEAM_HALF_WIDTH,
		});
		session.pointerUp();
		expect(log).toEqual([
			[
				"line",
				{
					cx: 20,
					cy: 0,
					rot: 0,
					halfLength: 20,
					halfWidth: BEAM_HALF_WIDTH,
				},
			],
		]);
	});

	test("two-click flow: stationary release arms, second press commits", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("line");
		session.pointerDown(0, 0);
		session.pointerUp(); // stationary: stays armed
		expect(session.preview()).not.toBeNull();
		session.pointerMove(30, -30);
		session.pointerDown(30, -30); // second click commits
		expect(log).toEqual([
			[
				"line",
				{
					cx: 15,
					cy: -15,
					rot: -Math.PI / 4,
					halfLength: Math.hypot(30, 30) / 2,
					halfWidth: BEAM_HALF_WIDTH,
				},
			],
		]);
		// The release after the committing press is a no-op.
		session.pointerUp();
		expect(log).toHaveLength(1);
	});

	test("shift constrains the committed segment", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("line");
		session.pointerDown(0, 0, { shift: true });
		session.pointerMove(30, 10, { shift: true });
		session.pointerUp();
		const entry = log[0];
		if (!entry) throw new Error("no commit");
		const beam = entry[1] as { cx: number; cy: number };
		expect(beam.cy).toBe(0); // snapped to horizontal, length preserved
		expect(beam.cx).toBeCloseTo(Math.hypot(30, 10) / 2, 9);
	});

	test("shift released before the commit still constrains", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("line");
		session.pointerDown(0, 0, { shift: true });
		session.pointerMove(20, 2); // shift no longer held
		session.pointerUp();
		const entry = log[0];
		if (!entry) throw new Error("no commit");
		const beam = entry[1] as { cy: number };
		expect(beam.cy).toBe(0);
	});

	test("Escape cancels the armed line", () => {
		const { session, log } = makeSession(() => undefined);
		session.setTool("line");
		session.pointerDown(0, 0);
		session.pointerUp(); // armed (two-click mode)
		session.cancel();
		session.pointerMove(30, 0);
		session.pointerDown(30, 0);
		expect(log).toEqual([]); // cancelled: nothing commits
	});
});

describe("ToolSession — joint tool (review F3/F4)", () => {
	/** Two bodies under the pick fn; events record begin/cancel/place. The
	 * required ToolSessionEvents members take no-op bodies (this describe
	 * only exercises the joint placement gesture). */
	function makeJointSession(
		pick: (x: number, y: number) => string | undefined,
	) {
		const log: [string, unknown][] = [];
		const events: ToolSessionEvents = {
			onSpawnBox() {},
			onSpawnCircle() {},
			onSpawnPolygon() {},
			onSpawnLine() {},
			onSpawnFreehand() {},
			onCreateLabel(pos) {
				return `label-${log.length}`;
			},
			onCommitLabel() {},
			onDragStart() {},
			onDragMove() {},
			onDragEnd() {},
			onRotateStart() {},
			onRotate() {},
			onRotateEnd() {},
			onDelete() {},
			onDuplicate(ids) {
				return ids.map((id) => `copy-${id}`);
			},
			onBeginAction() {
				log.push(["begin", null]);
			},
			onCancelAction() {
				log.push(["cancel", null]);
			},
			onPlaceJoint(spec) {
				log.push(["place", spec.jointKind]);
				return "j-new";
			},
		};
		return { session: new ToolSession(events, pick), log };
	}
	const pickBodies = (x: number, y: number) => {
		if (x === 0 && y === 0) return "b1";
		if (x === 40 && y === 0) return "b2";
		return undefined;
	};

	test("second click on empty space aborts the pulley and drops the snapshot", () => {
		const { session, log } = makeJointSession(pickBodies);
		session.setTool("joint"); // setTool itself cancels (pre-existing teardown)
		session.jointKind = "pulley";
		session.pointerDown(0, 0);
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
		]);
		session.pointerDown(100, 100); // empty space
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
		]);
		// No wheel phase lingers: the next press is a fresh arming.
		session.pointerDown(40, 0);
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
			["begin", null],
		]);
	});

	test("second click on bodyA aborts the pulley and drops the snapshot", () => {
		const { session, log } = makeJointSession(pickBodies);
		session.setTool("joint");
		session.jointKind = "pulley";
		session.pointerDown(0, 0);
		session.pointerDown(0, 0); // bodyA again
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
		]);
	});

	test("two-click self-joint abort also drops the snapshot (pre-existing flaw)", () => {
		const { session, log } = makeJointSession(pickBodies);
		session.setTool("joint");
		session.pointerDown(0, 0);
		session.pointerDown(0, 0); // bodyA again — pin abort
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
		]);
	});

	test("changing jointKind mid-placement cancels the gesture (F3)", () => {
		const { session, log } = makeJointSession(pickBodies);
		session.setTool("joint");
		session.jointKind = "pulley";
		session.pointerDown(0, 0); // arm A
		session.pointerDown(40, 0); // arm B — wheel phase
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
		]);
		// The kind radio changes: the gesture dies, the snapshot drops.
		session.setJointKind("rod");
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
		]);
		// The next two clicks place a ROD from ITS OWN two clicks, not a rod
		// from the pulley's clicks.
		session.pointerDown(0, 0);
		session.pointerDown(40, 0);
		expect(log.at(-1)).toEqual(["place", "rod"]);
	});

	test("setJointKind with nothing in progress does not touch selection", () => {
		const { session, log } = makeJointSession(() => undefined);
		session.setTool("select");
		session.pointerDown(100, 100); // empty space: rubber-band, no drag
		session.pointerUp();
		session.selectedIds.add("b1");
		log.length = 0; // setup noise (tool-switch cancels) is not the subject
		session.setTool("joint");
		session.setJointKind("pulley");
		expect(session.jointKind).toBe("pulley");
		expect(session.selectedIds.has("b1")).toBe(true);
		// setTool logs its own teardown-cancel; the IDLE kind switch adds none.
		expect(log).toEqual([["cancel", null]]);
	});
});

describe("pickBodyAtDepth", () => {
	const stacked = [box("bottom", 0, 0, 10, 10), box("top", 0, 0, 5, 5)];
	test("depth 0 is the topmost hit", () => {
		expect(pickBodyAtDepth(stacked, 0, 0, 0)).toBe("top");
	});
	test("depth 1 is the body one beneath", () => {
		expect(pickBodyAtDepth(stacked, 0, 0, 1)).toBe("bottom");
	});
	test("depth past the deepest clamps to the deepest", () => {
		expect(pickBodyAtDepth(stacked, 0, 0, 9)).toBe("bottom");
	});
	test("a miss is undefined at any depth", () => {
		expect(pickBodyAtDepth(stacked, 50, 50, 0)).toBeUndefined();
	});
});

function makeSnapSession(bodies: PickableBody[]): {
	session: ToolSession;
	log: Recorded;
} {
	const log: Recorded = [];
	const centers = new Map<string, { x: number; y: number }>();
	for (const b of bodies) centers.set(b.id, { x: b.x, y: b.y });
	const events: ToolSessionEvents = {
		onSpawnBox() {},
		onSpawnCircle() {},
		onSpawnPolygon() {},
		onSpawnLine() {},
		onSpawnFreehand() {},
		onCreateLabel() {
			return "label-x";
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
		onBeginAction() {
			log.push(["begin", null]);
		},
		onCancelAction() {
			log.push(["cancel", null]);
		},
		pickBodyOnly(x, y, depth = 0) {
			return pickBodyAtDepth(bodies, x, y, depth);
		},
		bodyCenter(id) {
			return centers.get(id);
		},
		onSnapBodies(spec) {
			log.push(["snap", spec]);
		},
	};
	return {
		session: new ToolSession(events, (x, y) => pickBody(bodies, x, y)),
		log,
	};
}

describe("ToolSession — snap tool", () => {
	test("arm on a body, complete on a target: centers align via one event", () => {
		const bodies = [box("mover", 10, 0, 5, 5), box("target", 60, 0, 5, 5)];
		const { session, log } = makeSnapSession(bodies);
		session.setTool("snap");
		session.pointerDown(10, 0);
		// setTool's teardown-cancel lands first (see the joint tests).
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
		]);
		session.pointerMove(60, 0);
		expect(session.preview()).toMatchObject({
			kind: "snap",
			from: { x: 10, y: 0 },
			to: { x: 60, y: 0 },
			toBody: true,
		});
		session.pointerDown(60, 0);
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["snap", { moverId: "mover", targetId: "target" }],
		]);
		expect(session.preview()).toBeNull();
	});

	test("second click on empty space aborts and drops the snapshot", () => {
		const bodies = [box("mover", 10, 0, 5, 5), box("target", 60, 0, 5, 5)];
		const { session, log } = makeSnapSession(bodies);
		session.setTool("snap");
		session.pointerDown(10, 0);
		session.pointerDown(200, 200);
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
		]);
	});

	test("clicking the mover again aborts (self-snap refused)", () => {
		const bodies = [box("mover", 10, 0, 5, 5)];
		const { session, log } = makeSnapSession(bodies);
		session.setTool("snap");
		session.pointerDown(10, 0);
		session.pointerDown(12, 0);
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
		]);
	});

	test("Alt+click on a stacked target picks the body beneath", () => {
		// bottom spans x 0-20; top spans x 0-10 — a click at 5 hits both
		// (topmost first), so alt picks bottom.
		const bodies = [
			box("bottom", 10, 0, 10, 5),
			box("top", 5, 0, 5, 5),
			box("mover", 60, 0, 5, 5),
		];
		const { session, log } = makeSnapSession(bodies);
		session.setTool("snap");
		session.pointerDown(60, 0); // arm on the lone mover
		session.pointerMove(5, 0);
		session.pointerDown(5, 0, { alt: true }); // beneath the topmost
		expect(log.at(-1)).toEqual([
			"snap",
			{ moverId: "mover", targetId: "bottom" },
		]);
	});

	test("Alt+click at the mover pick cycles the mover one deeper", () => {
		const bodies = [
			box("under", 10, 0, 10, 5),
			box("over", 5, 0, 5, 5),
			box("target", 60, 0, 5, 5),
		];
		const { session, log } = makeSnapSession(bodies);
		session.setTool("snap");
		session.pointerDown(5, 0); // arms on "over" (topmost)
		session.pointerDown(5, 0, { alt: true }); // cycle: mover becomes "under"
		session.pointerMove(60, 0);
		session.pointerDown(60, 0);
		expect(log.at(-1)).toEqual([
			"snap",
			{ moverId: "under", targetId: "target" },
		]);
	});
});

function makeJointModesSession(bodies: PickableBody[]): {
	session: ToolSession;
	log: Recorded;
} {
	const log: Recorded = [];
	const events: ToolSessionEvents = {
		onSpawnBox() {},
		onSpawnCircle() {},
		onSpawnPolygon() {},
		onSpawnLine() {},
		onSpawnFreehand() {},
		onCreateLabel() {
			return "label-x";
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
		onBeginAction() {
			log.push(["begin", null]);
		},
		onCancelAction() {
			log.push(["cancel", null]);
		},
		onPlaceJoint(spec) {
			log.push([
				"place",
				{ a: spec.bodyAId, b: spec.bodyBId, kind: spec.jointKind },
			]);
			return "j1";
		},
		onPlaceJointChain(spec) {
			log.push([
				"chain",
				{ ids: spec.ids, kind: spec.jointKind, x: spec.x, y: spec.y },
			]);
			return spec.ids.length - 1;
		},
		onPlaceSnapJoint(spec) {
			log.push(["snapjoint", spec]);
			return "sj1";
		},
		pickAllBodies(x, y) {
			return pickAllBodies(bodies, x, y);
		},
	};
	return {
		session: new ToolSession(events, (x, y) => pickBody(bodies, x, y)),
		log,
	};
}

describe("ToolSession — joint modes", () => {
	test("pickAllBodies returns the stack topmost-first", () => {
		const stacked = [box("bottom", 0, 0, 10, 10), box("top", 0, 0, 5, 5)];
		expect(pickAllBodies(stacked, 0, 0)).toEqual(["top", "bottom"]);
		expect(pickAllBodies(stacked, 50, 50)).toEqual([]);
	});

	test("Shift+click on a stack places the chain immediately", () => {
		const bodies = [box("bottom", 0, 0, 10, 10), box("top", 0, 0, 5, 5)];
		const { session, log } = makeJointModesSession(bodies);
		session.setTool("joint");
		session.pointerDown(0, 0, { shift: true });
		expect(log.at(-1)).toEqual([
			"chain",
			{ ids: ["top", "bottom"], kind: "pin", x: 0, y: 0 },
		]);
	});

	test("Shift+click on a lone body arms; a shift second click chains A with it", () => {
		const bodies = [box("solo", 0, 0, 5, 5), box("far", 60, 0, 5, 5)];
		const { session, log } = makeJointModesSession(bodies);
		session.setTool("joint");
		session.pointerDown(0, 0, { shift: true });
		expect(log.some(([k]) => k === "chain")).toBe(false);
		session.pointerDown(60, 0, { shift: true });
		// Arming + shift: chain ids = [bodyA, ...stack minus bodyA].
		expect(log.at(-1)).toEqual([
			"chain",
			{ ids: ["solo", "far"], kind: "pin", x: 60, y: 0 },
		]);
	});

	test("Snap-Join mode snaps the second body to the first, joint at shared center", () => {
		const bodies = [box("target", 0, 0, 10, 5), box("mover", 60, 0, 5, 5)];
		const { session, log } = makeJointModesSession(bodies);
		session.setTool("joint");
		session.snapJoin = true;
		session.pointerDown(0, 0);
		session.pointerDown(60, 0);
		expect(log.at(-1)).toEqual([
			"snapjoint",
			{
				targetId: "target",
				moverId: "mover",
				jointKind: "pin",
				targetPoint: { x: 0, y: 0 },
				moverPoint: { x: 60, y: 0 },
			},
		]);
		expect(session.selectedIds.has("sj1")).toBe(true);
	});

	test("Snap-Join second click on the target aborts", () => {
		const bodies = [box("target", 0, 0, 10, 5)];
		const { session, log } = makeJointModesSession(bodies);
		session.setTool("joint");
		session.snapJoin = true;
		session.pointerDown(0, 0);
		session.pointerDown(2, 0);
		expect(log).toEqual([
			["cancel", null],
			["begin", null],
			["cancel", null],
		]);
	});
});
