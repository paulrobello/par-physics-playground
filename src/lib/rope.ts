/**
 * Rope chains (P4-T4, PRD D17/D18): a drawn freehand stroke becomes a chain
 * of small circle bodies joined by rope-kind joints — Rapier's rope joint is
 * a max-distance-only constraint, which is exactly a link (it pulls, never
 * pushes, and bends freely). Stroke endpoints are captured onto a body or
 * the world by pin joints. Pure geometry and bounds here (resampling, caps,
 * id bookkeeping); the Rapier spawn calls and DOM/event wiring live in
 * interaction.ts, the shift angle-snap (anchored at the last point, line-run
 * pattern) happens at sample capture in tools.ts.
 */
import type { Vec2 } from "./triangulate";
import type { DocumentId } from "./world";

/**
 * Distance between consecutive segment centers (D17 provisional constants,
 * Ruling 23: picked, documented, and surfaced via the visible rejection in
 * interaction.ts). Spacing = 2·RADIUS, so touching beads leave no gap a box
 * could slip through while every second neighbor stays out of contact.
 */
export const ROPE_SEGMENT_SPACING = 2;
/** Rope segment bead radius (world units). */
export const ROPE_SEGMENT_RADIUS = 0.6;
/**
 * Link slack: a rope link's max distance is the bead spacing times this —
 * strictly greater than 1, or a chain pinned at both ends has NO slack and
 * can only sag by stretching its links (measured: neighbors 2.4× apart).
 * 20% is enough droop for a visible bridge sag without a floppy hang.
 */
export const ROPE_LINK_SLACK = 1.2;
/** Max segments one drawn chain may have (≈126 world units of rope). */
export const ROPE_MAX_SEGMENTS_PER_CHAIN = 64;
/**
 * Max rope segment bodies in the whole scene. Provisional D17 guard, raised
 * from 192 to 384 for the PRD G7 scale target: the P5-T3 1000-body stress
 * workload is rope-heavy (300+ beads) by mandate — the guard bounds abuse,
 * not the perf target.
 */
export const ROPE_MAX_TOTAL_SEGMENTS = 384;

/** Rope segment body ids carry this prefix (the total-cap bookkeeping key). */
const ROPE_SEGMENT_ID_PREFIX = "rope-seg-";

let nextRopeSegmentId = 1;

/** Fresh document id for a rope segment body: rope-seg-1, rope-seg-2, ... */
export function freshRopeSegmentId(): DocumentId {
	const id = `${ROPE_SEGMENT_ID_PREFIX}${nextRopeSegmentId}`;
	nextRopeSegmentId += 1;
	return id;
}

/** True when `id` is a rope segment body id (see freshRopeSegmentId). */
export function isRopeSegmentId(id: string): boolean {
	return id.startsWith(ROPE_SEGMENT_ID_PREFIX);
}

/** How many rope segment bodies exist among these document ids. */
export function countRopeSegmentIds(ids: readonly string[]): number {
	let n = 0;
	for (const id of ids) if (isRopeSegmentId(id)) n += 1;
	return n;
}

/**
 * Uniform arc-length resampling of a polyline: `count` samples spaced
 * `total/step` apart, INCLUDING both endpoints, so a drawn stroke becomes
 * evenly sized rope links regardless of how the pointer sampled it.
 */
export function resamplePolyline(
	points: readonly Vec2[],
	spacing: number,
): Vec2[] {
	if (points.length === 0) return [];
	if (points.length === 1) return [{ ...(points[0] as Vec2) }];
	let total = 0;
	const segLens: number[] = [];
	for (let i = 1; i < points.length; i++) {
		const a = points[i - 1] as Vec2;
		const b = points[i] as Vec2;
		const len = Math.hypot(b.x - a.x, b.y - a.y);
		segLens.push(len);
		total += len;
	}
	if (!(spacing > 0) || total === 0) return [{ ...(points[0] as Vec2) }];
	const count = Math.max(2, Math.round(total / spacing) + 1);
	const step = total / (count - 1);
	const out: Vec2[] = [];
	let seg = 0;
	let consumed = 0;
	for (let k = 0; k < count; k++) {
		const target = Math.min(k * step, total);
		while (
			seg < segLens.length &&
			consumed + (segLens[seg] as number) < target
		) {
			consumed += segLens[seg] as number;
			seg += 1;
		}
		if (seg >= segLens.length) {
			out.push({ ...(points[points.length - 1] as Vec2) });
			continue;
		}
		const len = segLens[seg] as number;
		const t = len > 0 ? (target - consumed) / len : 0;
		const a = points[seg] as Vec2;
		const b = points[seg + 1] as Vec2;
		out.push({
			x: a.x + (b.x - a.x) * t,
			y: a.y + (b.y - a.y) * t,
		});
	}
	return out;
}

/** The rope chain placement result (see {@link buildRopeChain}). */
export type RopeChainResult =
	| {
			readonly ok: true;
			/** Segment body centers, in stroke order (both endpoints included). */
			readonly segments: readonly Vec2[];
			/** Rope-link max distance (the spacing the chain was built with). */
			readonly linkLength: number;
	  }
	| {
			readonly ok: false;
			/** Which provisional cap (D17) or input check refused the chain. */
			readonly reason: "too-short" | "per-chain" | "total";
	  };

/**
 * Plan a rope chain from stroke points: resample at the segment spacing and
 * enforce the D17 provisional caps — per-chain segments and total segments
 * across the scene. A refused chain is NOT placed (the caller drops its undo
 * snapshot and surfaces the reason visibly).
 */
export function buildRopeChain(
	points: readonly Vec2[],
	opts: {
		readonly spacing?: number;
		readonly maxPerChain?: number;
		readonly maxTotal?: number;
		/** Rope segment bodies already in the scene (the total cap's baseline). */
		readonly existingTotal?: number;
	} = {},
): RopeChainResult {
	const spacing = opts.spacing ?? ROPE_SEGMENT_SPACING;
	const maxPerChain = opts.maxPerChain ?? ROPE_MAX_SEGMENTS_PER_CHAIN;
	const maxTotal = opts.maxTotal ?? ROPE_MAX_TOTAL_SEGMENTS;
	const existingTotal = opts.existingTotal ?? 0;
	const segments = resamplePolyline(points, spacing);
	if (segments.length < 2) return { ok: false, reason: "too-short" };
	if (segments.length > maxPerChain) return { ok: false, reason: "per-chain" };
	if (existingTotal + segments.length > maxTotal) {
		return { ok: false, reason: "total" };
	}
	return { ok: true, segments, linkLength: spacing * ROPE_LINK_SLACK };
}
