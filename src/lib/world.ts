/**
 * Rapier2D world wrapper: static ground line at y=0, kill-threshold culling,
 * and the document-ID → Rapier body registry backed by the scene document
 * (src/lib/document.ts) — the registry maps document entities to live Rapier
 * bodies, and editing operations (move/rotate/remove/duplicate) mutate both.
 *
 * World convention (owned here since P1-T3, which first draws bodies): a
 * single y-down world. Positive world y is DOWN on screen — the same y-down
 * mapping the Camera already uses — so gravity is +y and bodies rest ABOVE
 * the ground line (negative y, at y = −halfHeight). The ground slab sits
 * below the line (y ∈ [0, 1]).
 */
import RAPIER from "@dimforge/rapier2d-compat";
import { SIM_DT_SECONDS } from "./clock";
import {
	type BodyEntity,
	type BodyShape,
	type DocEntity,
	defaultBody,
	type LabelEntity,
	type Material,
	SceneDocument,
} from "./document";
import { MATERIAL_DEFAULT_ID } from "./material";
import {
	cleanPolygon,
	completeDecomposition,
	polygonCentroid,
	polygonIsConvex,
	polygonIsSimple,
	triangulate,
	type Vec2,
} from "./triangulate";

/** Ground cuboid half-width: a "line" far beyond any scene the app can show. */
export const GROUND_HALF_EXTENT = 10_000;
/** Bodies whose centre falls past this y (y-down world: falls are +y) are removed. */
export const KILL_THRESHOLD_Y = 1_000;
/** Ground is a thin slab whose top surface sits at y=0. */
const GROUND_HALF_THICKNESS = 0.5;

/** Polygon vertices as the interleaved Float32Array Rapier's convexHull takes. */
function flatPoints(points: readonly Vec2[]): Float32Array {
	const flat = new Float32Array(points.length * 2);
	for (let i = 0; i < points.length; i++) {
		const p = points[i] as Vec2;
		flat[i * 2] = p.x;
		flat[i * 2 + 1] = p.y;
	}
	return flat;
}

/** y-down world: gravity accelerates toward positive y (down on screen). */
export const WORLD_GRAVITY: RAPIER.Vector = { x: 0, y: 9.81 };

/** Document IDs are strings throughout the app (canvas docs, later persistence). */
export type DocumentId = string;

/** Render shape of a registry body (re-exported from the document layer). */
export type { BodyShape } from "./document";

/**
 * Spring-drag tuning, per unit of dragged-body mass. Stiffness ω = √k/m = 20
 * rad/s and damping 2·m·ω (critical) — fast follow without oscillation.
 */
const MOUSE_JOINT_STIFFNESS_PER_MASS = 400;
const MOUSE_JOINT_DAMPING_PER_MASS = 40;

export class PhysicsWorld {
	readonly world: RAPIER.World;
	/** Serializable document: identity, geometry, transform per body. */
	readonly doc = new SceneDocument();
	/** Simulation view: document id → live Rapier body. */
	readonly bodies = new Map<DocumentId, RAPIER.RigidBody>();

	private groundBody: RAPIER.RigidBody | null = null;
	/** Notified on every setGravity (the slider sync in sim-controls). */
	private readonly gravityListeners = new Set<
		(vector: { x: number; y: number }) => void
	>();
	/**
	 * Invoked for every removed entity (delete, cull, reset, or replacement).
	 * Consumers holding per-body handles (e.g. the interaction layer's active
	 * drag joint) must drop them here: a culled body's joints are destroyed
	 * with it, so a retained joint handle is stale.
	 */
	onRemove: ((id: DocumentId) => void) | null = null;

	static async create(): Promise<PhysicsWorld> {
		await RAPIER.init();
		return new PhysicsWorld();
	}

	private constructor() {
		this.world = new RAPIER.World(WORLD_GRAVITY);
		// Physics must advance by exactly one tick's dt per step; never rely on
		// Rapier's 1/60 default coinciding with SIM_TICK_HZ.
		this.world.integrationParameters.dt = SIM_DT_SECONDS;
		this.groundBody = this.world.createRigidBody(
			RAPIER.RigidBodyDesc.fixed().setTranslation(0, 0),
		);
		// Slab below the line in the y-down world: y ∈ [0, 1], top surface y=0.
		this.world.createCollider(
			RAPIER.ColliderDesc.cuboid(
				GROUND_HALF_EXTENT,
				GROUND_HALF_THICKNESS,
			).setTranslation(0, GROUND_HALF_THICKNESS),
			this.groundBody,
		);
	}

	/**
	 * The live gravity vector (m/s², y-down world convention). Returns a COPY:
	 * a caller mutating the returned object would bypass {@link setGravity}
	 * and its sleeper wake, leaving gravity changed but bodies still asleep.
	 */
	get gravity(): RAPIER.Vector {
		return { x: this.world.gravity.x, y: this.world.gravity.y };
	}

	/**
	 * Apply a new gravity to the LIVE world: the change takes effect on the
	 * next tick, and every registry body is woken (a sleeping resting box must
	 * start falling immediately when gravity flips, not at its next wake).
	 * Notifies gravity listeners (sim-controls syncs its sliders from here).
	 */
	setGravity(x: number, y: number): void {
		this.world.gravity = { x, y };
		for (const body of this.bodies.values()) body.wakeUp();
		for (const listener of this.gravityListeners) listener({ x, y });
	}

	/**
	 * Subscribe to gravity changes (any setGravity caller, UI or debug API).
	 * Returns an unsubscribe function, mirroring TimeScale.subscribe.
	 */
	subscribeGravity(
		listener: (vector: { x: number; y: number }) => void,
	): () => void {
		this.gravityListeners.add(listener);
		return () => {
			this.gravityListeners.delete(listener);
		};
	}

	/**
	 * Create the Rapier simulation state for a document entity and register it.
	 * Replacing an existing id removes its old body first (spawn-overwrite is
	 * the P1 debug-API contract).
	 */
	spawnEntity(entity: BodyEntity): RAPIER.RigidBody {
		if (entity.shape.kind === "polygon") {
			const points = entity.shape.points;
			if (
				!polygonIsSimple(points) ||
				!completeDecomposition(points, triangulate(points))
			) {
				console.warn("[par-physics] Polygon rejected: invalid decomposition");
				throw new Error("polygon has no valid convex decomposition");
			}
		}
		const existing = this.bodies.get(entity.id);
		if (existing) this.removeBody(entity.id);
		const desc = entity.isStatic
			? RAPIER.RigidBodyDesc.fixed()
			: RAPIER.RigidBodyDesc.dynamic();
		const body = this.world.createRigidBody(
			desc.setTranslation(entity.x, entity.y),
		);
		body.setRotation(entity.rot, true);
		// The entity's materialId is authoritative: density/friction/restitution
		// all come from the document registry (ink fallback for unknown ids).
		this.attachShape(body, entity.shape, this.doc.material(entity.materialId));
		this.doc.add(entity);
		this.bodies.set(entity.id, body);
		return body;
	}

	/**
	 * Convex polygon → one convex-hull collider; concave → ear-clipping
	 * triangles, one collider each, all parented under the single body (Rapier
	 * supports multiple colliders per rigid body), so a concave polygon rests
	 * and collides as one rigid unit. Returns undefined for degenerate input
	 * (zero area after cleanup); the polygon tool commits only valid polygons.
	 */
	spawnPolygon(
		id: DocumentId,
		points: readonly Vec2[],
		isStatic = false,
		materialId: string = MATERIAL_DEFAULT_ID,
	): RAPIER.RigidBody | undefined {
		const cleaned = cleanPolygon(points);
		if (
			!cleaned ||
			!polygonIsSimple(cleaned) ||
			!completeDecomposition(cleaned, triangulate(cleaned))
		) {
			console.warn(
				"[par-physics] Polygon rejected: degenerate, self-intersecting, or incomplete decomposition",
			);
			return undefined;
		}
		const centroid = polygonCentroid(cleaned);
		const local = cleaned.map((p) => ({
			x: p.x - centroid.x,
			y: p.y - centroid.y,
		}));
		return this.spawnEntity({
			...defaultBody(
				id,
				{ kind: "polygon", points: local },
				centroid.x,
				centroid.y,
			),
			isStatic,
			materialId,
		});
	}

	/**
	 * Add a non-physical label to the document (no Rapier body — the renderer
	 * draws it and the picker hit-tests it). The text is set by
	 * {@link setLabelText} when the text tool's inline edit commits.
	 */
	addLabel(id: DocumentId, x: number, y: number): DocumentId {
		this.doc.add({
			kind: "label",
			id,
			x,
			y,
			rot: 0,
			text: "",
		} satisfies LabelEntity);
		return id;
	}

	setLabelText(id: DocumentId, text: string): void {
		this.doc.setLabelText(id, text);
	}

	/** The document's labels, in insertion order. */
	labels(): LabelEntity[] {
		const out: LabelEntity[] = [];
		for (const e of this.doc.all()) if (e.kind === "label") out.push(e);
		return out;
	}

	labelOf(id: DocumentId): LabelEntity | undefined {
		const e = this.doc.get(id);
		return e && e.kind === "label" ? e : undefined;
	}

	/** Offset copy of a label; returns the new id, or undefined if unknown. */
	duplicateLabel(
		id: DocumentId,
		newId: DocumentId,
		dx: number,
		dy: number,
	): DocumentId | undefined {
		const label = this.labelOf(id);
		if (!label) return undefined;
		this.doc.add({
			...label,
			id: newId,
			x: label.x + dx,
			y: label.y + dy,
		});
		return newId;
	}

	/** Create every collider a shape needs, materialized from `material`. */
	private attachShape(
		body: RAPIER.RigidBody,
		shape: BodyShape,
		material: Material,
	): void {
		if (shape.kind === "polygon") {
			if (polygonIsConvex(shape.points)) {
				this.world.createCollider(
					this.materialize(
						RAPIER.ColliderDesc.convexHull(flatPoints(shape.points)),
						material,
					),
					body,
				);
			} else {
				// Concave: one collider per triangulated part, all under the one
				// rigid body — the parts move and rest as a single rigid unit.
				for (const [a, b, c] of triangulate(shape.points)) {
					const pa = shape.points[a] as Vec2;
					const pb = shape.points[b] as Vec2;
					const pc = shape.points[c] as Vec2;
					this.world.createCollider(
						this.materialize(
							RAPIER.ColliderDesc.convexHull(
								new Float32Array([pa.x, pa.y, pb.x, pb.y, pc.x, pc.y]),
							),
							material,
						),
						body,
					);
				}
			}
			return;
		}
		const desc =
			shape.kind === "box"
				? RAPIER.ColliderDesc.cuboid(shape.halfWidth, shape.halfHeight)
				: RAPIER.ColliderDesc.ball(shape.radius);
		this.world.createCollider(this.materialize(desc, material), body);
	}

	/** Apply the entity's material to a collider descriptor (null-safe for hulls). */
	private materialize(
		desc: RAPIER.ColliderDesc | null,
		material: Material,
	): RAPIER.ColliderDesc {
		if (!desc) throw new Error("polygon has no valid convex decomposition");
		return desc
			.setDensity(material.density)
			.setFriction(material.friction)
			.setRestitution(material.restitution);
	}

	spawnBox(
		id: DocumentId,
		x: number,
		y: number,
		halfWidth: number,
		halfHeight: number,
		materialId: string = MATERIAL_DEFAULT_ID,
		isStatic = false,
	): RAPIER.RigidBody {
		return this.spawnEntity({
			...defaultBody(id, { kind: "box", halfWidth, halfHeight }, x, y),
			materialId,
			isStatic,
		});
	}

	spawnCircle(
		id: DocumentId,
		x: number,
		y: number,
		radius: number,
		isStatic = false,
		materialId: string = MATERIAL_DEFAULT_ID,
	): RAPIER.RigidBody {
		return this.spawnEntity({
			...defaultBody(id, { kind: "circle", radius }, x, y),
			materialId,
			isStatic,
		});
	}

	/**
	 * Re-materialize a body with `materialId` (apply-to-selection and the
	 * delete-fallback repaint in the material panel): the document entity's
	 * `materialId` updates in place and the EXISTING Rapier body's colliders
	 * take the new density/friction/restitution, with mass properties
	 * recomputed. No removal, no respawn: the body keeps its identity, so
	 * selection, live transform, velocity, and any joints attached to it (P4)
	 * all survive. False when the id is unknown or not a body. Callers wrap
	 * the batch in ONE undo action; the entity keeps `materialId` even when it
	 * no longer resolves (ink fallback). A shape-kind change is out of scope
	 * for this API — that would be an explicit replacement path.
	 */
	setBodyMaterial(id: DocumentId, materialId: string): boolean {
		const entity = this.doc.get(id);
		const body = this.bodies.get(id);
		if (entity?.kind !== "body" || !body) return false;
		this.doc.setBodyMaterial(id, materialId);
		const material = this.doc.material(materialId);
		for (let i = 0; i < body.numColliders(); i++) {
			const collider = body.collider(i);
			collider.setDensity(material.density);
			collider.setFriction(material.friction);
			collider.setRestitution(material.restitution);
		}
		body.recomputeMassPropertiesFromColliders();
		return true;
	}

	bodyPosition(id: DocumentId): RAPIER.Vector | undefined {
		return this.bodies.get(id)?.translation();
	}

	bodyRotation(id: DocumentId): number | undefined {
		return this.bodies.get(id)?.rotation();
	}

	shapeOf(id: DocumentId): BodyShape | undefined {
		const e = this.doc.get(id);
		return e?.kind === "body" ? e.shape : undefined;
	}

	/**
	 * Kinematic move: teleport a body (paused editing) or override its position
	 * mid-simulation. Wakes the body — a sleeping body would ignore the change.
	 */
	moveBody(id: DocumentId, x: number, y: number): void {
		const body = this.bodies.get(id);
		if (!body) return;
		body.setTranslation({ x, y }, true);
		this.doc.setTransform(id, x, y, body.rotation());
	}

	/**
	 * Kinematic rotate about the body's own centre. Wakes the body; works the
	 * same paused or running (a running dynamic body simply gets its rotation
	 * overridden for this instant).
	 */
	rotateBody(id: DocumentId, rot: number): void {
		const body = this.bodies.get(id);
		if (!body) return;
		body.setRotation(rot, true);
		const p = body.translation();
		this.doc.setTransform(id, p.x, p.y, rot);
	}

	/**
	 * Remove a body from the simulation and the document. Doc-only entities
	 * (labels, which have no Rapier body) are removed from the document.
	 */
	removeBody(id: DocumentId): void {
		const body = this.bodies.get(id);
		if (body) {
			this.world.removeRigidBody(body);
			this.bodies.delete(id);
		}
		this.doc.remove(id);
		this.onRemove?.(id);
	}

	/**
	 * Offset copy of a body in the document and simulation; returns the new id.
	 * The offset base is the LIVE transform, not the document's (the document
	 * only syncs on editing operations, so while the sim runs a body's doc
	 * transform is stale — duplicating a fallen body must copy from where it
	 * actually is).
	 */
	duplicateBody(
		id: DocumentId,
		newId: DocumentId,
		dx: number,
		dy: number,
	): DocumentId | undefined {
		const entity = this.doc.get(id);
		const body = this.bodies.get(id);
		if (entity?.kind !== "body" || !body) return undefined;
		const p = body.translation();
		this.spawnEntity({
			...entity,
			id: newId,
			x: p.x + dx,
			y: p.y + dy,
			rot: body.rotation(),
		});
		return newId;
	}

	/**
	 * Write every body's live translation/rotation into its document entity.
	 * The document only syncs on editing operations; a snapshot serializer
	 * (P2-T5 undo) must call this first so the document matches the sim state.
	 */
	syncLiveTransforms(): void {
		for (const [id, body] of this.bodies) {
			const p = body.translation();
			this.doc.setTransform(id, p.x, p.y, body.rotation());
		}
	}

	/**
	 * Destroy every body and rebuild the scene from a document snapshot
	 * (undo/redo restore). Entities are inserted in document order, so draw
	 * order and topmost-picking survive; the ground stays. Rapier state is
	 * destroyed and recreated — acceptable for a sandbox at this scale, and
	 * measured in the e2e.
	 */
	restoreSnapshot(entities: readonly DocEntity[]): void {
		this.reset();
		for (const entity of entities) {
			if (entity.kind === "body") {
				this.spawnEntity(entity);
			} else {
				this.doc.add(entity);
			}
		}
	}

	/**
	 * Attach a mouse-style spring between the fixed ground and `body`. The
	 * target (ground-local anchor — the ground never moves or rotates) is the
	 * current grab point; {@link moveMouseJointTarget} retargets it as the
	 * pointer moves. `grab` is the world-space point grabbed on the body.
	 */
	startMouseJoint(
		body: RAPIER.RigidBody,
		grab: RAPIER.Vector,
	): RAPIER.ImpulseJoint {
		const mass = body.mass();
		const jointData = RAPIER.JointData.spring(
			0,
			MOUSE_JOINT_STIFFNESS_PER_MASS * mass,
			MOUSE_JOINT_DAMPING_PER_MASS * mass,
			{ x: grab.x, y: grab.y }, // anchor1 on the fixed ground: ground-local = world
			this.worldToLocal(body, grab),
		);
		if (!this.groundBody) throw new Error("world not initialised");
		return this.world.createImpulseJoint(
			jointData,
			this.groundBody,
			body,
			true,
		);
	}

	/** Retarget the drag spring to a new world-space point. */
	moveMouseJointTarget(
		joint: RAPIER.ImpulseJoint,
		target: RAPIER.Vector,
	): void {
		joint.setAnchor1({ x: target.x, y: target.y });
		// Retargeting does not wake a sleeping body; an asleep body ignores the
		// spring and would hang frozen in mid-air while the target moves away.
		joint.body2().wakeUp();
	}

	/** Detach the drag spring and wake the released body so it falls. */
	endMouseJoint(joint: RAPIER.ImpulseJoint): void {
		joint.body2().wakeUp();
		this.world.removeImpulseJoint(joint, true);
	}

	private worldToLocal(
		body: RAPIER.RigidBody,
		worldPoint: RAPIER.Vector,
	): RAPIER.Vector {
		const pos = body.translation();
		const rot = body.rotation();
		const cos = Math.cos(rot);
		const sin = Math.sin(rot);
		const dx = worldPoint.x - pos.x;
		const dy = worldPoint.y - pos.y;
		return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
	}

	/** Remove every entity, including terrain and labels; the ground stays. */
	reset(): void {
		for (const id of this.doc.ids()) this.removeBody(id);
	}

	/** One fixed tick: advance physics, then cull bodies below the kill threshold. */
	step(): void {
		this.world.step();
		for (const [id, body] of this.bodies) {
			if (body.translation().y > KILL_THRESHOLD_Y) {
				this.removeBody(id);
			}
		}
	}
}
