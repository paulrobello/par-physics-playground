import { describe, expect, test } from "bun:test";
import {
	accumulateShapeBounds,
	type GizmoGeom,
	gizmoCornerX,
	gizmoCornerY,
	gizmoHitTest,
	gizmoRingX,
	gizmoRingY,
	gizmoRotateDelta,
	gizmoScaleFactor,
	resetBoundsAcc,
} from "../../src/lib/gizmo";
import { MIN_SHAPE_HALF_SIZE, scaleShapeFloored } from "../../src/lib/tools";

const geom = (
	minX: number,
	minY: number,
	maxX: number,
	maxY: number,
	zoom = 1,
): GizmoGeom => ({ minX, minY, maxX, maxY, zoom });

describe("gizmo handle positions", () => {
	test("corners map TL/TR/BR/BL in a y-down world", () => {
		const g = geom(-10, -5, 30, 15);
		expect([gizmoCornerX(g, 0), gizmoCornerY(g, 0)]).toEqual([-10, -5]);
		expect([gizmoCornerX(g, 1), gizmoCornerY(g, 1)]).toEqual([30, -5]);
		expect([gizmoCornerX(g, 2), gizmoCornerY(g, 2)]).toEqual([30, 15]);
		expect([gizmoCornerX(g, 3), gizmoCornerY(g, 3)]).toEqual([-10, 15]);
	});
	test("the ring hangs above the top edge by the screen-constant pad", () => {
		const g = geom(-10, -5, 30, 15, 0.5);
		expect(gizmoRingX(g)).toBe(10);
		expect(gizmoRingY(g)).toBe(-5 - 8 / 0.5);
	});
});

describe("gizmoHitTest", () => {
	test("detects a corner within the screen-constant radius", () => {
		const g = geom(-20, -10, 20, 10);
		const at = (d: number): { x: number; y: number } => ({
			x: 20 + d,
			y: 10 + d,
		});
		expect(gizmoHitTest(g, at(4).x, at(4).y)).toEqual({
			kind: "corner",
			index: 2,
		});
		expect(gizmoHitTest(g, at(11.5).x, at(11.5).y)).toBeUndefined();
	});
	test("detects the ring above the top edge", () => {
		const g = geom(-20, -10, 20, 10);
		expect(gizmoHitTest(g, 0, -10 - 8)).toEqual({ kind: "rotate" });
	});
	test("zoom scales the world hit radius", () => {
		const g = geom(-20, -10, 20, 10, 0.1);
		// 11 px at 0.1 zoom = 110 world units from the ring center.
		expect(gizmoHitTest(g, 0, -10 - 8 - 100)).toEqual({ kind: "rotate" });
	});
});

describe("gizmoScaleFactor", () => {
	test("doubling the pointer's anchor distance doubles the shape", () => {
		// TL corner (0,0) anchored at BR (100,50): a pointer twice as far from
		// the anchor doubles the factor; AT the anchor it collapses to 0 (the
		// shape-scale floor keeps the body non-degenerate).
		expect(gizmoScaleFactor(0, 0, 100, 50, 100, 50)).toBe(0);
		expect(gizmoScaleFactor(0, 0, 100, 50, 50, 25)).toBeCloseTo(0.5, 6);
	});
	test("a corner on the anchor yields 1", () => {
		expect(gizmoScaleFactor(5, 5, 5, 5, 50, 50)).toBe(1);
	});
});

describe("gizmoRotateDelta", () => {
	test("quarter turn counter-clockwise around the center", () => {
		// Start east of the center, rotate to north (y-down: up is -y).
		expect(gizmoRotateDelta(0, 0, 10, 0, 0, -10)).toBeCloseTo(-Math.PI / 2, 6);
	});
	test("crossing the ±π branch tracks continuously", () => {
		// atan2(5, -5) = 3π/4, atan2(0, -10) = π: the delta is -π/4.
		expect(gizmoRotateDelta(0, 0, -10, 0, -5, 5)).toBeCloseTo(-Math.PI / 4, 6);
	});
});

describe("accumulateShapeBounds", () => {
	test("a box contributes its four corners", () => {
		const acc = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		resetBoundsAcc(acc);
		accumulateShapeBounds(
			{ kind: "box", halfWidth: 10, halfHeight: 5 },
			100,
			-50,
			0,
			acc,
		);
		expect(acc.minX).toBe(90);
		expect(acc.maxX).toBe(110);
		expect(acc.minY).toBe(-55);
		expect(acc.maxY).toBe(-45);
	});
	test("a rotated box's AABB covers the rotation", () => {
		const acc = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		resetBoundsAcc(acc);
		// A square rotated 45° about its center: the AABB half-diagonal is
		// sqrt(5) ≈ 7.07.
		accumulateShapeBounds(
			{ kind: "box", halfWidth: 2, halfHeight: 2 },
			10,
			10,
			Math.PI / 4,
			acc,
		);
		expect(acc.minX).toBeCloseTo(10 - Math.SQRT2 * 2, 6);
		expect(acc.maxY).toBeCloseTo(10 + Math.SQRT2 * 2, 6);
	});
	test("a circle's bounds are rotation-independent", () => {
		const acc = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		resetBoundsAcc(acc);
		accumulateShapeBounds({ kind: "circle", radius: 7 }, 0, 0, Math.PI, acc);
		expect(acc.minX).toBe(-7);
		expect(acc.maxY).toBe(7);
	});
	test("a polygon contributes its vertices", () => {
		const acc = { minX: 0, minY: 0, maxX: 0, maxY: 0 };
		resetBoundsAcc(acc);
		accumulateShapeBounds(
			{
				kind: "polygon",
				points: [
					{ x: -2, y: -3 },
					{ x: 4, y: 1 },
					{ x: 1, y: 5 },
				],
			},
			0,
			0,
			0,
			acc,
		);
		expect(acc.minX).toBe(-2);
		expect(acc.maxX).toBe(4);
		expect(acc.minY).toBe(-3);
		expect(acc.maxY).toBe(5);
	});
});

describe("scaleShapeFloored", () => {
	test("box halves scale exactly above the floor", () => {
		const r = scaleShapeFloored(
			{ kind: "box", halfWidth: 10, halfHeight: 4 },
			2,
		);
		if (r.shape.kind !== "box") throw new Error("shape kind drifted");
		expect(r.shape.halfWidth).toBe(20);
		expect(r.shape.halfHeight).toBe(8);
		expect(r.factor).toBe(2);
	});
	test("box floors at MIN_SHAPE_HALF_SIZE on the larger half", () => {
		const r = scaleShapeFloored(
			{ kind: "box", halfWidth: 10, halfHeight: 4 },
			0.01,
		);
		if (r.shape.kind !== "box") throw new Error("shape kind drifted");
		expect(r.shape.halfWidth).toBeCloseTo(0.5, 6);
		// The floor guarantees only the LARGEST half-extent keeps the minimum.
		expect(r.shape.halfHeight).toBeCloseTo(0.2, 6);
		expect(r.factor).toBeCloseTo(0.05, 6);
	});
	test("circle radius scales exactly above the floor", () => {
		const r = scaleShapeFloored({ kind: "circle", radius: 9 }, 3);
		if (r.shape.kind !== "circle") throw new Error("shape kind drifted");
		expect(r.shape.radius).toBe(27);
		expect(r.factor).toBe(3);
	});
	test("circle radius floors at MIN_SHAPE_HALF_SIZE", () => {
		const r = scaleShapeFloored({ kind: "circle", radius: 9 }, 0.001);
		if (r.shape.kind !== "circle") throw new Error("shape kind drifted");
		expect(r.shape.radius).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
		expect(r.factor).toBeCloseTo(0.5 / 9, 6);
	});
	test("polygon points scale about the body-local origin above the floor", () => {
		const r = scaleShapeFloored(
			{
				kind: "polygon",
				points: [
					{ x: -2, y: -4 },
					{ x: 4, y: 1 },
				],
			},
			2,
		);
		if (r.shape.kind !== "polygon") throw new Error("shape kind drifted");
		expect(r.shape.points).toEqual([
			{ x: -4, y: -8 },
			{ x: 8, y: 2 },
		]);
		expect(r.factor).toBe(2);
	});
	test("polygon floors so its largest half-extent keeps MIN_SHAPE_HALF_SIZE", () => {
		const r = scaleShapeFloored(
			{
				kind: "polygon",
				points: [
					{ x: -2, y: -4 },
					{ x: 4, y: 1 },
				],
			},
			0.001,
		);
		if (r.shape.kind !== "polygon") throw new Error("shape kind drifted");
		expect(r.shape.points[1]?.x).toBeCloseTo(0.5, 6);
		expect(r.shape.points[1]?.y).toBeCloseTo(0.125, 6);
		expect(r.factor).toBeCloseTo(0.125, 6);
	});
	test("the floor constant agrees with MIN_SHAPE_HALF_SIZE", () => {
		const r = scaleShapeFloored({ kind: "circle", radius: 1 }, 0);
		if (r.shape.kind !== "circle") throw new Error("shape kind drifted");
		expect(r.shape.radius).toBe(MIN_SHAPE_HALF_SIZE);
	});
});
