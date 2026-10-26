import { describe, expect, test } from "bun:test";
import { gizmoScaleAxesFactor } from "../../src/lib/gizmo";
import {
	MIN_SHAPE_HALF_SIZE,
	scaleShapeAxesFloored,
} from "../../src/lib/tools";

/**
 * Axis-aligned corner-drag scaling (Paul, 2026-10-26): raw per-axis factors
 * against the anchored opposite corner, per-axis degenerate-shape floors
 * (no mirroring — negatives clamp to the floor), and the circle rule (no
 * ellipse kind: the radius takes the dominant applied factor).
 */

describe("gizmoScaleAxesFactor", () => {
	test("factors measure each axis against the anchored opposite corner", () => {
		// TL corner (0,0), anchor BR (100,50): a pointer at (−100,50) is twice
		// the corner→anchor x-span away from the anchor (sx 2) and ON the
		// anchor's y — zero height span (sy 0; the world layer floors it).
		const out = { sx: 0, sy: 0 };
		gizmoScaleAxesFactor(0, 0, 100, 50, -100, 50, out);
		expect(out.sx).toBeCloseTo(2, 6);
		expect(out.sy).toBeCloseTo(0, 6);
	});
	test("a degenerate start yields 1 per axis", () => {
		const out = { sx: 0, sy: 0 };
		gizmoScaleAxesFactor(100, 50, 100, 50, 300, 50, out);
		expect(out.sx).toBe(1);
		expect(out.sy).toBe(1);
	});
});

describe("scaleShapeAxesFloored", () => {
	test("box halves scale independently above the floors", () => {
		const r = scaleShapeAxesFloored(
			{ kind: "box", halfWidth: 10, halfHeight: 4 },
			2,
			0.5,
		);
		if (r.shape.kind !== "box") throw new Error("shape kind drifted");
		expect(r.shape.halfWidth).toBe(20);
		expect(r.shape.halfHeight).toBe(2);
		expect(r.sx).toBe(2);
		expect(r.sy).toBe(0.5);
	});
	test("each axis floors at MIN_SHAPE_HALF_SIZE independently", () => {
		const r = scaleShapeAxesFloored(
			{ kind: "box", halfWidth: 10, halfHeight: 4 },
			0.01,
			0.01,
		);
		if (r.shape.kind !== "box") throw new Error("shape kind drifted");
		expect(r.shape.halfWidth).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
		expect(r.shape.halfHeight).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
		expect(r.sx).toBeCloseTo(0.05, 6);
		expect(r.sy).toBeCloseTo(0.125, 6);
	});
	test("negative factors clamp to the floor (no mirroring)", () => {
		const r = scaleShapeAxesFloored(
			{ kind: "box", halfWidth: 10, halfHeight: 4 },
			-3,
			2,
		);
		if (r.shape.kind !== "box") throw new Error("shape kind drifted");
		expect(r.shape.halfWidth).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
		expect(r.shape.halfHeight).toBe(8);
		expect(r.sx).toBeCloseTo(0.05, 6);
		expect(r.sy).toBe(2);
	});
	test("a polygon scales per axis with per-axis polygon floors", () => {
		const r = scaleShapeAxesFloored(
			{
				kind: "polygon",
				points: [
					{ x: -2, y: -4 },
					{ x: 4, y: 1 },
				],
			},
			0.001,
			2,
		);
		if (r.shape.kind !== "polygon") throw new Error("shape kind drifted");
		// X floors at 0.5/4 = 0.125 so the widest |x| keeps the minimum; y at
		// factor 2 doubles freely.
		expect(r.shape.points[0]?.x).toBeCloseTo(-0.25, 6);
		expect(r.shape.points[1]?.x).toBeCloseTo(0.5, 6);
		expect(r.shape.points[0]?.y).toBeCloseTo(-8, 6);
		expect(r.shape.points[1]?.y).toBeCloseTo(2, 6);
		expect(r.sx).toBeCloseTo(0.125, 6);
		expect(r.sy).toBe(2);
	});
	test("a circle's radius takes the dominant applied factor", () => {
		const r = scaleShapeAxesFloored({ kind: "circle", radius: 5 }, 3, 2);
		if (r.shape.kind !== "circle") throw new Error("shape kind drifted");
		expect(r.shape.radius).toBe(15);
		expect(r.sx).toBe(3);
		expect(r.sy).toBe(2);
	});
	test("a circle floors its radius through the dominant axis", () => {
		// radius 5, both factors below the 0.1 floor: each clamps up to 0.1,
		// the dominant 0.1 applies and the radius lands on the minimum.
		const r = scaleShapeAxesFloored({ kind: "circle", radius: 5 }, 0.05, 0.02);
		if (r.shape.kind !== "circle") throw new Error("shape kind drifted");
		expect(r.shape.radius).toBeCloseTo(MIN_SHAPE_HALF_SIZE, 6);
		expect(r.sx).toBeCloseTo(0.1, 6);
		expect(r.sy).toBeCloseTo(0.1, 6);
	});
	test("a circle's negative factors clamp to its radius floor", () => {
		const r = scaleShapeAxesFloored({ kind: "circle", radius: 5 }, -2, 1);
		if (r.shape.kind !== "circle") throw new Error("shape kind drifted");
		expect(r.shape.radius).toBe(5);
		expect(r.sx).toBeCloseTo(0.1, 6);
		expect(r.sy).toBe(1);
	});
});
