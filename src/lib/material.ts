/**
 * Material data model and the predefined palette (PRD P3 / D5). A material is
 * a named bundle of physics properties (density, friction, restitution) plus
 * the render color. The registry itself lives in the scene document
 * (src/lib/document.ts) — custom materials are document entities, and the
 * predefined palette below seeds every document. `ink` is the default: every
 * body that does not name a material is ink (data-only default per the
 * phase-1 slate tone).
 *
 * Values are provisional line-run numbers, tuned in review.
 */
export interface Material {
	/** Stable registry key bodies reference (`materialId`). */
	readonly id: string;
	/** Human label for the palette UI (P3-T2 editor). */
	readonly name: string;
	/** Fill color for dynamic bodies; dark-UI readable on the #111418 canvas. */
	readonly color: string;
	/** Area density: mass = density × collider area (2D). */
	readonly density: number;
	/** Coulomb friction coefficient. */
	readonly friction: number;
	/** Restitution (bounciness), 0 = dead stop. */
	readonly restitution: number;
	/**
	 * Brittle: a hard contact impact shatters a DYNAMIC body of this material
	 * into same-material fragments (box and circle shapes only — see
	 * brittle.ts for the decision and fragment geometry). Optional; absent or
	 * false means indestructible.
	 */
	readonly brittle?: boolean;
	/**
	 * Flammable: a firing thruster's exhaust ignites a body of this material;
	 * it burns for a fixed duration and is removed from the world, igniting
	 * flammable bodies it touches while burning (see flammable.ts for the
	 * ignition, spread, and burn-out rules). Optional; absent or false means
	 * fire-proof. The fire itself is runtime-only — never serialized.
	 */
	readonly flammable?: boolean;
}

/** The default palette entry; bodies and lookups fall back to it. */
export const MATERIAL_DEFAULT_ID = "ink";

/**
 * The predefined palette, seeded into every document's material registry in
 * UI order. Brief-pinned values: wood 0.25/0.7/0.2 and stone 2.5/0.9/0.05;
 * the rest follow the same provisional pattern (metal heavy + slippery-ish,
 * rubber high restitution, ice near-zero friction, ink the phase-1 slate
 * middle ground).
 */
export const MATERIAL_PREDEFINED: readonly Material[] = [
	{
		id: "ink",
		name: "Ink",
		color: "#98a2b3", // hud-text-secondary token
		density: 1,
		friction: 0.5,
		restitution: 0.1,
	},
	{
		id: "wood",
		name: "Wood",
		color: "#b5834f", // warm tan
		density: 0.25,
		friction: 0.7,
		restitution: 0.2,
	},
	{
		id: "stone",
		name: "Stone",
		color: "#a89f94", // warm gray
		density: 2.5,
		friction: 0.9,
		restitution: 0.05,
	},
	{
		id: "metal",
		name: "Metal",
		color: "#7ea8d8", // steel blue
		density: 7.8,
		friction: 0.35,
		restitution: 0.05,
	},
	{
		id: "rubber",
		name: "Rubber",
		color: "#c46a5f", // terracotta
		density: 1.2,
		friction: 0.9,
		restitution: 0.85,
	},
	{
		id: "ice",
		name: "Ice",
		color: "#9fdcec", // pale cyan
		density: 0.92,
		friction: 0.02,
		restitution: 0.05,
	},
];

/**
 * Validate user-authored material values (P3-T2 editor and the IndexedDB
 * load path). Returns an error message when the values cannot safely reach
 * Rapier — density must be finite and > 0 (a zero or negative density zeroes
 * the mass and wedges the solver), friction and restitution are coefficients
 * bounded to [0, 1], and the palette UI needs a non-empty name. Null when
 * valid.
 */
export function materialValuesError(values: {
	name: string;
	density: number;
	friction: number;
	restitution: number;
}): string | null {
	if (!Number.isFinite(values.density) || values.density <= 0)
		return "Density must be a positive number.";
	if (
		!Number.isFinite(values.friction) ||
		values.friction < 0 ||
		values.friction > 1
	)
		return "Friction must be between 0 and 1.";
	if (
		!Number.isFinite(values.restitution) ||
		values.restitution < 0 ||
		values.restitution > 1
	)
		return "Restitution must be between 0 and 1.";
	if (values.name.trim().length === 0) return "Name must not be empty.";
	return null;
}

/** Look up a palette entry by id; throws on a palette-definition mistake. */
function paletteEntry(id: string): Material {
	const found = MATERIAL_PREDEFINED.find((m) => m.id === id);
	if (!found) throw new Error(`predefined palette has no entry "${id}"`);
	return found;
}

/** The default material itself (the registry's ink entry). */
export const MATERIAL_INK: Material = paletteEntry(MATERIAL_DEFAULT_ID);
