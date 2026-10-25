/**
 * Scene file (P5-T1/T2): the serializable form of a whole world — every
 * document entity plus the CUSTOM materials bodies reference (predefined
 * palette entries stay implicit; they are code, not data). Both persistence
 * transports build on this one module: the IndexedDB scene store and the
 * JSON export/import path serialize the exact same object, so a saved scene,
 * an autosave, and an exported file are interchangeable.
 *
 * Validation is defensive (the line-run tradition): an imported file is
 * UNTRUSTED until every field is shape- and bounds-checked, and a rejection
 * names the offense so the import path can surface it visibly without
 * touching the live world.
 */
import type { DocEntity } from "./document";
import { syncEntityIdCounters } from "./interaction";
import { MATERIAL_PREDEFINED, type Material } from "./material";
import type { PhysicsWorld } from "./world";

export const SCENE_SCHEMA_VERSION = 1;

/** The document surface buildSceneFile needs (PhysicsWorld.doc satisfies it). */
export interface SceneDoc {
	all(): readonly DocEntity[];
	allMaterials(): Material[];
}

/** What a scene file carries between sessions, stores, and files. */
export interface SceneFile {
	readonly schemaVersion: number;
	readonly entities: readonly DocEntity[];
	readonly customMaterials: readonly Material[];
	readonly savedAt: number;
}

/** Defensive bounds for imported geometry (provisional, line-run tradition). */
export const SCENE_BOUNDS = {
	maxAbsCoord: 10_000,
	maxHalfExtent: 1_000,
	maxBodies: 1_200,
	maxEntities: 1_600,
	maxLabelText: 200,
	maxLabelSize: 512,
	maxThrusterStrength: 1e7,
} as const;

/** Serialize the current document (entities + custom materials). */
export function buildSceneFile(doc: SceneDoc): SceneFile {
	const predefined = new Set(MATERIAL_PREDEFINED.map((m) => m.id));
	return {
		schemaVersion: SCENE_SCHEMA_VERSION,
		entities: doc.all().map((e) => structuredClone(e)),
		customMaterials: doc
			.allMaterials()
			.filter((m) => !predefined.has(m.id))
			.map((m) => ({ ...m })),
		savedAt: Date.now(),
	};
}

/**
 * Rebuild a world from a scene file: custom materials re-register first (a
 * colliding id is OVERWRITTEN with the file's definition — the file wins),
 * id minters are advanced past every restored id (review C1: a fresh mint
 * colliding with a restored body silently replaces it and cascades its
 * joints/thrusters away), then the ordinary restoreSnapshot path rebuilds
 * bodies-before-joints. ATOMIC: an entity spawnable check that throws
 * mid-restore (e.g. a self-intersecting polygon the shape validator cannot
 * see) rolls the entity set back to the pre-apply state and rethrows, so a
 * refused file never leaves a half-built world (review I3).
 */
export function applySceneFile(world: PhysicsWorld, file: SceneFile): void {
	syncEntityIdCounters(file.entities);
	for (const material of file.customMaterials) {
		if (!world.doc.updateMaterial(material)) world.doc.addMaterial(material);
	}
	const previous = world.doc.all();
	try {
		world.restoreSnapshot(file.entities);
	} catch (err) {
		world.restoreSnapshot(previous);
		throw err;
	}
}

export type SceneFileValidation =
	| { ok: true; file: SceneFile }
	| { ok: false; error: string };

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function checkMaterial(raw: unknown, index: number): string | null {
	if (typeof raw !== "object" || raw === null) {
		return `customMaterials[${index}]: not an object`;
	}
	const m = raw as Record<string, unknown>;
	if (typeof m.id !== "string" || typeof m.name !== "string") {
		return `customMaterials[${index}]: id and name must be strings`;
	}
	for (const key of ["density", "friction", "restitution"] as const) {
		if (!isFiniteNumber(m[key])) {
			return `customMaterials[${index}].${key}: not a finite number`;
		}
	}
	const { density, friction, restitution } = m as {
		density: number;
		friction: number;
		restitution: number;
	};
	if (density < 0.01 || density > 100) {
		return `customMaterials[${index}].density ${density} outside [0.01, 100]`;
	}
	if (friction < 0 || friction > 2) {
		return `customMaterials[${index}].friction ${friction} outside [0, 2]`;
	}
	if (restitution < 0 || restitution > 1) {
		return `customMaterials[${index}].restitution ${restitution} outside [0, 1]`;
	}
	if (typeof m.color !== "string" || m.color.length > 32) {
		return `customMaterials[${index}].color: invalid`;
	}
	if (m.brittle !== undefined && typeof m.brittle !== "boolean") {
		return `customMaterials[${index}].brittle: not a boolean`;
	}
	return null;
}

function checkEntity(raw: unknown, index: number): string | null {
	if (typeof raw !== "object" || raw === null) {
		return `entities[${index}]: not an object`;
	}
	const e = raw as Record<string, unknown>;
	if (
		e.kind !== "body" &&
		e.kind !== "label" &&
		e.kind !== "joint" &&
		e.kind !== "thruster"
	) {
		return `entities[${index}].kind "${String(e.kind)}" is not a known entity kind`;
	}
	if (typeof e.id !== "string" || e.id.length === 0 || e.id.length > 128) {
		return `entities[${index}].id: invalid`;
	}
	for (const key of ["x", "y", "rot"]) {
		if (key in e && !isFiniteNumber(e[key])) {
			return `entities[${index}].${key}: not a finite number`;
		}
	}
	if (e.kind !== "body") {
		// Non-body numeric/text params (review I2: the declared bounds must
		// actually gate — a 1e308 thruster or a megabyte label is not a scene).
		if (e.kind === "thruster") {
			for (const key of ["anchorX", "anchorY", "angle", "strength"] as const) {
				if (!isFiniteNumber((e as Record<string, unknown>)[key])) {
					return `entities[${index}].${key}: not a finite number`;
				}
			}
			const strength = (e as Record<string, unknown>).strength;
			if (
				typeof strength === "number" &&
				strength > SCENE_BOUNDS.maxThrusterStrength
			) {
				return `thruster ${String(e.id)} strength above ${SCENE_BOUNDS.maxThrusterStrength}`;
			}
		}
		if (e.kind === "label") {
			const text = (e as Record<string, unknown>).text;
			if (typeof text !== "string" || text.length > SCENE_BOUNDS.maxLabelText) {
				return `label ${String(e.id)} text missing or over ${SCENE_BOUNDS.maxLabelText} chars`;
			}
			const style = e as Record<string, unknown>;
			if (
				style.size !== undefined &&
				(!isFiniteNumber(style.size) ||
					style.size <= 0 ||
					style.size > SCENE_BOUNDS.maxLabelSize)
			) {
				return `label ${String(e.id)} size outside (0, ${SCENE_BOUNDS.maxLabelSize}]`;
			}
			if (
				style.font !== undefined &&
				style.font !== "sans" &&
				style.font !== "serif" &&
				style.font !== "mono"
			) {
				return `label ${String(e.id)} font "${String(style.font)}" is not a known family`;
			}
			if (
				style.align !== undefined &&
				style.align !== "left" &&
				style.align !== "center" &&
				style.align !== "right"
			) {
				return `label ${String(e.id)} align "${String(style.align)}" is not a known alignment`;
			}
		}
		if (e.kind === "joint") {
			const params = (e as Record<string, unknown>).params as
				| Record<string, unknown>
				| undefined;
			if (typeof params !== "object" || params === null) {
				return `joint ${String(e.id)}: missing params`;
			}
			for (const [key, value] of Object.entries(params)) {
				if (typeof value === "number" && !Number.isFinite(value)) {
					return `joint ${String(e.id)} params.${key}: not finite`;
				}
			}
			if (params.kind === "pulley") {
				// The wheel is a world point like a body center and the rope
				// length must be a usable positive length: bounded validation
				// (provisional like the body bounds) — a 1e100 length could never
				// go taut and a mistyped field would zero the tension solve.
				const length = params.length;
				if (
					typeof length !== "number" ||
					!Number.isFinite(length) ||
					length <= 0 ||
					length > 4 * SCENE_BOUNDS.maxAbsCoord
				) {
					return `joint ${String(e.id)} params.length ${String(length)} outside (0, ${4 * SCENE_BOUNDS.maxAbsCoord}]`;
				}
				for (const key of ["wheelX", "wheelY"] as const) {
					const v = params[key];
					if (
						typeof v !== "number" ||
						!Number.isFinite(v) ||
						Math.abs(v) > SCENE_BOUNDS.maxAbsCoord
					) {
						return `joint ${String(e.id)} params.${key} ${String(v)} outside ±${SCENE_BOUNDS.maxAbsCoord}`;
					}
				}
			}
		}
		return null;
	}

	const b = e as Record<string, unknown>;
	if (!isFiniteNumber(b.x) || !isFiniteNumber(b.y)) {
		return `entities[${index}]: x and y must be finite numbers`;
	}
	if (
		Math.abs(b.x) > SCENE_BOUNDS.maxAbsCoord ||
		Math.abs(b.y) > SCENE_BOUNDS.maxAbsCoord
	) {
		return `body ${String(b.id)} at (${b.x}, ${b.y}) outside ±${SCENE_BOUNDS.maxAbsCoord}`;
	}
	const shape = b.shape;
	if (typeof shape !== "object" || shape === null) {
		return `body ${String(b.id)}: missing shape`;
	}
	const s = shape as Record<string, unknown>;
	if (s.kind === "box") {
		if (
			!isFiniteNumber(s.halfWidth) ||
			!isFiniteNumber(s.halfHeight) ||
			s.halfWidth <= 0 ||
			s.halfHeight <= 0 ||
			s.halfWidth > SCENE_BOUNDS.maxHalfExtent ||
			s.halfHeight > SCENE_BOUNDS.maxHalfExtent
		) {
			return `body ${String(b.id)}: box half-extents outside (0, ${SCENE_BOUNDS.maxHalfExtent}]`;
		}
	} else if (s.kind === "circle") {
		if (
			!isFiniteNumber(s.radius) ||
			s.radius <= 0 ||
			s.radius > SCENE_BOUNDS.maxHalfExtent
		) {
			return `body ${String(b.id)}: circle radius outside (0, ${SCENE_BOUNDS.maxHalfExtent}]`;
		}
	} else if (s.kind === "polygon") {
		if (
			!Array.isArray(s.points) ||
			s.points.length < 3 ||
			s.points.length > 512
		) {
			return `body ${String(b.id)}: polygon needs 3–512 points`;
		}
		for (const p of s.points) {
			const q = p as Record<string, unknown>;
			if (
				!isFiniteNumber(q.x) ||
				!isFiniteNumber(q.y) ||
				Math.abs(q.x) > SCENE_BOUNDS.maxAbsCoord ||
				Math.abs(q.y) > SCENE_BOUNDS.maxAbsCoord
			) {
				return `body ${String(b.id)}: polygon point outside ±${SCENE_BOUNDS.maxAbsCoord}`;
			}
		}
	} else {
		return `body ${String(b.id)}: unknown shape kind "${String(s.kind)}"`;
	}
	if (b.materialId !== undefined && typeof b.materialId !== "string") {
		return `body ${String(b.id)}: materialId must be a string`;
	}
	return null;
}

/**
 * Validate an UNTRUSTED parsed JSON value as a scene file. Returns the typed
 * file on success, or a human-readable offense on the first violation.
 */
export function validateSceneFile(raw: unknown): SceneFileValidation {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		return { ok: false, error: "scene file: not a JSON object" };
	}
	const f = raw as Record<string, unknown>;
	if (f.schemaVersion !== SCENE_SCHEMA_VERSION) {
		return {
			ok: false,
			error: `scene file: schemaVersion ${String(f.schemaVersion)} is not ${SCENE_SCHEMA_VERSION}`,
		};
	}
	if (!Array.isArray(f.entities)) {
		return { ok: false, error: "scene file: entities must be an array" };
	}
	if (f.entities.length > SCENE_BOUNDS.maxEntities) {
		return {
			ok: false,
			error: `scene file: ${f.entities.length} entities exceeds the ${SCENE_BOUNDS.maxEntities} guard`,
		};
	}
	if (!Array.isArray(f.customMaterials)) {
		return { ok: false, error: "scene file: customMaterials must be an array" };
	}
	const bodies = f.entities.filter(
		(e) => (e as Record<string, unknown>).kind === "body",
	);
	if (bodies.length > SCENE_BOUNDS.maxBodies) {
		return {
			ok: false,
			error: `scene file: ${bodies.length} bodies exceeds the ${SCENE_BOUNDS.maxBodies} D17 guard`,
		};
	}
	for (let i = 0; i < f.entities.length; i++) {
		const err = checkEntity(f.entities[i], i);
		if (err) return { ok: false, error: err };
	}
	for (let i = 0; i < f.customMaterials.length; i++) {
		const err = checkMaterial(f.customMaterials[i], i);
		if (err) return { ok: false, error: err };
	}
	return {
		ok: true,
		file: {
			schemaVersion: SCENE_SCHEMA_VERSION,
			entities: f.entities as DocEntity[],
			customMaterials: f.customMaterials as Material[],
			savedAt: isFiniteNumber(f.savedAt) ? f.savedAt : Date.now(),
		},
	};
}
