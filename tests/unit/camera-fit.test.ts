/**
 * Camera fit + demo-scene bounds: the demo camera must CENTER the scene's
 * content bounds in the viewport (it initialized to a generic ground-at-
 * bottom view and drew off to the right — the off-center demo camera
 * report), so the fit math and the bounds walk are pinned here.
 */
import { describe, expect, test } from "bun:test";
import { cameraFitForBounds } from "../../src/lib/camera";
import { demoSceneBounds } from "../../src/lib/demo-scene";
import type { BodyEntity, DocEntity } from "../../src/lib/document";

const box = (
	id: string,
	x: number,
	y: number,
	hw: number,
	hh: number,
): BodyEntity => ({
	kind: "body",
	id,
	x,
	y,
	rot: 0,
	isStatic: false,
	materialId: "ink",
	shape: { kind: "box", halfWidth: hw, halfHeight: hh },
});

const circle = (id: string, x: number, y: number, r: number): BodyEntity => ({
	kind: "body",
	id,
	x,
	y,
	rot: 0,
	isStatic: false,
	materialId: "ink",
	shape: { kind: "circle", radius: r },
});

describe("cameraFitForBounds", () => {
	test("centers the bounds at the viewport center at zoom 1", () => {
		// Viewport exactly matches the bounds span → zoom 1 (under MAX_ZOOM).
		const f = cameraFitForBounds(0, -400, 400, 0, 400, 400, 0);
		expect(f.zoom).toBe(1);
		// screen = world·zoom + offset: world center (200, -200) → (200, 200).
		expect(f.offsetX).toBeCloseTo(0, 9);
		expect(f.offsetY).toBeCloseTo(400, 9);
	});
	test("zooms out to fit wide content plus the world margin", () => {
		const f = cameraFitForBounds(-1000, -600, 1000, 0, 1000, 800, 50);
		// Content 2000 wide + 2×50 margin vs viewport 1000 → zoom 1000/2100.
		expect(f.zoom).toBeCloseTo(1000 / 2100, 9);
		expect(f.offsetX).toBeCloseTo(500, 9); // bounds center x=0 → screen 500
	});
	test("clamps to MIN_ZOOM for enormous content", () => {
		const f = cameraFitForBounds(-1e6, -1e6, 1e6, 1e6, 1000, 800, 0);
		expect(f.zoom).toBe(0.05);
	});
	test("clamps to MAX_ZOOM for a tiny cluster", () => {
		const f = cameraFitForBounds(0, -10, 10, 0, 1000, 800, 0);
		expect(f.zoom).toBe(20);
	});
});

describe("demoSceneBounds", () => {
	test("box and circle bodies contribute their extents; non-bodies are ignored", () => {
		const entities: DocEntity[] = [
			box("b1", 0, 0, 20, 10),
			circle("c1", 100, -50, 8),
			{
				kind: "label",
				id: "l1",
				x: 5000,
				y: 5000,
				rot: 0,
				text: "way out there",
			} as DocEntity,
		];
		const b = demoSceneBounds(entities);
		if (!b) throw new Error("null bounds");
		// Boxes contribute their worst-case reach (hypot of half-extents —
		// rotation-independent overestimate, safe for a camera fit).
		expect(b.minX).toBeCloseTo(-Math.hypot(20, 10), 9);
		expect(b.maxX).toBeCloseTo(108, 9);
		expect(b.minY).toBeCloseTo(-58, 9);
		expect(b.maxY).toBeCloseTo(Math.hypot(20, 10), 9);
	});

	test("empty body set yields null (no fit possible)", () => {
		expect(demoSceneBounds([])).toBeNull();
	});
});
