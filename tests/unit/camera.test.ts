import { describe, expect, test } from "bun:test";
import { Camera, clampZoom, MAX_ZOOM, MIN_ZOOM } from "../../src/lib/camera";

describe("camera coordinate transforms", () => {
	// Fractional devicePixelRatio values: external displays and browser zoom
	// produce fractions like 1.25/1.5, and the renderer composes the camera
	// transform with dpr, so round-trips must hold at all of them.
	const dprs = [1, 0.75, 1.25, 1.5, 2.625];

	// Pan offsets and zooms spanning the full clamp range.
	const pans: Array<[number, number]> = [
		[0, 0],
		[137.5, -89.25],
		[-4200, 3100],
	];
	const zooms = [MIN_ZOOM, 0.25, 1, 3.7, MAX_ZOOM];

	test("screen-to-world-to-screen round-trips at pan/zoom/dpr combos", () => {
		for (const [offsetX, offsetY] of pans) {
			for (const zoom of zooms) {
				for (const dpr of dprs) {
					const camera = new Camera();
					camera.offsetX = offsetX;
					camera.offsetY = offsetY;
					camera.zoom = zoom;
					const sx = 233.7;
					const sy = 512.3;
					const world = camera.screenToWorld(sx, sy, dpr);
					const back = camera.worldToScreen(world.x, world.y, dpr);
					expect(back.x).toBeCloseTo(sx, 6);
					expect(back.y).toBeCloseTo(sy, 6);
				}
			}
		}
	});

	test("world-to-screen-to-world round-trips at pan/zoom/dpr combos", () => {
		for (const [offsetX, offsetY] of pans) {
			for (const zoom of zooms) {
				for (const dpr of dprs) {
					const camera = new Camera();
					camera.offsetX = offsetX;
					camera.offsetY = offsetY;
					camera.zoom = zoom;
					const wx = -1922.75;
					const wy = 88.125;
					const screen = camera.worldToScreen(wx, wy, dpr);
					const back = camera.screenToWorld(screen.x, screen.y, dpr);
					expect(back.x).toBeCloseTo(wx, 6);
					expect(back.y).toBeCloseTo(wy, 6);
				}
			}
		}
	});

	test("zoomAt clamps and saturates idempotently", () => {
		const camera = new Camera();
		camera.zoomAt(100, 100, 1e9);
		expect(camera.zoom).toBe(MAX_ZOOM);
		const offsetAtMax = { x: camera.offsetX, y: camera.offsetY };
		camera.zoomAt(100, 100, 1e9);
		expect(camera.offsetX).toBe(offsetAtMax.x);
		expect(camera.offsetY).toBe(offsetAtMax.y);

		camera.zoomAt(100, 100, 1e-9);
		expect(camera.zoom).toBe(MIN_ZOOM);
		camera.zoomAt(100, 100, 1e-9);
		expect(camera.zoom).toBe(MIN_ZOOM);
	});

	test("zoomAt keeps the anchored world point fixed", () => {
		const camera = new Camera();
		camera.panBy(120, -40);
		const sx = 321.5;
		const sy = 147.25;
		const before = camera.screenToWorld(sx, sy);
		camera.zoomAt(sx, sy, 2.5);
		const after = camera.screenToWorld(sx, sy);
		expect(after.x).toBeCloseTo(before.x, 9);
		expect(after.y).toBeCloseTo(before.y, 9);
	});

	test("clampZoom bounds", () => {
		expect(clampZoom(-5)).toBe(MIN_ZOOM);
		expect(clampZoom(0.5)).toBe(0.5);
		expect(clampZoom(1e6)).toBe(MAX_ZOOM);
	});
});
