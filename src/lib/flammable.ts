/**
 * Flammable material behavior (materials extra): a body whose material
 * carries `flammable: true` ignites from a firing thruster's exhaust and,
 * after a fixed burn, is REMOVED from the world (consumed). Burning bodies
 * ignite flammable bodies they touch (spread). Fire state is RUNTIME-ONLY —
 * never serialized: a save/load or reload mid-fire extinguishes; the flags
 * themselves persist like every material value.
 *
 * Ignition source (owner spec, 2026-10-25): a firing thruster's exhaust
 * path. The renderer's exhaust plume shoots OPPOSITE the thrust direction,
 * so the sim casts the same ray (world.ts): origin at the live mount
 * anchor, direction opposite the thrust, length EXHAUST_IGNITION_REACH. The
 * first body the ray reaches decides: flammable → ignites; anything else →
 * the exhaust is blocked (heat does not jump obstacles). Contact spread
 * reuses the brittle contact-event drain: an ignited body's colliders arm
 * CONTACT_FORCE_EVENTS at ignition (not at spawn, so steady-state flammable
 * scenes generate no per-tick event traffic), and an event pairing a
 * burning body with a flammable body ignites the latter.
 *
 * The burn and its removal are SIM events like the brittle shatter — no
 * undo boundary; the removal converges through removeBody's ordinary
 * cascade (joints/thrusters die with the body, the removal notification
 * fires). Melting (melting.ts) shares the exhaust-ray scan in world.ts but
 * never spreads; on a body with both flags flammable wins.
 */

/** Seconds a flammable body burns before it is consumed and removed. */
export const BURN_SECONDS = 4;

/**
 * Exhaust reach, in world units: how far a firing thruster's exhaust ray
 * looks for a flammable body. The drawn plume is screen-constant
 * (renderer.ts), so it has no fixed world length; this reach is the sim's
 * v1 rule — a few body widths past the mount.
 */
export const EXHAUST_IGNITION_REACH = 12;

/**
 * Burn-out comparison slack: burned time accumulates as SIM_DT_SECONDS
 * additions (240 × 1⁄60 in binary floats can land a hair under 4), so the
 * threshold compares against BURN_SECONDS minus this slack — the removal
 * tick stays deterministic across machines.
 */
const BURN_OUT_SLACK = 1e-9;

/**
 * True when a body's accumulated burn time has reached the fixed burn
 * duration (the body is consumed and removed by world.ts).
 */
export function isBurnedOut(burnedSeconds: number): boolean {
	return burnedSeconds >= BURN_SECONDS - BURN_OUT_SLACK;
}
