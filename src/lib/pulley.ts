/**
 * Pulley tension solve (post-MVP fixed pulley, PRD R6 custom-constraint
 * seam): a one-sided velocity-level rope constraint evaluated per fixed tick
 * from {@link src/lib/world.ts} — Rapier 0.21 has no pulley joint, and the
 * 0.21 rope joint is a two-body max-distance limit that cannot route through
 * a shared wheel point.
 *
 * Semantics (what the code does): the constraint error is the rope-path
 * surplus c = dist(A→wheel) + dist(wheel→B) − length. For c ≤ 0 the rope is
 * slack and applies nothing (one-sided — a rope pulls, never pushes). For any
 * c > 0 the solve returns the tension IMPULSE J = max(0, (ċ + bias) / K)
 * that cancels the path-lengthening velocity ċ this tick and, above the
 * slop, reels the surplus back in at a bounded rate
 * (bias = min(β·(c−slop)/dt, reel cap)) — so inside the slop band the rope
 * still arrests separation but does not actively reel. K is the total
 * inverse EFFECTIVE mass along the two rope directions — per body
 * 1/m + (r×û)²/I with r the anchor's lever arm from the center of mass —
 * assembled by the caller (applyPulleyTension in world.ts), so off-center
 * anchors engage angular inertia and static endpoints contribute zero.
 *
 * Stability: taut engagement drives the path velocity exactly to −bias
 * (a slow separating path is stopped AND slightly reversed by the reel-in
 * bias; one already retracting faster than the bias is left alone, since
 * the clamp keeps J at 0), and the reversal is bounded by the bias formula
 * min(β·(c−slop)/dt, PULLEY_MAX_REEL_SPEED). The exchange, slack, and
 * off-center behaviors are pinned by the fixed-step sim tests in
 * tests/unit/pulley.test.ts rather than claimed in general.
 */

/** Fraction of the over-length reeled in per tick (Box2D Baumgarte factor). */
export const PULLEY_BAUMGARTE = 0.2;

/** Path surplus within this world-unit length is not actively reeled in
 * (jitter guard) — separation is still arrested there; the slop only
 * suppresses the bias term. */
export const PULLEY_SLOP = 0.01;

/** Upper bound on the bias reel-in speed (world units/s): bounds the
 * one-tick correction when a teleport leaves a huge surplus. */
export const PULLEY_MAX_REEL_SPEED = 20;

/** A rope leg shorter than this is degenerate (anchor on the wheel): no pull. */
export const PULLEY_MIN_LEG = 1e-6;

/**
 * The one-sided tension impulse for one fixed tick. `c` is the path surplus
 * over the rope length (world units), `cv` the rate the path is lengthening
 * (units/s), `invEffMass` the total inverse effective mass K along the two
 * rope directions (1/mass; 0 = both endpoints immovable), `dt` the fixed
 * tick in seconds. Returns an impulse ≥ 0 in world mass·velocity units; all
 * degenerate or non-finite inputs return 0 (never NaN).
 */
export function solvePulleyImpulse(
	c: number,
	cv: number,
	invEffMass: number,
	dt: number,
): number {
	if (
		!Number.isFinite(c) ||
		!Number.isFinite(cv) ||
		!Number.isFinite(invEffMass) ||
		!Number.isFinite(dt) ||
		dt <= 0 ||
		invEffMass <= 0 ||
		c <= 0
	) {
		return 0;
	}
	const bias = Math.min(
		(PULLEY_BAUMGARTE * Math.max(c - PULLEY_SLOP, 0)) / dt,
		PULLEY_MAX_REEL_SPEED,
	);
	const j = (cv + bias) / invEffMass;
	if (!Number.isFinite(j) || j <= 0) return 0;
	return j;
}
