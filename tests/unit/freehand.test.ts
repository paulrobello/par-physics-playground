import { describe, expect, test } from "bun:test";
import {
	cleanClosedStroke,
	decideFreehand,
	FREEHAND_MIN_SAMPLE_DISTANCE,
	FreehandStrokeBuilder,
	fitCircle,
	simplifyClosed,
	simplifyOpen,
	strokeExtent,
	strokeLength,
} from "../../src/lib/freehand";
import { ToolSession } from "../../src/lib/tools";
import type { Vec2 } from "../../src/lib/triangulate";

/** n points evenly spaced around a circle (optionally perturbed). */
function circlePoints(
	cx: number,
	cy: number,
	r: number,
	n: number,
	wobble = 0,
	seed = 1,
): Vec2[] {
	const out: Vec2[] = [];
	let s = seed;
	const rand = () => {
		s = (s * 16807) % 2147483647;
		return (s / 2147483647 - 0.5) * 2; // [-0.5, 0.5]
	};
	for (let i = 0; i <= n; i++) {
		const a = (i / n) * Math.PI * 2;
		const rr = r * (1 + wobble * rand());
		out.push({ x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a) });
	}
	return out;
}

/** Polygon corners as a dense stroke: many samples along each edge. */
function densePolyline(cornerPoints: readonly Vec2[], per: number): Vec2[] {
	const out: Vec2[] = [];
	const all = [...cornerPoints, cornerPoints[0] as Vec2];
	for (let i = 0; i < all.length - 1; i++) {
		const a = all[i] as Vec2;
		const b = all[i + 1] as Vec2;
		for (let j = 0; j < per; j++) {
			const t = j / per;
			out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
		}
	}
	return out;
}

describe("freehand capture", () => {
	test("decimation drops samples closer than the minimum distance", () => {
		const builder = new FreehandStrokeBuilder();
		expect(builder.add(0, 0)).toBe(true);
		expect(builder.add(FREEHAND_MIN_SAMPLE_DISTANCE / 2, 0)).toBe(false);
		expect(builder.add(FREEHAND_MIN_SAMPLE_DISTANCE, 0)).toBe(true);
		expect(builder.add(0, FREEHAND_MIN_SAMPLE_DISTANCE * 3)).toBe(true);
		expect(builder.points).toHaveLength(3);
	});

	test("decimation keeps the first sample regardless of input", () => {
		const builder = new FreehandStrokeBuilder();
		expect(builder.add(5, 5)).toBe(true);
		expect(builder.points).toEqual([{ x: 5, y: 5 }]);
	});

	test("non-finite samples are dropped", () => {
		const builder = new FreehandStrokeBuilder();
		expect(builder.add(Number.NaN, 0)).toBe(false);
		expect(builder.add(0, Number.POSITIVE_INFINITY)).toBe(false);
		expect(builder.points).toHaveLength(0);
	});
});

describe("freehand cleanup", () => {
	test("closure duplicate and retrace tail are removed", () => {
		// Draw a loop back to the start, overlap it, and retrace a little.
		const stroke: Vec2[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
			{ x: 0, y: 0 }, // closure duplicate
			{ x: 0.1, y: 0.05 }, // overlap retrace (within the 0.3 endpoint tolerance)
			{ x: 0.2, y: 0.1 }, // also within the endpoint tolerance of (0,0)
		];
		const cleaned = cleanClosedStroke(stroke);
		expect(cleaned).toHaveLength(4);
		expect(cleaned[0]).toEqual({ x: 0, y: 0 });
		expect(cleaned.at(-1)).toEqual({ x: 0, y: 10 });
	});

	test("a trailing point outside the tolerance is kept", () => {
		const stroke: Vec2[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
			{ x: 2, y: 2 },
		];
		const cleaned = cleanClosedStroke(stroke);
		expect(cleaned).toHaveLength(5);
	});

	test("a stroke closed inside the 0.03-0.12 band commits without a spike", () => {
		// Endpoints 1.6 apart on a 20-extent square = 0.08·extent: inside the
		// closure band (0.12·extent) but past the old 0.03·extent cleanup
		// radius. The tail must be stripped up to the closure radius.
		const stroke: Vec2[] = densePolyline(
			[
				{ x: 0, y: 0 },
				{ x: 20, y: 0 },
				{ x: 20, y: 20 },
				{ x: 0, y: 20 },
			],
			10,
		);
		stroke.push({ x: 1.6, y: 0 }); // 0.08·extent from the start
		const closureRadius = 20 * 0.12;
		const cleaned = cleanClosedStroke(stroke);
		const last = cleaned.at(-1) as Vec2;
		const first = cleaned[0] as Vec2;
		// No residual point of the closure approach survives the cleanup.
		expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(
			closureRadius,
		);
		// The snap decision still sees a clean rectangle.
		const decision = decideFreehand(stroke);
		expect(decision.kind).toBe("rect");
	});

	test("a stroke closed at the old 0.03 radius behaves as before", () => {
		const stroke: Vec2[] = densePolyline(
			[
				{ x: 0, y: 0 },
				{ x: 20, y: 0 },
				{ x: 20, y: 20 },
				{ x: 0, y: 20 },
			],
			10,
		);
		stroke.push({ x: 0.5, y: 0 }); // 0.025·extent from the start
		const closureRadius = 20 * 0.12;
		const cleaned = cleanClosedStroke(stroke);
		const last = cleaned.at(-1) as Vec2;
		const first = cleaned[0] as Vec2;
		expect(Math.hypot(last.x - first.x, last.y - first.y)).toBeGreaterThan(
			closureRadius,
		);
		expect(decideFreehand(stroke).kind).toBe("rect");
	});
});

describe("simplification", () => {
	test("simplifyOpen keeps endpoints and collapses straight runs", () => {
		const line: Vec2[] = [];
		for (let i = 0; i <= 20; i++) line.push({ x: i, y: 0 });
		const simplified = simplifyOpen(line, 0.1);
		expect(simplified).toEqual([
			{ x: 0, y: 0 },
			{ x: 20, y: 0 },
		]);
	});

	test("simplifyOpen keeps a real corner", () => {
		const corner: Vec2[] = [
			{ x: 0, y: 0 },
			{ x: 5, y: 0 },
			{ x: 10, y: 5 },
		];
		expect(simplifyOpen(corner, 0.1)).toEqual(corner);
	});

	test("simplifyClosed drops the seam duplicate and keeps corners", () => {
		const square: Vec2[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 0 },
			{ x: 10, y: 10 },
			{ x: 0, y: 10 },
		];
		const simplified = simplifyClosed(densePolyline(square, 12), 0.1);
		expect(simplified).toHaveLength(4);
	});

	test("strokeExtent and strokeLength basics", () => {
		expect(
			strokeExtent([
				{ x: 0, y: 0 },
				{ x: 4, y: 3 },
			]),
		).toBe(4);
		expect(strokeExtent([])).toBe(0);
		expect(
			strokeLength([
				{ x: 0, y: 0 },
				{ x: 3, y: 4 },
			]),
		).toBe(5);
	});
});

describe("circle fit", () => {
	test("exact ring fits exactly", () => {
		const fit = fitCircle(circlePoints(10, -5, 7, 32));
		if (!fit) throw new Error("no fit");
		expect(Math.abs(fit.cx - 10)).toBeLessThan(1e-6);
		expect(Math.abs(fit.cy + 5)).toBeLessThan(1e-6);
		expect(Math.abs(fit.radius - 7)).toBeLessThan(1e-6);
	});
});

describe("decideFreehand — snap decisions", () => {
	test("a drawn circle snaps to a circle primitive", () => {
		const decision = decideFreehand(circlePoints(0, 0, 20, 40, 0.02));
		expect(decision.kind).toBe("circle");
		if (decision.kind !== "circle") return;
		expect(Math.abs(decision.cx)).toBeLessThan(0.5);
		expect(Math.abs(decision.cy)).toBeLessThan(0.5);
		expect(Math.abs(decision.radius - 20)).toBeLessThan(0.5);
	});

	test("a square snaps to a rect primitive", () => {
		const decision = decideFreehand(
			densePolyline(
				[
					{ x: 0, y: 0 },
					{ x: 20, y: 0 },
					{ x: 20, y: 20 },
					{ x: 0, y: 20 },
				],
				10,
			),
		);
		expect(decision.kind).toBe("rect");
		if (decision.kind !== "rect") return;
		expect(Math.abs(decision.cx - 10)).toBeLessThan(0.1);
		expect(Math.abs(decision.cy - 10)).toBeLessThan(0.1);
		expect(Math.abs(decision.halfWidth - 10)).toBeLessThan(0.1);
		expect(Math.abs(decision.halfHeight - 10)).toBeLessThan(0.1);
	});

	test("a rotated rectangle snaps to a rotated rect primitive", () => {
		// 3-4-5 style rotation: corners of a 30x20 rect rotated by atan2(1,2).
		const angle = Math.atan2(1, 2);
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		const center = { x: 100, y: 100 };
		const local = [
			{ x: -15, y: -10 },
			{ x: 15, y: -10 },
			{ x: 15, y: 10 },
			{ x: -15, y: 10 },
		];
		const corners = local.map((p) => ({
			x: center.x + p.x * cos - p.y * sin,
			y: center.y + p.x * sin + p.y * cos,
		}));
		const decision = decideFreehand(densePolyline(corners, 12));
		expect(decision.kind).toBe("rect");
		if (decision.kind !== "rect") return;
		expect(Math.abs(decision.cx - 100)).toBeLessThan(0.2);
		expect(Math.abs(decision.cy - 100)).toBeLessThan(0.2);
		expect(Math.abs(decision.halfWidth - 15)).toBeLessThan(0.2);
		expect(Math.abs(decision.halfHeight - 10)).toBeLessThan(0.2);
		// angle folds to the equivalent quadrant orientation
		const fold = Math.abs(
			(((decision.rot - angle) % (Math.PI / 2)) + Math.PI / 2) % (Math.PI / 2),
		);
		expect(fold).toBeLessThan(0.01);
	});

	test("a triangle snaps to a 3-vertex polygon", () => {
		const decision = decideFreehand(
			densePolyline(
				[
					{ x: 100, y: -80 },
					{ x: 160, y: -80 },
					{ x: 130, y: -140 },
				],
				12,
			),
		);
		expect(decision.kind).toBe("polygon");
		if (decision.kind !== "polygon") return;
		expect(decision.points).toHaveLength(3);
	});

	test("a wobbly near-circle above the error gate stays freeform", () => {
		const decision = decideFreehand(circlePoints(0, 0, 20, 40, 0.25));
		expect(decision.kind).toBe("polygon");
		if (decision.kind !== "polygon") return;
		expect(decision.points.length).toBeGreaterThanOrEqual(3);
	});

	test("a near-closed stroke just past the closure gate stays open", () => {
		// Square loop but the endpoints sit 0.2·extent apart — open.
		const stroke: Vec2[] = densePolyline(
			[
				{ x: 0, y: 0 },
				{ x: 20, y: 0 },
				{ x: 20, y: 20 },
				{ x: 0, y: 20 },
			],
			10,
		);
		stroke.push({ x: 4, y: 0 }); // end 4 units from start = 0.2·extent
		const decision = decideFreehand(stroke);
		expect(decision.kind).toBe("chain");
	});

	test("an open squiggle becomes a simplified chain", () => {
		const stroke: Vec2[] = [
			{ x: 0, y: 0 },
			{ x: 10, y: 10 },
			{ x: 20, y: 0 },
			{ x: 30, y: 10 },
		];
		const decision = decideFreehand(stroke);
		expect(decision.kind).toBe("chain");
		if (decision.kind !== "chain") return;
		expect(decision.points.length).toBeGreaterThanOrEqual(2);
		expect(decision.points[0]).toEqual({ x: 0, y: 0 });
		expect(decision.points.at(-1)).toEqual({ x: 30, y: 10 });
	});

	test("degenerate input yields none", () => {
		expect(decideFreehand([]).kind).toBe("none");
		expect(decideFreehand([{ x: 1, y: 1 }]).kind).toBe("none");
		expect(
			decideFreehand([
				{ x: 0, y: 0 },
				{ x: 0, y: 0 },
			]).kind,
		).toBe("none");
	});
});

describe("freehand tool session flow", () => {
	function makeSession() {
		const spawned: import("../../src/lib/freehand").FreehandDecision[] = [];
		const session = new ToolSession(
			{
				onSpawnBox() {},
				onSpawnCircle() {},
				onSpawnPolygon() {},
				onSpawnLine() {},
				onSpawnFreehand(result) {
					spawned.push(result);
				},
				onCreateLabel() {
					return "label-1";
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
		);
		return { session, spawned };
	}

	test("drag-release commits the snapped circle", () => {
		const { session, spawned } = makeSession();
		session.setTool("freehand");
		const ring = circlePoints(0, 0, 20, 40, 0.02);
		session.pointerDown(ring[0]!.x, ring[0]!.y);
		for (const p of ring) session.pointerMove(p.x, p.y);
		session.pointerUp();
		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.kind).toBe("circle");
	});

	test("cancel (Escape/tool switch) discards the stroke", () => {
		const { session, spawned } = makeSession();
		session.setTool("freehand");
		session.pointerDown(0, 0);
		for (const p of circlePoints(0, 0, 20, 40)) session.pointerMove(p.x, p.y);
		session.cancel();
		session.pointerUp();
		expect(spawned).toHaveLength(0);
	});

	test("a bare click commits nothing", () => {
		const { session, spawned } = makeSession();
		session.setTool("freehand");
		session.pointerDown(5, 5);
		session.pointerUp();
		expect(spawned).toHaveLength(0);
	});
});
