/**
 * Default material for all spawned bodies. Ink-like damping feel per the
 * phase-1 brief (density 1, friction 0.5, restitution 0.1 — provisional,
 * from line-run's values). Color is the HUD secondary-text token (#98a2b3):
 * the one flat slate tone already in the phase-0 palette.
 */
export interface Material {
	readonly density: number;
	readonly friction: number;
	readonly restitution: number;
	readonly color: string;
}

export const MATERIAL_DEFAULT: Material = {
	density: 1,
	friction: 0.5,
	restitution: 0.1,
	color: "#98a2b3",
};
