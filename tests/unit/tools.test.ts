import { describe, expect, test } from "bun:test";
import {
	circleFromDrag,
	type PickableBody,
	pickBody,
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
		expect(r.halfWidth).toBe(0.5);
		expect(r.halfHeight).toBe(0.5);
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
		expect(circleFromDrag(5, 5, 5, 5).radius).toBe(0.5);
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
		onDragStart(id, grab) {
			log.push(["dragStart", { id, grab }]);
		},
		onDragMove(target) {
			log.push(["dragMove", target]);
		},
		onDragEnd() {
			log.push(["dragEnd", null]);
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
		expect(log).toEqual([["circle", { cx: 3, cy: 4, radius: 0.5 }]]);
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
		expect(session.selectedId).toBe("b1");
	});

	test("down on empty space deselects", () => {
		const { session } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.pointerDown(0, 0);
		expect(session.selectedId).toBeUndefined();
	});

	test("Escape during a drag ends the drag but keeps the selection", () => {
		const { session, log } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.cancel();
		expect(log).toEqual([
			["dragStart", { id: "b1", grab: { x: 5, y: 5 } }],
			["dragEnd", null],
		]);
		expect(session.selectedId).toBe("b1");
	});

	test("Escape when idle clears the selection", () => {
		const { session } = makeSession(pickHit);
		session.pointerDown(5, 5);
		session.pointerUp();
		session.cancel();
		expect(session.selectedId).toBeUndefined();
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
