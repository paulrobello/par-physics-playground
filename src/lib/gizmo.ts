/**
 * Transform gizmo geometry (pure, DOM-free): handle positions and sizes for a
 * world-space axis-aligned selection box, screen-constant hit radii, the
 * corner-drag scale factor, the ring-drag rotation delta, and per-shape world
 * AABB accumulation. The renderer and the ToolSession share these helpers so
 * what you see is exactly what you can grab at every zoom.
 *
 * World convention (src/lib/world.ts): y-down — screen top is smaller y, so
 * the rotate ring hangs ABOVE the box's top edge (minY).
 */
import type { BodyShape } from "./document";

/** Corner-handle half-size in CSS px (a full 10px square). */
export const GIZMO_CORNER_HALF_PX = 5;
/** Rotate-ring radius in CSS px. */
export const GIZMO_RING_RADIUS_PX = 6.5;
/** Handle hit radius in CSS px (screen-constant — what you see is what you grab). */
export const GIZMO_HIT_RADIUS_PX = 11;
/** Ring-center distance above the top edge, CSS px. */
export const GIZMO_RING_PAD_PX = 8;

/** Axis-aligned bounding box of a selection, world units. */
export interface GizmoBox {
	readonly minX: number;
	readonly minY: number;
	readonly maxX: number;
	readonly maxY: number;
}

/** A gizmo's full draw/hit geometry: the world box plus the pointer's zoom. */
export interface GizmoGeom extends GizmoBox {
	/** Screen px per world unit — sizes every screen-constant length. */
	readonly zoom: number;
}

/** What a press landed on: a corner (with its index) or the rotate ring. */
export type GizmoHit =
	| { readonly kind: "corner"; readonly index: number }
	| { readonly kind: "rotate" };

/** Corner i's world x: 0..3 = top-left, top-right, bottom-right, bottom-left. */
export function gizmoCornerX(g: GizmoGeom, i: number): number {
	return i === 0 || i === 3 ? g.minX : g.maxX;
}

/** Corner i's world y (0..3 top-left … bottom-left). */
export function gizmoCornerY(g: GizmoGeom, i: number): number {
	return i === 0 || i === 1 ? g.minY : g.maxY;
}

/** The rotate ring's world x — the box's horizontal center. */
export function gizmoRingX(g: GizmoGeom): number {
	return (g.minX + g.maxX) / 2;
}

/** The rotate ring's world y — the pad distance above the top edge. */
export function gizmoRingY(g: GizmoGeom): number {
	return g.minY - GIZMO_RING_PAD_PX / g.zoom;
}

/** The box center's world x (scale/rotate pivot). */
export function gizmoCenterX(g: GizmoGeom): number {
	return (g.minX + g.maxX) / 2;
}

/** The box center's world y (scale/rotate pivot). */
export function gizmoCenterY(g: GizmoGeom): number {
	return (g.minY + g.maxY) / 2;
}

/**
 * Handle under the world point, ring first then corners (no overlap at any
 * zoom — the ring floats a pad above the top edge). Hit radii are
 * screen-constant (world radius = px / zoom), matching the drawn handle sizes.
 */
export function gizmoHitTest(
	g: GizmoGeom,
	wx: number,
	wy: number,
): GizmoHit | undefined {
	const r = GIZMO_HIT_RADIUS_PX / g.zoom;
	const dx = wx - gizmoRingX(g);
	const dy = wy - gizmoRingY(g);
	if (dx * dx + dy * dy <= r * r) return { kind: "rotate" };
	for (let i = 0; i < 4; i++) {
		const dx = wx - gizmoCornerX(g, i);
		const dy = wy - gizmoCornerY(g, i);
		if (dx * dx + dy * dy <= r * r) return { kind: "corner", index: i };
	}
	return undefined;
}

/**
 * Uniform scale factor for a corner drag: the pointer's distance from the
 * anchored opposite corner over the drag-start corner's distance — dragging
 * the corner to double its reach doubles the shape. A degenerate start (the
 * corner on the anchor) yields 1.
 */
export function gizmoScaleFactor(
	cornerX: number,
	cornerY: number,
	anchorX: number,
	anchorY: number,
	wx: number,
	wy: number,
): number {
	const base = Math.hypot(cornerX - anchorX, cornerY - anchorY);
	if (base < 1e-6) return 1;
	return Math.hypot(wx - anchorX, wy - anchorY) / base;
}

/**
 * Rotation delta swept by a ring drag from the start point to the current
 * point, measured around the selection center (the box center).
 */
export function gizmoRotateDelta(
	centerX: number,
	centerY: number,
	startX: number,
	startY: number,
	wx: number,
	wy: number,
): number {
	return (
		Math.atan2(wy - centerY, wx - centerX) -
		Math.atan2(startY - centerY, startX - centerX)
	);
}

/**
 * Bounds accumulator the per-frame selection walk fills (P5 allocation card:
 * the caller owns the record, the walk allocates nothing).
 */
export interface BoundsAcc {
	minX: number;
	minY: number;
	maxX: number;
	maxY: number;
}

/** Reset an accumulator so the next walk starts empty. */
export function resetBoundsAcc(acc: BoundsAcc): void {
	acc.minX = Number.POSITIVE_INFINITY;
	acc.minY = Number.POSITIVE_INFINITY;
	acc.maxX = Number.NEGATIVE_INFINITY;
	acc.maxY = Number.NEGATIVE_INFINITY;
}

/**
 * Grow `acc` by one body's world-space axis-aligned bounding box: circles are
 * rotation-independent; boxes contribute their four rotated corners; polygons
 * their rotated vertices. Callers reset the accumulator first.
 */
export function accumulateShapeBounds(
	shape: BodyShape,
	x: number,
	y: number,
	rot: number,
	acc: BoundsAcc,
): void {
	if (shape.kind === "circle") {
		acc.minX = Math.min(acc.minX, x - shape.radius);
		acc.minY = Math.min(acc.minY, y - shape.radius);
		acc.maxX = Math.max(acc.maxX, x + shape.radius);
		acc.maxY = Math.max(acc.maxY, y + shape.radius);
		return;
	}
	const cos = Math.cos(rot);
	const sin = Math.sin(rot);
	const grow = (px: number, py: number): void => {
		const wx = x + px * cos - py * sin;
		const wy = y + px * sin + py * cos;
		acc.minX = Math.min(acc.minX, wx);
		acc.minY = Math.min(acc.minY, wy);
		acc.maxX = Math.max(acc.maxX, wx);
		acc.maxY = Math.max(acc.maxY, wy);
	};
	if (shape.kind === "box") {
		grow(-shape.halfWidth, -shape.halfHeight);
		grow(shape.halfWidth, -shape.halfHeight);
		grow(shape.halfWidth, shape.halfHeight);
		grow(-shape.halfWidth, shape.halfHeight);
		return;
	}
	for (const p of shape.points) grow(p.x, p.y);
}
