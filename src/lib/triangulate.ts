/**
 * Simple-polygon geometry for the polygon tool: signed area, centroid,
 * convexity test, vertex cleanup, and ear-clipping triangulation for concave
 * polygons. Invalid or incomplete decompositions are rejected. Polygons are world-space
 * vertex lists; input winding may be either direction (normalized internally).
 */
export interface Vec2 {
	readonly x: number;
	readonly y: number;
}

/** Shoelace signed area (sign encodes winding; magnitude scales with size). */
export function polygonSignedArea(points: readonly Vec2[]): number {
	let area = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i] as Vec2;
		const b = points[(i + 1) % points.length] as Vec2;
		area += a.x * b.y - b.x * a.y;
	}
	return area / 2;
}

/** Polygon area-weighted centroid (uniform-density center of mass). */
export function polygonCentroid(points: readonly Vec2[]): Vec2 {
	const area2 = 2 * polygonSignedArea(points);
	if (Math.abs(area2) < 1e-12) {
		// Degenerate: fall back to the vertex mean so callers get a usable origin.
		let sx = 0;
		let sy = 0;
		for (const p of points) {
			sx += p.x;
			sy += p.y;
		}
		const n = Math.max(points.length, 1);
		return { x: sx / n, y: sy / n };
	}
	let cx = 0;
	let cy = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i] as Vec2;
		const b = points[(i + 1) % points.length] as Vec2;
		const w = a.x * b.y - b.x * a.y;
		cx += (a.x + b.x) * w;
		cy += (a.y + b.y) * w;
	}
	return { x: cx / (3 * area2), y: cy / (3 * area2) };
}

/**
 * True when every vertex turns the same direction (all cross products share
 * the winding's sign) within an epsilon; collinear edges (cross ≈ 0) count as
 * convex. Input winding may be either direction.
 */
export function polygonIsConvex(points: readonly Vec2[]): boolean {
	const n = points.length;
	if (n < 3) return true;
	const sign = Math.sign(polygonSignedArea(points));
	for (let i = 0; i < n; i++) {
		const a = points[(i + n - 1) % n] as Vec2;
		const b = points[i] as Vec2;
		const c = points[(i + 1) % n] as Vec2;
		const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
		if (cross * sign < -1e-9) return false;
	}
	return true;
}

/**
 * Remove consecutive and closing duplicate vertices (within `eps`) and drop
 * collinear vertices; null when fewer than 3 distinct non-collinear vertices
 * remain (zero-area or sliver input the polygon tool must not commit).
 */
export function cleanPolygon(
	points: readonly Vec2[],
	eps = 1e-6,
): Vec2[] | null {
	const out: Vec2[] = [];
	for (const p of points) {
		const prev = out[out.length - 1];
		if (prev && Math.abs(p.x - prev.x) < eps && Math.abs(p.y - prev.y) < eps)
			continue;
		out.push(p);
	}
	while (
		out.length > 1 &&
		Math.abs(out[0]!.x - out[out.length - 1]!.x) < eps &&
		Math.abs(out[0]!.y - out[out.length - 1]!.y) < eps
	) {
		out.pop();
	}
	// Drop collinear vertices: a midpoint whose cross product with its
	// neighbours is ~0 carries no area and confuses ear clipping.
	let changed = true;
	while (changed) {
		changed = false;
		for (let i = 0; i < out.length; i++) {
			const a = out[(i + out.length - 1) % out.length] as Vec2;
			const b = out[i] as Vec2;
			const c = out[(i + 1) % out.length] as Vec2;
			const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
			if (Math.abs(cross) < eps) {
				out.splice(i, 1);
				changed = true;
				break;
			}
		}
	}
	return out.length >= 3 ? out : null;
}

/** One output triangle of {@link triangulate}, as indices into the input ring. */
export type Triangle = readonly [number, number, number];

/**
 * Ear-clipping triangulation of a simple polygon: O(n²), exact for simple
 * polygons, undefined for self-intersecting input. Returns vertex-index
 * triples (into `points` as given); an empty array means the input is
 * degenerate (no coverable area after cleanup).
 */
export function triangulate(polygon: readonly Vec2[]): Triangle[] {
	const cleaned = cleanPolygon(polygon);
	if (!cleaned) return [];
	if (!polygonIsSimple(cleaned)) return [];
	const nodes: { p: Vec2; i: number }[] = cleaned.map((p) => ({
		p,
		i: polygon.indexOf(p),
	}));
	// Normalize winding once so ear tests are one-sided (CCW in the shoelace's
	// positive sense); original indices travel with their vertices.
	if (polygonSignedArea(cleaned) < 0) nodes.reverse();

	const triangles: Triangle[] = [];
	let guard = 0;
	const maxGuard = nodes.length * nodes.length * 4;
	while (nodes.length > 3 && guard++ < maxGuard) {
		let clipped = false;
		for (let k = 0; k < nodes.length; k++) {
			const prev = nodes[(k + nodes.length - 1) % nodes.length] as {
				p: Vec2;
				i: number;
			};
			const cur = nodes[k] as { p: Vec2; i: number };
			const next = nodes[(k + 1) % nodes.length] as { p: Vec2; i: number };
			const cross =
				(cur.p.x - prev.p.x) * (next.p.y - cur.p.y) -
				(cur.p.y - prev.p.y) * (next.p.x - cur.p.x);
			if (cross <= 1e-12) continue; // reflex or collinear vertex: not an ear
			if (earIsEmpty(nodes, prev.p, cur.p, next.p)) {
				triangles.push([prev.i, cur.i, next.i]);
				nodes.splice(k, 1);
				clipped = true;
				break;
			}
		}
		if (!clipped) break; // numeric fallback: remaining ring not clip-safe
	}
	if (nodes.length === 3)
		triangles.push([nodes[0]!.i, nodes[1]!.i, nodes[2]!.i]);
	if (nodes.length !== 3 || !completeDecomposition(polygon, triangles))
		return [];
	return triangles;
}

/** Reject crossings, touching non-neighbour edges, and non-finite vertices. */
export function polygonIsSimple(points: readonly Vec2[]): boolean {
	if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
		return false;
	const onSegment = (a: Vec2, b: Vec2, p: Vec2): boolean =>
		Math.abs(cross3(a, b, p)) < 1e-10 &&
		p.x >= Math.min(a.x, b.x) - 1e-10 &&
		p.x <= Math.max(a.x, b.x) + 1e-10 &&
		p.y >= Math.min(a.y, b.y) - 1e-10 &&
		p.y <= Math.max(a.y, b.y) + 1e-10;
	for (let i = 0; i < points.length; i++) {
		for (let j = i + 1; j < points.length; j++) {
			if (j === i + 1 || (i === 0 && j === points.length - 1)) continue;
			const a = points[i]!;
			const b = points[(i + 1) % points.length]!;
			const c = points[j]!;
			const d = points[(j + 1) % points.length]!;
			if (
				(cross3(a, b, c) * cross3(a, b, d) < 0 &&
					cross3(c, d, a) * cross3(c, d, b) < 0) ||
				onSegment(a, b, c) ||
				onSegment(a, b, d) ||
				onSegment(c, d, a) ||
				onSegment(c, d, b)
			)
				return false;
		}
	}
	return points.length >= 3;
}

/** No partial ear-clipping output may enter the physics registry. */
export function completeDecomposition(
	points: readonly Vec2[],
	triangles: readonly Triangle[],
): boolean {
	const area = Math.abs(polygonSignedArea(points));
	if (!Number.isFinite(area) || area <= 1e-12 || triangles.length === 0)
		return false;
	let covered = 0;
	for (const [a, b, c] of triangles) {
		if (!points[a] || !points[b] || !points[c]) return false;
		covered += Math.abs(cross3(points[a]!, points[b]!, points[c]!)) / 2;
	}
	return Math.abs(covered - area) <= Math.max(1e-10, area * 1e-7);
}

function earIsEmpty(
	nodes: readonly { readonly p: Vec2 }[],
	a: Vec2,
	b: Vec2,
	c: Vec2,
): boolean {
	for (const node of nodes) {
		if (node.p === a || node.p === b || node.p === c) continue;
		if (pointInTriangle(node.p, a, b, c)) return false;
	}
	return true;
}

function pointInTriangle(p: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
	const d1 = cross3(a, b, p);
	const d2 = cross3(b, c, p);
	const d3 = cross3(c, a, p);
	const hasNeg = d1 < -1e-12 || d2 < -1e-12 || d3 < -1e-12;
	const hasPos = d1 > 1e-12 || d2 > 1e-12 || d3 > 1e-12;
	return !(hasNeg && hasPos);
}

function cross3(a: Vec2, b: Vec2, c: Vec2): number {
	return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

/**
 * Even-odd ray-cast point-in-polygon test. Winding-agnostic; points on the
 * boundary count as inside within the epsilon.
 */
export function pointInPolygon(
	x: number,
	y: number,
	points: readonly Vec2[],
): boolean {
	let inside = false;
	for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
		const a = points[i] as Vec2;
		const b = points[j] as Vec2;
		const intersects =
			a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x;
		if (intersects) inside = !inside;
	}
	return inside;
}
