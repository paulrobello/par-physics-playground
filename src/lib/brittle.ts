/**
 * Brittle material behavior (materials extra): a DYNAMIC body whose material
 * carries `brittle: true` shatters into same-material dynamic fragments when
 * a hard contact impact lands on it. The shatter is a SIM event, never a user
 * action — no undo boundary is opened (the document converges at the next
 * action boundary's snapshot, the rotate-fling precedent).
 *
 * Fragment shapes: box → a 2×2 grid of half-size boxes; circle → 4 discs of
 * half radius, one per quadrant. Polygons (convex and concave) never
 * fragment in this unit — a brittle polygon simply behaves as a normal body
 * (documented acceptance).
 *
 * Cascade guard (the one picked here): a body whose smallest half-extent is
 * below BRITTLE_MIN_HALF_SIZE never shatters. Fragments CAN re-shatter while
 * above the guard, but each generation halves the size, so any cascade
 * terminates in a few generations — no infinite recursion, no per-body
 * brittle-override state.
 *
 * All geometry and the shatter decision below are pure: the world layer
 * (world.ts) supplies only live transforms and the measured contact force.
 */
import type { BodyEntity, BodyShape } from "./document";
import type { DocumentId } from "./world";

/**
 * Impact threshold, in multiples of the body's own resting contact load
 * (mass × |gravity|): the contact force must reach this factor to shatter.
 * Weight-relative rather than absolute so a resting contact NEVER shatters,
 * whatever the body's mass (a resting box sees force ≈ mass·g = 1×; a hard
 * drop peaks two orders of magnitude higher — measured in
 * tests/unit/brittle.test.ts). The world floors |gravity| at
 * {@link BRITTLE_MIN_GRAVITY} so zero-g idle touches cannot shatter.
 */
export const BRITTLE_IMPULSE_THRESHOLD = 60;

/**
 * Smallest half-extent (half-size for boxes, radius for circles) a body may
 * have and still shatter — the cascade guard documented in the module header.
 */
export const BRITTLE_MIN_HALF_SIZE = 1;

/**
 * Gravity-magnitude floor for the threshold (m/s²): at zero gravity the
 * resting load is zero, so an unclamped weight-relative threshold would let
 * any floating touch shatter a body. A body flung hard in zero-g still
 * produces a large contact force and shatters — only the idle-touch case is
 * excluded.
 */
export const BRITTLE_MIN_GRAVITY = 1;

/** Minimum half-extent that can shatter, per shape; null = never fragments. */
export function brittleMinHalfExtent(shape: BodyShape): number | null {
	if (shape.kind === "box") return Math.min(shape.halfWidth, shape.halfHeight);
	if (shape.kind === "circle") return shape.radius;
	// Polygons (convex and concave): no fragmentation in this unit.
	return null;
}

/** Inputs to the shatter decision — all plain data, no Rapier handles. */
export interface ShatterCheck {
	readonly shape: BodyShape;
	readonly brittle: boolean;
	readonly isStatic: boolean;
	readonly mass: number;
	/** Rapier's total contact force magnitude for the impact (force units). */
	readonly impactForce: number;
	/** Gravity magnitude (m/s²); floored internally, see BRITTLE_MIN_GRAVITY. */
	readonly gravity: number;
}

/**
 * The shatter decision: only a dynamic, above-minimum-size, non-polygon
 * brittle body shatters, and only when the impact force reaches
 * BRITTLE_IMPULSE_THRESHOLD multiples of its resting load.
 */
export function shouldShatter(check: ShatterCheck): boolean {
	if (!check.brittle || check.isStatic) return false;
	const minHalf = brittleMinHalfExtent(check.shape);
	if (minHalf === null || minHalf < BRITTLE_MIN_HALF_SIZE) return false;
	const restingLoad =
		check.mass * Math.max(Math.abs(check.gravity), BRITTLE_MIN_GRAVITY);
	return check.impactForce >= BRITTLE_IMPULSE_THRESHOLD * restingLoad;
}

/** One fragment: shape + parent-local (unrotated) centre offset. */
export interface FragmentSpec {
	readonly shape: BodyShape;
	readonly dx: number;
	readonly dy: number;
}

/**
 * The fragment layout for a shattering shape: box → 2×2 half-size grid,
 * circle → 4 half-radius discs at the quadrant centres. Area is conserved
 * exactly in both cases. Null (and no fragments) for polygons.
 */
export function fragmentSpecs(
	shape: BodyShape,
): readonly FragmentSpec[] | null {
	if (shape.kind === "box") {
		const hx = shape.halfWidth / 2;
		const hy = shape.halfHeight / 2;
		return [
			{
				shape: { kind: "box", halfWidth: hx, halfHeight: hy },
				dx: -hx,
				dy: -hy,
			},
			{
				shape: { kind: "box", halfWidth: hx, halfHeight: hy },
				dx: hx,
				dy: -hy,
			},
			{
				shape: { kind: "box", halfWidth: hx, halfHeight: hy },
				dx: -hx,
				dy: hy,
			},
			{ shape: { kind: "box", halfWidth: hx, halfHeight: hy }, dx: hx, dy: hy },
		];
	}
	if (shape.kind === "circle") {
		const r = shape.radius / 2;
		const d = shape.radius / 2;
		return [
			{ shape: { kind: "circle", radius: r }, dx: -d, dy: -d },
			{ shape: { kind: "circle", radius: r }, dx: d, dy: -d },
			{ shape: { kind: "circle", radius: r }, dx: -d, dy: d },
			{ shape: { kind: "circle", radius: r }, dx: d, dy: d },
		];
	}
	return null;
}

/**
 * Full document entities for a shatter: fragments carry the parent's material
 * and rotation, are always dynamic, and sit at the parent's LIVE world pose
 * (passed in by the world layer — the document transform is stale mid-sim).
 */
export function fragmentEntities(
	mint: () => DocumentId,
	entity: BodyEntity,
	live: { x: number; y: number; rot: number },
): BodyEntity[] {
	const specs = fragmentSpecs(entity.shape);
	if (!specs) return [];
	const cos = Math.cos(live.rot);
	const sin = Math.sin(live.rot);
	return specs.map((spec) => ({
		kind: "body",
		id: mint(),
		shape: spec.shape,
		x: live.x + spec.dx * cos - spec.dy * sin,
		y: live.y + spec.dx * sin + spec.dy * cos,
		rot: live.rot,
		materialId: entity.materialId,
		isStatic: false,
	}));
}
