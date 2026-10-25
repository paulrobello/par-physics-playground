/**
 * Gear and belt coupling (post-MVP gear drive, PRD R6 custom-constraint
 * seam): a two-sided velocity-level ANGULAR constraint evaluated per fixed
 * tick from {@link src/lib/world.ts} — Rapier 0.21 has no gear joint, and
 * tooth contact is never simulated (teeth are a decorative glyph overlay;
 * the circles stay ordinary colliders and the mounting is the user's pin
 * joints).
 *
 * Semantics (what the code does): the constraint error is the arc-length
 * phase mismatch C = rA·ΔθA + m·rB·ΔθB where rA/rB are the coupled circles'
 * radii (ratio = rA/rB captured at placement), m = +1 for a gear (mesh —
 * the spins oppose) and −1 for a belt (same direction), and Δθ are the
 * rotations SINCE PLACEMENT, accumulated by the caller from Rapier's
 * wrapped `rotation()` reads via {@link wrapAngleDelta} — the placement
 * anchor is what keeps drawn teeth visually meshed. The solve returns the
 * impulse-per-lever λ = −(Ċ + bias) / K that drives the arc-length rate
 * Ċ to −bias this tick; the caller applies λ·rA as a torque impulse on A
 * and m·λ·rB on B. K is the angular inverse effective mass
 * rA²·invIA + rB²·invIB with invI Rapier's own
 * `effectiveWorldInvInertia()` — no fake finite masses, and static gears
 * contribute zero (a locked static gear stops its partner: physical).
 *
 * Stability: engagement drives Ċ exactly to −bias, where
 * bias = sign(C)·min(β·max(|C|−slop, 0)/dt, GEAR_MAX_CORRECTION) reels the
 * phase error back at a bounded rate — inside the slop band only the
 * velocity term acts (no jitter), and the cap bounds a one-tick correction
 * to GEAR_MAX_CORRECTION·dt ≈ 0.33 world units when a teleport or undo
 * leaves a huge error. The constants mirror the measured-stable pulley
 * values (PULLEY_BAUMGARTE / PULLEY_SLOP / PULLEY_MAX_REEL_SPEED). The
 * two-sided exchange and the degenerate guards are pinned by the fixed-step
 * sim tests in tests/unit/gears.test.ts rather than claimed in general.
 */

/** Fraction of the out-of-phase arc corrected per tick (Box2D Baumgarte factor). */
export const GEAR_BAUMGARTE = 0.2;

/** Phase arc within this world-unit length is not actively corrected
 * (jitter guard) — the velocity term still acts there; the slop only
 * suppresses the bias term. */
export const GEAR_SLOP = 0.01;

/** Upper bound on the bias correction speed (world units/s): bounds the
 * one-tick correction when a teleport or undo leaves a huge phase error. */
export const GEAR_MAX_CORRECTION = 20;

/**
 * Wrap an angle difference to (−π, π]: the per-tick rotation delta between
 * two of Rapier's wrapped `rotation()` reads (the raw difference exceeds ±π
 * exactly when the body turned more than half a revolution between reads).
 * Non-finite input wraps to 0 (never NaN).
 */
export function wrapAngleDelta(x: number): number {
	if (!Number.isFinite(x)) return 0;
	const y = x % (Math.PI * 2);
	if (y > Math.PI) return y - Math.PI * 2;
	if (y <= -Math.PI) return y + Math.PI * 2;
	return y;
}

/**
 * The two-sided angular impulse-per-lever for one fixed tick. `c` is the
 * arc-length phase error (world units, any sign), `cv` the arc-length rate
 * (units/s), `invEffMass` the angular inverse effective mass K (1/mass;
 * 0 = both endpoints immovable), `dt` the fixed tick in seconds. Returns a
 * signed impulse λ in world mass·velocity units; all degenerate or
 * non-finite inputs return 0 (never NaN).
 */
export function solveGearImpulse(
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
		invEffMass <= 0
	) {
		return 0;
	}
	const bias =
		Math.sign(c) *
		Math.min(
			(GEAR_BAUMGARTE * Math.max(Math.abs(c) - GEAR_SLOP, 0)) / dt,
			GEAR_MAX_CORRECTION,
		);
	const j = -(cv + bias) / invEffMass;
	if (!Number.isFinite(j)) return 0;
	return j;
}
