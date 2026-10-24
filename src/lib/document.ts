/**
 * Serializable scene document (PRD "Document model"): the scene is a document
 * of bodies whose simulation state the physics world rebuilds from it. Bodies
 * carry id, shape, transform, material ref, and the static flag; labels are
 * non-physical document entities (drawn + hit-tested, never simulated). Later
 * phases (undo snapshots in P2-T5) route through this API. Shape kinds are
 * open-ended; box, circle, and polygon are implemented.
 */

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

/** Material id all spawned bodies reference until custom materials exist. */
export const MATERIAL_DEFAULT_ID = "default";

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
