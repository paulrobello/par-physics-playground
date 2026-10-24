/**
 * Serializable scene document (PRD "Document model"): the scene is a document
 * of bodies whose simulation state the physics world rebuilds from it. Bodies
 * carry id, shape, transform, material ref, and the static flag; labels are
 * non-physical document entities (drawn + hit-tested, never simulated). Later
 * phases (undo snapshots in P2-T5) route through this API. Shape kinds are
 * open-ended; box, circle, and polygon are implemented.
 */

import {
	MATERIAL_DEFAULT_ID,
	MATERIAL_INK,
	MATERIAL_PREDEFINED,
	type Material,
} from "./material";
import type { Vec2 } from "./triangulate";
import type { DocumentId } from "./world";

/** Render/physics shape of a body, recorded in the document. */
export type BodyShape =
	| {
			readonly kind: "box";
			readonly halfWidth: number;
			readonly halfHeight: number;
	  }
	| { readonly kind: "circle"; readonly radius: number }
	/**
	 * Simple polygon, `points` in body-local coordinates (origin = the
	 * entity's position, which is the polygon's area centroid). Convex input
	 * becomes a single convex-hull collider; concave input is decomposed into
	 * triangle colliders on one body (see world.spawnPolygon).
	 */
	| { readonly kind: "polygon"; readonly points: readonly Vec2[] };

/**
 * Collider area per shape kind, the geometry half of mass derivation
 * (mass = density x area in 2D): box (2·halfWidth)·(2·halfHeight), circle
 * π·r², polygon |shoelace|. A line-tool beam commits as a box
 * (halfWidth = half length, halfHeight = half thickness), so the box formula
 * covers it: length × thickness.
 */
export function colliderArea(shape: BodyShape): number {
	if (shape.kind === "box") {
		return 4 * shape.halfWidth * shape.halfHeight;
	}
	if (shape.kind === "circle") {
		return Math.PI * shape.radius * shape.radius;
	}
	return Math.abs(polygonSignedArea(shape.points));
}

/** Shoelace signed area (positive = counter-clockwise in a y-down world). */
function polygonSignedArea(points: readonly Vec2[]): number {
	let sum = 0;
	for (let i = 0; i < points.length; i++) {
		const a = points[i] as Vec2;
		const b = points[(i + 1) % points.length] as Vec2;
		sum += a.x * b.y - b.x * a.y;
	}
	return sum / 2;
}

/**
 * Mass and centroidal angular inertia implied by geometry + density — the
 * documented derivation the colliders follow (Rapier computes the same values
 * from `setDensity`; asserted equal in tests/unit/material.test.ts). Inertia
 * is the shape's second moment of area about the centroid, times density:
 * box m·(w²+h²)/12, circle m·r²/2, polygon the shoelace second-moment sum.
 * Polygon points are body-local (origin = area centroid), so no parallel-axis
 * shift is needed — and a concave polygon's triangle colliders sum to exactly
 * the whole-polygon value.
 */
export function massProperties(
	shape: BodyShape,
	density: number,
): { mass: number; inertia: number } {
	const mass = density * colliderArea(shape);
	if (shape.kind === "box") {
		const w = shape.halfWidth * 2;
		const h = shape.halfHeight * 2;
		return { mass, inertia: (mass * (w * w + h * h)) / 12 };
	}
	if (shape.kind === "circle") {
		return { mass, inertia: (mass * shape.radius * shape.radius) / 2 };
	}
	// Polygon second moment of area about the centroid (points are body-local
	// with origin at the centroid): I = Σ cross/12 · (y²+yy'+y'²) +
	// cross/24 · (2xy+xy'+yx'+2x'y') — combined below as the polar moment.
	let ix = 0;
	let iy = 0;
	for (let i = 0; i < shape.points.length; i++) {
		const a = shape.points[i] as Vec2;
		const b = shape.points[(i + 1) % shape.points.length] as Vec2;
		const cross = a.x * b.y - b.x * a.y;
		ix += (cross * (a.y * a.y + a.y * b.y + b.y * b.y)) / 12;
		iy += (cross * (a.x * a.x + a.x * b.x + b.x * b.x)) / 12;
	}
	return { mass, inertia: density * Math.abs(ix + iy) };
}

/** One document body: identity, geometry, transform, material, static flag. */
export interface BodyEntity {
	readonly kind: "body";
	readonly id: DocumentId;
	readonly shape: BodyShape;
	readonly x: number;
	readonly y: number;
	readonly rot: number;
	readonly materialId: string;
	readonly isStatic: boolean;
}

/**
 * A non-physical label: a document entity the renderer draws and the picker
 * hit-tests, with no Rapier body (PRD D19 uniformity — it selects, moves, and
 * deletes through the same document API). `rot` exists for future editing but
 * no tool sets it yet.
 */
export interface LabelEntity {
	readonly kind: "label";
	readonly id: DocumentId;
	readonly x: number;
	readonly y: number;
	readonly rot: number;
	readonly text: string;
}

/** Anything the document stores: physics bodies and non-physical labels. */
export type DocEntity = BodyEntity | LabelEntity;

export type { Material };

/** Material reference every new body gets (data-only material lives in material.ts). */
export function defaultBody(
	id: DocumentId,
	shape: BodyShape,
	x: number,
	y: number,
	rot = 0,
): BodyEntity {
	return {
		kind: "body",
		id,
		shape,
		x,
		y,
		rot,
		materialId: MATERIAL_DEFAULT_ID,
		isStatic: false,
	};
}

/**
 * The document's entity set: insertion-ordered (spawn order drives draw order
 * and topmost-picking), keyed by document id. Bodies and labels share one
 * namespace and one ordering.
 */
export class SceneDocument {
	private readonly entities = new Map<DocumentId, DocEntity>();
	/**
	 * Material registry: the predefined palette seeded at construction, plus
	 * user customs (P3-T2 editor). Bodies reference entries by `materialId`.
	 */
	private readonly materials = new Map<string, Material>(
		MATERIAL_PREDEFINED.map((m) => [m.id, m]),
	);

	/** Resolve a body's material; unknown ids fall back to the default (ink). */
	material(id: string): Material {
		return (
			this.materials.get(id) ??
			this.materials.get(MATERIAL_DEFAULT_ID) ??
			MATERIAL_INK
		);
	}

	/** All registered materials, in insertion order (palette UI order). */
	allMaterials(): Material[] {
		return [...this.materials.values()];
	}

	/** Register a material; false when the id is already taken. */
	addMaterial(material: Material): boolean {
		if (this.materials.has(material.id)) return false;
		this.materials.set(material.id, material);
		return true;
	}

	/** Replace a registered material's values; false when the id is unknown. */
	updateMaterial(material: Material): boolean {
		if (!this.materials.has(material.id)) return false;
		this.materials.set(material.id, material);
		return true;
	}

	/**
	 * Unregister a material. Predefined palette entries are fixed (refused);
	 * bodies that referenced the removed custom resolve to the ink default at
	 * their next materialization (the render color falls back immediately via
	 * `material`).
	 */
	removeMaterial(id: string): boolean {
		if (MATERIAL_PREDEFINED.some((m) => m.id === id)) return false;
		return this.materials.delete(id);
	}

	add(entity: DocEntity): void {
		this.entities.set(entity.id, entity);
	}

	get(id: DocumentId): DocEntity | undefined {
		return this.entities.get(id);
	}

	remove(id: DocumentId): boolean {
		return this.entities.delete(id);
	}

	/** Update position and rotation; false when the id is unknown. */
	setTransform(id: DocumentId, x: number, y: number, rot: number): boolean {
		const entity = this.entities.get(id);
		if (!entity) return false;
		this.entities.set(id, { ...entity, x, y, rot });
		return true;
	}

	/** Update a label's text; false when the id is unknown or is a body. */
	setLabelText(id: DocumentId, text: string): boolean {
		const entity = this.entities.get(id);
		if (entity?.kind !== "label") return false;
		this.entities.set(id, { ...entity, text });
		return true;
	}

	/**
	 * Point a body at a different material; false when unknown or not a body.
	 * Entities are immutable records, so this replaces the stored entity (the
	 * same pattern as setTransform).
	 */
	setBodyMaterial(id: DocumentId, materialId: string): boolean {
		const entity = this.entities.get(id);
		if (entity?.kind !== "body") return false;
		this.entities.set(id, { ...entity, materialId });
		return true;
	}

	ids(): DocumentId[] {
		return [...this.entities.keys()];
	}

	all(): DocEntity[] {
		return [...this.entities.values()];
	}

	clear(): void {
		this.entities.clear();
	}
}

/**
 * Deep copy of document entities (polygon point arrays are copied too), so
 * snapshots and restored state share no mutable aliases.
 */
export function cloneDocEntities(entities: readonly DocEntity[]): DocEntity[] {
	return entities.map((e) => {
		if (e.kind === "body" && e.shape.kind === "polygon") {
			return {
				...e,
				shape: { ...e.shape, points: e.shape.points.map((p) => ({ ...p })) },
			};
		}
		return { ...e };
	});
}
