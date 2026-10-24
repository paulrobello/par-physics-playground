import { describe, expect, test } from "bun:test";
import {
	cleanPolygon,
	polygonCentroid,
	polygonIsConvex,
	polygonSignedArea,
	triangulate,
	type Vec2,
} from "../../src/lib/triangulate";

const p = (x: number, y: number): Vec2 => ({ x, y });

/** Sum of absolute triangle areas, via vertex coordinates from the ring. */
function coveredArea(
	points: readonly Vec2[],
	triangles: readonly (readonly [number, number, number])[],
): number {
	let sum = 0;
	for (const [a, b, c] of triangles) {
		const pa = points[a] as Vec2;
		const pb = points[b] as Vec2;
		const pc = points[c] as Vec2;
		sum +=
			Math.abs((pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x)) /
			2;
	}
	return sum;
}

describe("polygonSignedArea", () => {
	test("square area 1, sign follows winding", () => {
		const cw = [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];
		expect(polygonSignedArea(cw)).toBe(1);
		expect(polygonSignedArea([...cw].reverse())).toBe(-1);
	});
});

describe("polygonCentroid", () => {
	test("square centroid is its center", () => {
		const sq = [p(0, 0), p(2, 0), p(2, 2), p(0, 2)];
		expect(polygonCentroid(sq)).toEqual({ x: 1, y: 1 });
	});

	test("degenerate input falls back to the vertex mean", () => {
		expect(polygonCentroid([p(0, 5), p(2, 5)])).toEqual({ x: 1, y: 5 });
	});
});

describe("polygonIsConvex", () => {
	test("square and triangle are convex, either winding", () => {
		const sq = [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];
		expect(polygonIsConvex(sq)).toBe(true);
		expect(polygonIsConvex([...sq].reverse())).toBe(true);
		expect(polygonIsConvex([p(0, 0), p(4, 0), p(2, 3)])).toBe(true);
	});

	test("L-shape is concave", () => {
		const l = [p(0, 0), p(3, 0), p(3, 1), p(1, 1), p(1, 3), p(0, 3)];
		expect(polygonIsConvex(l)).toBe(false);
	});
});

describe("cleanPolygon", () => {
	test("drops duplicate, closing, and collinear vertices", () => {
		const cleaned = cleanPolygon([
			p(0, 0),
			p(1, 0),
			p(2, 0), // collinear with neighbours
			p(2, 1),
			p(2, 1), // consecutive duplicate
			p(0, 1),
			p(0, 0), // closing duplicate
		]);
		expect(cleaned).toEqual([p(0, 0), p(2, 0), p(2, 1), p(0, 1)]);
	});

	test("collinear-only input is rejected (null)", () => {
		expect(cleanPolygon([p(0, 0), p(1, 0), p(2, 0)])).toBeNull();
		expect(cleanPolygon([p(0, 0), p(1, 0)])).toBeNull();
	});
});

describe("triangulate", () => {
	test("square yields two triangles covering the area", () => {
		const sq = [p(0, 0), p(1, 0), p(1, 1), p(0, 1)];
		const tris = triangulate(sq);
		expect(tris).toHaveLength(2);
		expect(coveredArea(sq, tris)).toBeCloseTo(1, 9);
	});

	test("concave L-shape yields n-2 triangles covering the area exactly", () => {
		const l = [p(0, 0), p(3, 0), p(3, 1), p(1, 1), p(1, 3), p(0, 3)];
		const tris = triangulate(l);
		expect(tris).toHaveLength(l.length - 2);
		expect(coveredArea(l, tris)).toBeCloseTo(5, 9);
	});

	test("reversed winding gives the same coverage", () => {
		const l = [p(0, 3), p(1, 3), p(1, 1), p(3, 1), p(3, 0), p(0, 0)];
		const tris = triangulate(l);
		expect(coveredArea(l, tris)).toBeCloseTo(5, 9);
	});

	test("degenerate input (collinear, duplicates) yields no triangles", () => {
		expect(triangulate([p(0, 0), p(1, 0), p(2, 0)])).toEqual([]);
		expect(triangulate([p(0, 0), p(0, 0), p(0, 0)])).toEqual([]);
		expect(triangulate([p(0, 0), p(1, 0)])).toEqual([]);
	});
});
