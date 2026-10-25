/**
 * Melting material behavior (materials extra): a body whose material carries
 * `melting: true` accumulates heat while a firing thruster's exhaust beam
 * rests on it and, after MELT_SECONDS of accumulated aim, disappears from
 * the world. No fire, no contact spread — only the aimed exhaust heats (see
 * flammable.ts for the exhaust-ray scan in world.ts, which this feature
 * shares). On a body with both flags flammable WINS: the world routes the
 * ray hit to ignition, and the burn removes the body long before the melt
 * window could complete.
 *
 * Heat state is RUNTIME-ONLY — never serialized; a reload or repaint clears
 * it like the fire state. The disappearance is a SIM event (the brittle
 * removal precedent): the ordinary removeBody cascade, no undo boundary.
 *
 * Render cue (owner spec): the body shrinks over the FINAL second of the
 * accumulation window, from full size down to MELT_MIN_SCALE, then is
 * removed. The collider keeps its true size throughout — the shrink is a
 * cue, not physics.
 */

/** Seconds of accumulated exhaust aim before a melting body disappears. */
export const MELT_SECONDS = 6;

/** The shrink cue runs over this much of the accumulation window's end. */
export const MELT_SHRINK_WINDOW_SECONDS = 1;

/** Floor of the melt shrink cue — never fully invisible before removal. */
export const MELT_MIN_SCALE = 0.45;

/**
 * Melt-through comparison slack: heat accumulates as SIM_DT_SECONDS
 * additions (binary floats can land a hair under the threshold), so the
 * comparison keeps the removal tick deterministic across machines.
 */
const MELT_OUT_SLACK = 1e-9;

/**
 * True when a body's accumulated heat has reached the melt threshold (the
 * body disappears — removed by world.ts).
 */
export function isMeltedThrough(heatSeconds: number): boolean {
	return heatSeconds >= MELT_SECONDS - MELT_OUT_SLACK;
}

/**
 * Render scale for a body accumulating melt heat: 1 until the final
 * {@link MELT_SHRINK_WINDOW_SECONDS}, then linear down to
 * {@link MELT_MIN_SCALE} at the melt threshold. The interpolation anchors on
 * MELT_MIN_SCALE so the floor value is hit exactly at progress 1.
 */
export function meltRenderScale(heatSeconds: number): number {
	const remaining = MELT_SECONDS - heatSeconds;
	if (remaining >= MELT_SHRINK_WINDOW_SECONDS) return 1;
	const progress = Math.min(
		1,
		Math.max(0, MELT_SHRINK_WINDOW_SECONDS - remaining) /
			MELT_SHRINK_WINDOW_SECONDS,
	);
	return MELT_MIN_SCALE + (1 - progress) * (1 - MELT_MIN_SCALE);
}
