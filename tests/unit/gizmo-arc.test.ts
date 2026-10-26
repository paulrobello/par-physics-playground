import { describe, expect, test } from "bun:test";
import {
	formatSweptAngle,
	GIZMO_ARC_LABEL_PAD_PX,
	GIZMO_ARC_RADIUS_PX,
	gizmoArcLabelPos,
	gizmoArcRadius,
	gizmoArcSweep,
} from "../../src/lib/gizmo";

/**
 * Ring-drag rotation arc (Paul, 2026-10-26): the sweep normalization that
 * keeps the drawn arc on the short side of the ±π branch, the screen-constant
 * radius→world sizing, the label position at the arc's current end, and the
 * signed 1-decimal degree formatting.
 */

describe("gizmoArcSweep", () => {
	test("a plain sweep keeps its sign and magnitude", () => {
		const out = { startAngle: 0, sweep: 0 };
		gizmoArcSweep(0, Math.PI / 2, out);
		expect(out.startAngle).toBe(0);
		expect(out.sweep).toBeCloseTo(Math.PI / 2, 6);
		gizmoArcSweep(0, -Math.PI / 2, out);
		expect(out.sweep).toBeCloseTo(-Math.PI / 2, 6);
	});
	test("crossing the ±π branch takes the short way", () => {
		const out = { startAngle: 0, sweep: 0 };
		// Start at 3.0 rad, current at −3.0 rad: raw difference −6.0 wraps to
		// +2π−6 ≈ +0.283 (continuing counter-clockwise), not a −344° swing.
		gizmoArcSweep(3, -3, out);
		expect(out.sweep).toBeCloseTo(-6 + Math.PI * 2, 6);
		expect(out.startAngle).toBe(3);
		// The mirror: start −3.0, current 3.0 sweeps ≈ −0.283.
		gizmoArcSweep(-3, 3, out);
		expect(out.sweep).toBeCloseTo(6 - Math.PI * 2, 6);
	});
	test("half-turn corners of the range behave sensibly", () => {
		const out = { startAngle: 0, sweep: 0 };
		// −π and +π point the same way: the sweep is 0.
		gizmoArcSweep(-Math.PI, Math.PI, out);
		expect(out.sweep).toBeCloseTo(0, 6);
		gizmoArcSweep(0, Math.PI, out);
		expect(out.sweep).toBeCloseTo(Math.PI, 6);
	});
});

describe("arc radius sizing", () => {
	test("the arc radius is screen-constant (world = px / zoom)", () => {
		expect(gizmoArcRadius(1)).toBe(GIZMO_ARC_RADIUS_PX);
		expect(gizmoArcRadius(0.5)).toBe(GIZMO_ARC_RADIUS_PX / 0.5);
	});
	test("the label radius sits one pad beyond the arc", () => {
		expect(GIZMO_ARC_LABEL_PAD_PX).toBeGreaterThan(0);
		expect(gizmoArcLabelPos.length).toBe(5);
	});
});

describe("gizmoArcLabelPos", () => {
	test("the label rides the arc's current end, offset by the pad", () => {
		const out = { x: 0, y: 0 };
		// Due east at zoom 1: (cx + r, cy).
		gizmoArcLabelPos(100, -50, 0, 1, out);
		expect(out.x).toBeCloseTo(
			100 + GIZMO_ARC_RADIUS_PX + GIZMO_ARC_LABEL_PAD_PX,
			6,
		);
		expect(out.y).toBeCloseTo(-50, 6);
		// Due north (y-down: angle −π/2) at zoom 2: half the world radius.
		gizmoArcLabelPos(100, -50, -Math.PI / 2, 2, out);
		expect(out.x).toBeCloseTo(100, 6);
		expect(out.y).toBeCloseTo(
			-50 - (GIZMO_ARC_RADIUS_PX + GIZMO_ARC_LABEL_PAD_PX) / 2,
			6,
		);
	});
});

describe("formatSweptAngle", () => {
	test("formats signed degrees to exactly one decimal", () => {
		expect(formatSweptAngle(0)).toBe("0.0°");
		expect(formatSweptAngle(Math.PI / 2)).toBe("90.0°");
		expect(formatSweptAngle(-Math.PI / 4)).toBe("-45.0°");
		expect(formatSweptAngle(Math.PI)).toBe("180.0°");
	});
});
