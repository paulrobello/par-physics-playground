/**
 * Freehand tool geometry (the line-run stroke pattern, adapted to this
 * codebase's document/world structure): pointer-sample capture with distance
 * decimation, closure-overlap/retrace cleanup, and near-shape recognition on
 * release. Pure functions only — DOM capture lives in tools.ts/interaction.ts.
 *
 * Pipeline on stroke release (see decideFreehand):
 *  1. capture already decimated samples (FreehandStrokeBuilder)
 *  2. closure test (endpoints within a fraction of the stroke extent)
 *  3. closed strokes: clean closure overlaps/retraces, then try circle →
 *     rectangle → triangle fits in that order (a square's radial rms error
 *     fails the circle gate; a circle's missing corners fail the rectangle
 *     gate, so fixed order is safe)
 *  4. closed but unrecognized: freeform silhouette → polygon (concave input
 *     is triangulated downstream by world.spawnPolygon)
 *  5. open strokes: simplified polyline → chain of beam-like segments
 */
import type { Vec2 } from "./triangulate";

/** Capture decimation: a sample closer than this to the previous kept point is dropped. */
export const FREEHAND_MIN_SAMPLE_DISTANCE = 0.35;
/** Capture overflow guard: further samples are dropped once this many are held. */
export const FREEHAND_MAX_SAMPLES = 2048;

/**
 * Closure tolerance as a fraction of the stroke extent (line-run: scale·0.12):
 * endpoints closer than this count as a closed stroke.
 */
export const FREEHAND_CLOSE_FRACTION = 0.12;

/** Minimum contour points before a circle fit is trusted. */
export const FREEHAND_CIRCLE_MIN_POINTS = 8;
/** Circle snap gates (line-run): normalized radial rms and max error, and the */
export const FREEHAND_CIRCLE_RMS_MAX = 0.09;
/** largest angular gap as a fraction of a full turn (coverage). */
export const FREEHAND_CIRCLE_GAP_MAX = 0.26;
export const FREEHAND_CIRCLE_ERROR_MAX = 0.2;

/** Rectangle snap gates (line-run): mean/max boundary error normalized by the */
export const FREEHAND_RECT_AVG_ERROR_MAX = 0.025;
/** shorter side, filled-area fraction, and corner-proximity fraction. */
export const FREEHAND_RECT_ERROR_MAX = 0.075;
export const FREEHAND_RECT_AREA_RATIO_MIN = 0.9;
export const FREEHAND_RECT_CORNER_FRACTION = 0.045;

/** Triangle snap gates (line-run): corner count cap for the max-area triple, */
export const FREEHAND_TRI_CORNERS_MAX = 12;
/** fit tolerance and area-ratio window. */
export const FREEHAND_TRI_FIT_FRACTION = 0.06;
export const FREEHAND_TRI_AREA_MIN = 0.8;
export const FREEHAND_TRI_AREA_MAX = 1.2;

/** Freeform silhouette simplification tolerance, fraction of the extent. */
export const FREEHAND_RDP_FRACTION = 0.025;
/** Open-stroke polyline simplification tolerance, fraction of the extent. */
export const FREEHAND_OPEN_RDP_FRACTION = 0.02;

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Axis extent (larger of width/height) of a point set. */
export function strokeExtent(points: readonly Vec2[]): number {
	let minX = Infinity;
	let minY = Infinity;
	let maxX = -Infinity;
	let maxY = -Infinity;
	for (const p of points) {
		minX = Math.min(minX, p.x);
		minY = Math.min(minY, p.y);
		maxX = Math.max(maxX, p.x);
		maxY = Math.max(maxY, p.y);
	}
	return points.length ? Math.max(maxX - minX, maxY - minY) : 0;
}

/** Total polyline arc length. */
export function strokeLength(points: readonly Vec2[]): number {
	let total = 0;
	for (let i = 1; i < points.length; i++)
		total += dist(points[i - 1] as Vec2, points[i] as Vec2);
	return total;
}

/**
 * Decimating sample collector: keeps the first sample, then every sample at
 * least {@link FREEHAND_MIN_SAMPLE_DISTANCE} from the last kept one, capped at
 * {@link FREEHAND_MAX_SAMPLES} (the cap prevents unbounded memory on a jammed
 * pointer; further samples are dropped, not errors).
 */
export class FreehandStrokeBuilder {
	private readonly samples: Vec2[] = [];

	add(x: number, y: number): boolean {
		if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
		const prev = this.samples[this.samples.length - 1];
		if (
			prev &&
			Math.hypot(x - prev.x, y - prev.y) < FREEHAND_MIN_SAMPLE_DISTANCE
		) {
			return false;
		}
		if (this.samples.length >= FREEHAND_MAX_SAMPLES) return false;
		this.samples.push({ x, y });
		return true;
	}

	get points(): readonly Vec2[] {
		return this.samples;
	}
}

/**
 * Cleanup (returns a new array) of a closed stroke's end: strips the closure
 * duplicate and any retrace tail — every trailing point within the CLOSURE
 * radius ({@link FREEHAND_CLOSE_FRACTION} of the extent) of the start point
 * is part of the overlap loop the drawer made returning to (or past) the
 * first sample, so the tail is removed up to the radius that made closure
 * legal. No spike survives inside the closure band.
 */
export function cleanClosedStroke(points: readonly Vec2[]): Vec2[] {
	if (points.length < 3) return [...points];
	const extent = strokeExtent(points);
	const closureRadius = extent * FREEHAND_CLOSE_FRACTION;
	// Drop consecutive duplicates first.
	const cleaned: Vec2[] = [];
	for (const p of points) {
		const prev = cleaned[cleaned.length - 1];
		if (prev && dist(prev, p) < 1e-9) continue;
		cleaned.push({ x: p.x, y: p.y });
	}
	// Pop the closure overlap and any retrace tail: every trailing point within
	// the closure radius of the start point is part of the closure approach.
	while (
		cleaned.length > 3 &&
		dist(cleaned[cleaned.length - 1] as Vec2, cleaned[0] as Vec2) <=
			closureRadius
	) {
		cleaned.pop();
	}
	return cleaned;
}

function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
	const dx = b.x - a.x;
	const dy = b.y - a.y;
	const len2 = dx * dx + dy * dy;
	if (len2 === 0) return dist(p, a);
	const t = Math.max(
		0,
		Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2),
	);
	return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas-Peucker simplification of an open polyline. */
export function simplifyOpen(
	points: readonly Vec2[],
	tolerance: number,
): Vec2[] {
	if (points.length <= 2) return [...points];
	const first = points[0] as Vec2;
	const last = points[points.length - 1] as Vec2;
	let furthest = -1;
	let maxError = tolerance;
	for (let i = 1; i < points.length - 1; i++) {
		const error = perpendicularDistance(points[i] as Vec2, first, last);
		if (error > maxError) {
			maxError = error;
			furthest = i;
		}
	}
	if (furthest < 0) return [first, last];
	const left = simplifyOpen(points.slice(0, furthest + 1), tolerance);
	const right = simplifyOpen(points.slice(furthest), tolerance);
	return [...left.slice(0, -1), ...right];
}

/**
 * Douglas-Peucker for a closed ring: rotate the seam to the leftmost vertex so
 * the open simplification does not pin an artificial corner at the stroke
 * start, then drop the duplicated seam point.
 */
export function simplifyClosed(
	points: readonly Vec2[],
	tolerance: number,
): Vec2[] {
	if (points.length < 3) return [...points];
	let seam = 0;
	for (let i = 1; i < points.length; i++) {
		const p = points[i] as Vec2;
		const best = points[seam] as Vec2;
		if (p.x < best.x || (p.x === best.x && p.y < best.y)) seam = i;
	}
	const rotated = [
		...points.slice(seam),
		...points.slice(0, seam),
		points[seam] as Vec2,
	];
	return simplifyOpen(rotated, tolerance).slice(0, -1);
}

/**
 * Algebraic (Kåsa) least-squares circle fit: solves x²+y² = a·x + b·y + c for
 * the center (a/2, b/2) and radius √(c + (a²+b²)/4) via Cramer's rule.
 */
export function fitCircle(
	points: readonly Vec2[],
): { cx: number; cy: number; radius: number } | undefined {
	const n = points.length;
	if (n < 3) return undefined;
	let sxx = 0;
	let sxy = 0;
	let syy = 0;
	let sx = 0;
	let sy = 0;
	let sxz = 0;
	let syz = 0;
	let sz = 0;
	for (const p of points) {
		const z = p.x * p.x + p.y * p.y;
		sxx += p.x * p.x;
		sxy += p.x * p.y;
		syy += p.y * p.y;
		sx += p.x;
		sy += p.y;
		sxz += p.x * z;
		syz += p.y * z;
		sz += z;
	}
	// Normal equations [[sxx,sxy,sx],[sxy,syy,sy],[sx,sy,n]]·[a,b,c]ᵀ = [sxz,syz,sz]ᵀ
	const m00 = sxx;
	const m01 = sxy;
	const m02 = sx;
	const m10 = sxy;
	const m11 = syy;
	const m12 = sy;
	const m20 = sx;
	const m21 = sy;
	const m22 = n;
	const det =
		m00 * (m11 * m22 - m12 * m21) -
		m01 * (m10 * m22 - m12 * m20) +
		m02 * (m10 * m21 - m11 * m20);
	if (Math.abs(det) < 1e-9) return undefined;
	const a =
		(sxz * (m11 * m22 - m12 * m21) -
			m01 * (syz * m22 - m12 * sz) +
			m02 * (syz * m21 - m11 * sz)) /
		det;
	const b =
		(m00 * (syz * m22 - m12 * sz) -
			sxz * (m10 * m22 - m12 * m20) +
			m02 * (m10 * sz - syz * m20)) /
		det;
	const c =
		(m00 * (m11 * sz - syz * m21) -
			m01 * (m10 * sz - syz * m20) +
			sxz * (m10 * m21 - m11 * m20)) /
		det;
	const cx = a / 2;
	const cy = b / 2;
	const r2 = c + cx * cx + cy * cy;
	if (r2 <= 0) return undefined;
	return { cx, cy, radius: Math.sqrt(r2) };
}

/** Largest angular gap between consecutive fitted points, as a turn fraction. */
function angularGapFraction(
	points: readonly Vec2[],
	cx: number,
	cy: number,
): number {
	if (points.length === 0) return 1;
	const phases = points
		.map((p) => Math.atan2(p.y - cy, p.x - cx) / (Math.PI * 2))
		.sort((x, y) => x - y);
	let largest = 0;
	for (let i = 0; i < phases.length; i++) {
		const v = phases[i] as number;
		const next =
			i + 1 < phases.length
				? (phases[i + 1] as number)
				: (phases[0] as number) + 1;
		largest = Math.max(largest, next - v);
	}
	return largest;
}

/**
 * Minimal-area oriented bounding box over edge-direction candidates
 * (line-run's rectangleFit): each edge direction (folded to a quadrant) is a
 * candidate orientation; the best is the smallest-area one.
 */
export interface RectFit {
	readonly angle: number;
	readonly cx: number;
	readonly cy: number;
	readonly width: number;
	readonly height: number;
}

export function fitRectangle(points: readonly Vec2[]): RectFit | undefined {
	const n = points.length;
	if (n < 3) return undefined;
	const origin = points[0] as Vec2;
	let best: RectFit | undefined;
	let bestArea = Infinity;
	for (let i = 0; i < n; i++) {
		const p = points[i] as Vec2;
		const next = points[(i + 1) % n] as Vec2;
		if (dist(p, next) < 1e-9) continue;
		const step = Math.PI / 2;
		// Fold the edge direction into [0, π/2): orientations π/2 apart give the
		// same bbox, and rounding to the NEAREST quadrant would snap 26° to 0°.
		const turns = Math.atan2(next.y - p.y, next.x - p.x) / step;
		const angle = (turns - Math.floor(turns)) * step;
		const cos = Math.cos(angle);
		const sin = Math.sin(angle);
		let minX = Infinity;
		let maxX = -Infinity;
		let minY = Infinity;
		let maxY = -Infinity;
		for (const v of points) {
			const dx = v.x - origin.x;
			const dy = v.y - origin.y;
			const u = dx * cos + dy * sin;
			const w = -dx * sin + dy * cos;
			minX = Math.min(minX, u);
			maxX = Math.max(maxX, u);
			minY = Math.min(minY, w);
			maxY = Math.max(maxY, w);
		}
		const width = maxX - minX;
		const height = maxY - minY;
		const area = width * height;
		if (area >= bestArea) continue;
		bestArea = area;
		const ux = (minX + maxX) / 2;
		const uy = (minY + maxY) / 2;
		best = {
			angle,
			cx: origin.x + ux * cos - uy * sin,
			cy: origin.y + ux * sin + uy * cos,
			width,
			height,
		};
	}
	return best;
}

/** Distance from a point to the rectangle's boundary, in the rect frame. */
function rectangleBoundaryError(p: Vec2, r: RectFit): number {
	const cos = Math.cos(r.angle);
	const sin = Math.sin(r.angle);
	const dx = p.x - r.cx;
	const dy = p.y - r.cy;
	const u = dx * cos + dy * sin;
	const w = -dx * sin + dy * cos;
	const hu = r.width / 2;
	const hw = r.height / 2;
	const cu = Math.max(-hu, Math.min(hu, u));
	const cw = Math.max(-hw, Math.min(hw, w));
	return Math.hypot(u - cu, w - cw);
}

/** The commit decision for a released freehand stroke. */
export type FreehandDecision =
	| { readonly kind: "none" }
	| {
			readonly kind: "circle";
			readonly cx: number;
			readonly cy: number;
			readonly radius: number;
	  }
	| {
			readonly kind: "rect";
			readonly cx: number;
			readonly cy: number;
			readonly rot: number;
			readonly halfWidth: number;
			readonly halfHeight: number;
	  }
	/** Closed freeform or triangle: absolute-space vertices, ≥3 points. */
	| { readonly kind: "polygon"; readonly points: readonly Vec2[] }
	/** Open stroke: simplified polyline, committed as a chain of beam segments. */
	| { readonly kind: "chain"; readonly points: readonly Vec2[] };

/**
 * Classify a released stroke. Closed strokes try circle → rectangle →
 * triangle; anything else closed keeps its freeform silhouette as a polygon;
 * open strokes become a simplified chain polyline.
 */
export function decideFreehand(samples: readonly Vec2[]): FreehandDecision {
	if (samples.length < 2) return { kind: "none" };
	const extent = strokeExtent(samples);
	if (!(extent > 1e-6)) return { kind: "none" };
	const first = samples[0] as Vec2;
	const last = samples[samples.length - 1] as Vec2;
	const closureTol = extent * FREEHAND_CLOSE_FRACTION;
	const closed =
		samples.length >= 3 &&
		strokeLength(samples) > closureTol * 2 &&
		dist(first, last) <= closureTol;
	if (!closed) {
		const chain = simplifyOpen(samples, extent * FREEHAND_OPEN_RDP_FRACTION);
		return chain.length >= 2
			? { kind: "chain", points: chain }
			: { kind: "none" };
	}
	const contour = cleanClosedStroke(samples);
	if (contour.length < 3) return { kind: "none" };

	// Circle: least-squares fit gated on normalized radial error + coverage.
	const circle = fitCircle(contour);
	if (
		circle &&
		contour.length >= FREEHAND_CIRCLE_MIN_POINTS &&
		circle.radius > 1e-6
	) {
		const errors = contour.map(
			(p) =>
				Math.abs(Math.hypot(p.x - circle.cx, p.y - circle.cy) - circle.radius) /
				circle.radius,
		);
		const rms = Math.sqrt(
			errors.reduce((sum, e) => sum + e * e, 0) / errors.length,
		);
		const max = Math.max(...errors);
		const gap = angularGapFraction(contour, circle.cx, circle.cy);
		if (
			rms < FREEHAND_CIRCLE_RMS_MAX &&
			max < FREEHAND_CIRCLE_ERROR_MAX &&
			gap <= FREEHAND_CIRCLE_GAP_MAX
		) {
			return { kind: "circle", ...circle };
		}
	}

	// Rectangle: minimal-area oriented bbox gated on boundary error, filled
	// area, and a drawn point near each corner (circles have no corners).
	const rect = fitRectangle(contour);
	if (rect && Math.min(rect.width, rect.height) > 1e-6) {
		const minSide = Math.min(rect.width, rect.height);
		const errors = contour.map(
			(p) => rectangleBoundaryError(p, rect) / minSide,
		);
		const avg = errors.reduce((sum, e) => sum + e, 0) / errors.length;
		const max = Math.max(...errors);
		let area2 = 0;
		for (let i = 0; i < contour.length; i++) {
			const a = contour[i] as Vec2;
			const b = contour[(i + 1) % contour.length] as Vec2;
			area2 += a.x * b.y - b.x * a.y;
		}
		const areaRatio = Math.abs(area2 / 2) / (rect.width * rect.height);
		const cos = Math.cos(rect.angle);
		const sin = Math.sin(rect.angle);
		const hu = rect.width / 2;
		const hw = rect.height / 2;
		let corners = true;
		for (const su of [-hu, hu]) {
			for (const sw of [-hw, hw]) {
				const corner = {
					x: rect.cx + su * cos - sw * sin,
					y: rect.cy + su * sin + sw * cos,
				};
				let nearest = Infinity;
				for (const p of contour) nearest = Math.min(nearest, dist(p, corner));
				if (nearest > minSide * FREEHAND_RECT_CORNER_FRACTION) corners = false;
			}
		}
		if (
			avg < FREEHAND_RECT_AVG_ERROR_MAX &&
			max < FREEHAND_RECT_ERROR_MAX &&
			areaRatio >= FREEHAND_RECT_AREA_RATIO_MIN &&
			corners
		) {
			return {
				kind: "rect",
				cx: rect.cx,
				cy: rect.cy,
				rot: rect.angle,
				halfWidth: rect.width / 2,
				halfHeight: rect.height / 2,
			};
		}
	}

	// Triangle: max-area triple among the simplified corners, gated on the
	// contour hugging the triangle's edges and on area agreement.
	const cornerTol = Math.max(extent * FREEHAND_RDP_FRACTION, 1e-6);
	const corners = simplifyClosed(contour, cornerTol);
	if (corners.length >= 3 && corners.length <= FREEHAND_TRI_CORNERS_MAX) {
		let tri: [Vec2, Vec2, Vec2] | undefined;
		let triArea = 0;
		for (let a = 0; a < corners.length - 2; a++) {
			for (let b = a + 1; b < corners.length - 1; b++) {
				for (let c = b + 1; c < corners.length; c++) {
					const t: [Vec2, Vec2, Vec2] = [
						corners[a] as Vec2,
						corners[b] as Vec2,
						corners[c] as Vec2,
					];
					const area = Math.abs(
						(t[0].x * (t[1].y - t[2].y) +
							t[1].x * (t[2].y - t[0].y) +
							t[2].x * (t[0].y - t[1].y)) /
							2,
					);
					if (area > triArea) {
						tri = t;
						triArea = area;
					}
				}
			}
		}
		if (tri) {
			let contourArea2 = 0;
			for (let i = 0; i < contour.length; i++) {
				const p = contour[i] as Vec2;
				const q = contour[(i + 1) % contour.length] as Vec2;
				contourArea2 += p.x * q.y - q.x * p.y;
			}
			const contourArea = Math.abs(contourArea2 / 2);
			const fitTol = extent * FREEHAND_TRI_FIT_FRACTION;
			let maxError = 0;
			for (const p of contour) {
				let nearest = Infinity;
				for (let i = 0; i < 3; i++) {
					const a = tri[i] as Vec2;
					const b = tri[(i + 1) % 3] as Vec2;
					nearest = Math.min(nearest, perpendicularDistance(p, a, b));
				}
				maxError = Math.max(maxError, nearest);
			}
			if (
				maxError <= fitTol &&
				triArea >= contourArea * FREEHAND_TRI_AREA_MIN &&
				triArea <= contourArea * FREEHAND_TRI_AREA_MAX
			) {
				return { kind: "polygon", points: tri };
			}
		}
	}

	// Freeform: simplified silhouette as a polygon (spawnPolygon cleans and
	// triangulates concave input downstream).
	const silhouette = simplifyClosed(contour, cornerTol);
	return silhouette.length >= 3
		? { kind: "polygon", points: silhouette }
		: { kind: "none" };
}
