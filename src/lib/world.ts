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
import { fragmentEntities, shouldShatter } from "./brittle";
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
import {
	type JointEntity,
	type JointParams,
	localPointToWorld,
	MOTOR_VELOCITY_FACTOR,
	ROD_DAMPING_PER_MASS,
	ROD_STIFFNESS_PER_MASS,
	ROPE_LINK_DAMPING_PER_MASS,
	ROPE_LINK_STIFFNESS_PER_MASS,
} from "./joint";
import { MATERIAL_DEFAULT_ID } from "./material";
import { type ThrusterEntity, thrusterWorldPose } from "./thruster";
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

/**
 * The effective mass a rod's stiff spring must hold: the smaller dynamic mass
 * of the pair (a fixed/ground endpoint contributes no load mass). Static-
 * static rods are degenerate; 1 keeps the force-based constants finite.
 */
function rodEffectiveMass(
	a: RAPIER.RigidBody,
	b: RAPIER.RigidBody | null | undefined,
): number {
	const massA = a.isFixed() ? Number.POSITIVE_INFINITY : a.mass();
	const massB = !b || b.isFixed() ? Number.POSITIVE_INFINITY : b.mass();
	const mass = Math.min(massA, massB);
	return Number.isFinite(mass) ? mass : 1;
}

let nextFragmentId = 1;

/** Fallback fragment-id minter when no external one is wired (tests). */
function mintFragmentId(): DocumentId {
	return `brittle-frag-${nextFragmentId++}`;
}

export class PhysicsWorld {
	readonly world: RAPIER.World;
	/** Serializable document: identity, geometry, transform per body. */
	readonly doc = new SceneDocument();
	/** Simulation view: document id → live Rapier body. */
	readonly bodies = new Map<DocumentId, RAPIER.RigidBody>();
	/** Simulation view: document id → live Rapier impulse joint. */
	readonly joints = new Map<DocumentId, RAPIER.ImpulseJoint>();

	private groundBody: RAPIER.RigidBody | null = null;
	/**
	 * Contact-force events (brittle shatter, see brittle.ts): step() fills the
	 * queue (autoDrain=false) and drains it immediately after, so the manual
	 * drain always sees exactly this tick's events.
	 */
	private readonly contactEvents = new RAPIER.EventQueue(false);
	/** Armed (brittle) collider handles → owning body id (impact lookup). */
	private readonly brittleColliders = new Map<number, DocumentId>();
	/**
	 * Mints shatter-fragment ids. main.ts wires freshBodyId so fragments share
	 * the body-id space and the scene-file id-counter sync covers restored
	 * fragments; unset (unit tests), a local brittle-frag-N counter stands in.
	 */
	fragmentIdMinter: (() => DocumentId) | null = null;
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
		const material = this.doc.material(entity.materialId);
		this.attachShape(body, entity.shape, material);
		this.armColliders(entity.id, body, material.brittle === true);
		this.doc.add(entity);
		this.bodies.set(entity.id, body);
		return body;
	}

	/**
	 * Create the simulation state for a thruster (P4-T5): a doc-only entity
	 * (no Rapier body — the label precedent) mounted on an EXISTING simulated
	 * body. False when the body is missing.
	 */
	spawnThruster(entity: ThrusterEntity): boolean {
		if (!this.bodies.has(entity.bodyId)) {
			console.warn(
				`[par-physics] Thruster ${entity.id} rejected: body ${entity.bodyId} missing`,
			);
			return false;
		}
		this.doc.add(entity);
		return true;
	}

	/**
	 * Patch a thruster's mutable state (panel edits, the glyph toggle): the
	 * force is read live from the document each tick, so no re-materialization
	 * is needed — the document replacement IS the update. False when unknown
	 * or not a thruster. Undo covers it through the ordinary snapshot boundary.
	 */
	updateThruster(
		id: DocumentId,
		patch: Partial<Omit<ThrusterEntity, "kind" | "id" | "bodyId">>,
	): boolean {
		return this.doc.updateThruster(id, patch);
	}

	/** Thruster entities mounted on body `id` (the removal cascade set). */
	thrustersAttachedTo(id: DocumentId): ThrusterEntity[] {
		return this.doc.thrusters().filter((t) => t.bodyId === id);
	}

	/** The document's thrusters, in insertion order. */
	thrusterEntities(): ThrusterEntity[] {
		return this.doc.thrusters();
	}

	/** Zero-allocation thruster iteration (the render path's per-frame walk). */
	eachThrusterEntity(fn: (thruster: ThrusterEntity) => void): void {
		this.doc.eachThruster(fn);
	}

	/** Live world pose of a thruster's mount point and thrust direction. */
	thrusterPose(
		entity: ThrusterEntity,
	): { x: number; y: number; angle: number } | undefined {
		return thrusterWorldPose(entity, this.transformOf(entity.bodyId));
	}

	/** Live transform of a registered body (position + rotation), or undefined. */
	transformOf(
		id: DocumentId,
	): { x: number; y: number; rot: number } | undefined {
		const body = this.bodies.get(id);
		if (!body) return undefined;
		return {
			x: body.translation().x,
			y: body.translation().y,
			rot: body.rotation(),
		};
	}

	/**
	 * Apply every ON thruster's continuous force at its mount point (called
	 * from step() BEFORE the Rapier tick, so the impulse is integrated this
	 * tick). impulse = strength·dt at the world anchor — an off-center anchor
	 * also torques the body (a mounted rocket turns it). Wakes the body: a
	 * sleeping body would ignore the impulse.
	 */
	private applyThrusters(): void {
		for (const thruster of this.doc.thrusters()) {
			if (!thruster.on) continue;
			const body = this.bodies.get(thruster.bodyId);
			if (!body) continue;
			const pose = this.thrusterPose(thruster);
			if (!pose) continue;
			const impulse = thruster.strength * SIM_DT_SECONDS;
			body.applyImpulseAtPoint(
				{
					x: Math.cos(pose.angle) * impulse,
					y: Math.sin(pose.angle) * impulse,
				},
				{ x: pose.x, y: pose.y },
				true,
			);
		}
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

	/**
	 * Create a joint from a document entity: resolve both endpoints (null
	 * bodyB = the fixed ground body — pin-to-world), build the Rapier joint
	 * from the stored body-local anchors, register it. The same path serves
	 * placement AND rebuild-from-snapshot (undo/save depend on it; Ruling 22
	 * rebuild is bodies-BEFORE-joints, which restoreSnapshot enforces).
	 * False when an endpoint body is missing (a rebuild-order bug — callers
	 * surface it) or the params kind has no creation branch (every phase-4
	 * type now materializes; the branch is a loud rebuild-refusal guard).
	 */
	spawnJoint(entity: JointEntity): boolean {
		const bodyA = this.bodies.get(entity.bodyA);
		if (!bodyA) {
			console.warn(
				`[par-physics] Joint ${entity.id} rejected: body ${entity.bodyA} missing`,
			);
			return false;
		}
		const bodyB =
			entity.bodyB === null ? this.groundBody : this.bodies.get(entity.bodyB);
		if (entity.bodyB !== null && !bodyB) {
			console.warn(
				`[par-physics] Joint ${entity.id} rejected: body ${entity.bodyB} missing`,
			);
			return false;
		}
		let data: RAPIER.JointData;
		// Narrowed kind for the loud-refusal message below: the switch covers
		// every params kind, so inside `default` the discriminant is `never`.
		const kindName: string = entity.params.kind;
		// Switch on params.kind (=== jointType by the makeJoint invariant)
		// so each branch sees its narrowed params record.
		switch (entity.params.kind) {
			case "pin":
			case "motor":
				// Motor (P4-T3) = the pin's revolute; the motor is configured on
				// the CREATED impulse joint below (0.21: configureMotorVelocity /
				// setMotorMaxForce live on UnitImpulseJoint, not JointData).
				data = RAPIER.JointData.revolute(
					{ x: entity.anchorA.x, y: entity.anchorA.y },
					{ x: entity.anchorB.x, y: entity.anchorB.y },
				);
				break;
			case "weld":
				// Fixed joint preserving the placement relative rotation:
				// Rapier enforces θA + frame1 = θB + frame2, so frame2 = 0 and
				// frame1 = relRot keeps the placed pose exactly (no snap).
				data = RAPIER.JointData.fixed(
					{ x: entity.anchorA.x, y: entity.anchorA.y },
					entity.params.relRot,
					{ x: entity.anchorB.x, y: entity.anchorB.y },
					0,
				);
				break;
			case "rod": {
				// Stiff spring, mass-scaled (see ROD_*_PER_MASS in joint.ts):
				// holds the anchor distance in BOTH directions, unlike the rope
				// joint, which the 0.21 bindings limit to max-distance-only.
				data = RAPIER.JointData.spring(
					entity.params.length,
					rodEffectiveMass(bodyA, bodyB) * ROD_STIFFNESS_PER_MASS,
					rodEffectiveMass(bodyA, bodyB) * ROD_DAMPING_PER_MASS,
					{ x: entity.anchorA.x, y: entity.anchorA.y },
					{ x: entity.anchorB.x, y: entity.anchorB.y },
				);
				break;
			}
			case "spring": {
				// Rapier spring joint, per-mass constants (the rod precedent —
				// the spring motor is force-based; per-mass keeps ω = √stiffness
				// and the period mass-independent, see the params docs in
				// joint.ts). Pulls AND pushes around `restLength`.
				const m = rodEffectiveMass(bodyA, bodyB);
				data = RAPIER.JointData.spring(
					entity.params.restLength,
					m * entity.params.stiffness,
					m * entity.params.damping,
					{ x: entity.anchorA.x, y: entity.anchorA.y },
					{ x: entity.anchorB.x, y: entity.anchorB.y },
				);
				break;
			}
			case "rope": {
				// Rope link (P4-T4): materialized as a stiff mass-scaled spring
				// (ROPE_LINK_* constants) rather than JointData.rope — MEASURED
				// in 0.21: the rope joint is a soft max-distance limit that
				// leaks under sustained end load (a bridge's loaded end links
				// settled at ~1.5× their placed length; a torn end hit 3.5×),
				// while the stiff spring holds distance. A hanging or bridging
				// chain is in pure tension, so the spring's push direction
				// costs nothing physically.
				const m = rodEffectiveMass(bodyA, bodyB);
				data = RAPIER.JointData.spring(
					entity.params.length,
					m * ROPE_LINK_STIFFNESS_PER_MASS,
					m * ROPE_LINK_DAMPING_PER_MASS,
					{ x: entity.anchorA.x, y: entity.anchorA.y },
					{ x: entity.anchorB.x, y: entity.anchorB.y },
				);
				break;
			}
			case "slider": {
				// Prismatic with limits at JointData level (0.21 exposes
				// limitsEnabled/limits and intoRaw passes them to the wasm).
				data = RAPIER.JointData.prismatic(
					{ x: entity.anchorA.x, y: entity.anchorA.y },
					{ x: entity.anchorB.x, y: entity.anchorB.y },
					{ x: entity.params.axisX, y: entity.params.axisY },
				);
				data.limitsEnabled = true;
				data.limits = [entity.params.min, entity.params.max];
				break;
			}
			default:
				// Rebuild-refusal rule (P4-T2): a refused joint is NOT added to
				// the document (the placement path depends on clean refusal),
				// so a rebuild over a not-yet-materializable type would drop it.
				// That is made LOUD here (console.error, not warn) so no entity
				// is silently eaten; once every phase type is materialized the
				// branch is unreachable in practice.
				console.error(
					`[par-physics] Joint ${entity.id}: type "${kindName}" has no materialization branch — rebuild would drop this joint`,
				);
				return false;
		}
		if (!bodyB) throw new Error("world not initialised");
		const joint = this.world.createImpulseJoint(data, bodyA, bodyB, true);
		if (entity.params.kind === "motor" && entity.params.on) {
			// Powered revolute (0.21): the motor lives on the CREATED impulse
			// joint. AccelerationBased keeps the drive mass-independent (a
			// heavier wheel still tracks targetVelocity); setMotorMaxForce caps
			// the drive torque in world force units — a load demanding more
			// than maxTorque stalls the motor (pinned in
			// tests/unit/joint-motor.test.ts). The NEGATED target is measured,
			// not assumed: the 0.21 wasm drives ω(bodyB) − ω(bodyA) to the
			// configured velocity, so negating makes positive targetVelocity
			// spin bodyA forward (exact when bodyB is static or the world).
			const revolute = joint as RAPIER.RevoluteImpulseJoint;
			revolute.configureMotorModel(RAPIER.MotorModel.AccelerationBased);
			revolute.setMotorMaxForce(entity.params.maxTorque);
			revolute.configureMotorVelocity(
				-entity.params.targetVelocity,
				MOTOR_VELOCITY_FACTOR,
			);
		}
		// Rail/axle/link semantics: a slider's rider overlaps its rail, a
		// motorized wheel overlaps its mount, rope links' neighbors touch, and
		// a rope capture pin's bead sits half inside its target — contacts
		// between the jointed pair are off in all four cases; the constraint
		// does the constraining, not contact resolution (the measured Rapier
		// quirk from P4-T2/T3, extended to the rope in P4-T4).
		const contactsOff =
			entity.params.kind === "slider" ||
			entity.params.kind === "motor" ||
			entity.params.kind === "rope" ||
			(entity.params.kind === "pin" && entity.params.contactsOff === true);
		if (contactsOff) joint.setContactsEnabled(false);
		this.doc.add(entity);
		this.joints.set(entity.id, joint);
		return true;
	}

	/** The document's joint entities, in insertion order. */
	jointEntities(): JointEntity[] {
		return this.doc.joints();
	}

	/** Zero-allocation joint-entity iteration (the render path's per-frame walk). */
	eachJointEntity(fn: (joint: JointEntity) => void): void {
		this.doc.eachJoint(fn);
	}

	/**
	 * Replace a joint's params and re-materialize its Rapier impulse joint
	 * from the stored anchors (the panel's per-type controls — rod length,
	 * slider limits). Undo covers it through the ordinary document snapshot
	 * boundary: the entity carries the new params, so restoreSnapshot rebuilds
	 * with them. False when the id is unknown or not a joint; a rebuild
	 * refusal (endpoint missing) leaves the entity in the document without a
	 * live joint and logs loud per the rebuild-refusal rule in spawnJoint.
	 */
	updateJointParams(id: DocumentId, params: JointParams): boolean {
		const entity = this.doc.get(id);
		if (entity?.kind !== "joint") return false;
		const joint = this.joints.get(id);
		if (joint) {
			this.world.removeImpulseJoint(joint, true);
			this.joints.delete(id);
		}
		const updated: JointEntity = { ...entity, jointType: params.kind, params };
		this.doc.add(updated);
		return this.spawnJoint(updated);
	}

	/**
	 * Destroy a joint: Rapier impulse joint, registry entry, document entity.
	 * Fires the removal notification for the joint id so selection/UI drop it.
	 */
	removeJoint(id: DocumentId): void {
		const joint = this.joints.get(id);
		if (joint) {
			this.world.removeImpulseJoint(joint, true);
			this.joints.delete(id);
		}
		this.doc.remove(id);
		this.onRemove?.(id);
	}

	/** Joint ids whose endpoints include `id` (the removal cascade set). */
	jointsAttachedTo(id: DocumentId): DocumentId[] {
		const attached: DocumentId[] = [];
		for (const e of this.doc.joints()) {
			if (e.bodyA === id || e.bodyB === id) attached.push(e.id);
		}
		return attached;
	}

	/**
	 * Live world position of a joint's anchor (glyph drawing, picking, panel):
	 * the stored body-local anchor rotated/translated by bodyA's CURRENT
	 * transform, so the marker follows the pinned body while the sim runs.
	 */
	jointWorldAnchor(entity: JointEntity): { x: number; y: number } | undefined {
		const body = this.bodies.get(entity.bodyA);
		if (!body) return undefined;
		return localPointToWorld(
			entity.anchorA.x,
			entity.anchorA.y,
			body.translation().x,
			body.translation().y,
			body.rotation(),
		);
	}

	/**
	 * Both anchors' live world positions (the renderer's between-anchors
	 * drawing for springs and rope links, P4-T4). `b` is the stored world
	 * point when bodyB is null (world anchor — the ground never moves).
	 */
	jointWorldAnchors(
		entity: JointEntity,
	): { a: { x: number; y: number }; b: { x: number; y: number } } | undefined {
		const a = this.jointWorldAnchor(entity);
		if (!a) return undefined;
		const bBody = entity.bodyB ? this.bodies.get(entity.bodyB) : undefined;
		if (entity.bodyB !== null && !bBody) return undefined;
		const b =
			entity.bodyB === null || !bBody
				? { x: entity.anchorB.x, y: entity.anchorB.y }
				: localPointToWorld(
						entity.anchorB.x,
						entity.anchorB.y,
						bBody.translation().x,
						bBody.translation().y,
						bBody.rotation(),
					);
		return { a, b };
	}

	/** The document's labels, in insertion order. */
	labels(): LabelEntity[] {
		const out: LabelEntity[] = [];
		for (const e of this.doc.all()) if (e.kind === "label") out.push(e);
		return out;
	}

	/** Zero-allocation label iteration (the render path's per-frame walk). */
	eachLabel(fn: (label: LabelEntity) => void): void {
		this.doc.eachLabel(fn);
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
		desc
			.setDensity(material.density)
			.setFriction(material.friction)
			.setRestitution(material.restitution);
		if (material.brittle) {
			desc.setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS);
		}
		return desc;
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
		const armed = material.brittle === true;
		for (let i = 0; i < body.numColliders(); i++) {
			const collider = body.collider(i);
			collider.setDensity(material.density);
			collider.setFriction(material.friction);
			collider.setRestitution(material.restitution);
			collider.setActiveEvents(
				armed
					? RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS
					: RAPIER.ActiveEvents.NONE,
			);
		}
		this.armColliders(id, body, armed);
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
		// Removal cascade (Ruling 22): deleting any body removes its joints
		// first — Rapier destroys the impulse joints with the body, so the
		// registry entries must go with them (no orphans). Joint ids fire the
		// removal notification too, dropping selection/UI references.
		for (const jointId of this.jointsAttachedTo(id)) this.removeJoint(jointId);
		// Thrusters (P4-T5) mounted on the body die with it the same way — no
		// orphan force applicators pointing at a removed body.
		for (const thruster of this.thrustersAttachedTo(id)) {
			this.doc.remove(thruster.id);
			this.onRemove?.(thruster.id);
		}
		const body = this.bodies.get(id);
		if (body) {
			this.disarmColliders(body);
			this.world.removeRigidBody(body);
			this.bodies.delete(id);
			this.doc.remove(id);
			this.onRemove?.(id);
			return;
		}
		// Doc-only entities (labels) are removed from the document; a joint id
		// reaching removeBody directly delegates to removeJoint.
		const entity = this.doc.get(id);
		if (entity?.kind === "joint") {
			this.removeJoint(id);
			return;
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
		// Bodies and labels reinsert in SNAPSHOT order (draw order and
		// topmost-picking survive); joints spawn AFTER every body exists
		// (Ruling 22: bodies BEFORE joints — a joint's Rapier creation needs
		// both endpoint bodies in the registry).
		for (const entity of entities) {
			if (entity.kind === "body") this.spawnEntity(entity);
			else if (entity.kind === "label") this.doc.add(entity);
			else if (entity.kind === "thruster") this.doc.add(entity);
		}
		for (const entity of entities) {
			if (entity.kind === "joint") this.spawnJoint(entity);
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
		// Iterate BODY/LABEL ids only: every joint dies in removeBody's cascade
		// when its bodyA (always a body) is removed — iterating joint ids here
		// would double-remove and re-fire notifications.
		for (const id of this.doc.ids()) {
			const e = this.doc.get(id);
			if (e && e.kind !== "joint") this.removeBody(id);
		}
	}

	/**
	 * Track (or drop) a body's collider handles in the brittle-impact lookup.
	 * Only brittle-armed colliders are tracked, so worlds without brittle
	 * bodies skip the per-tick drain path entirely (no allocation on the hot
	 * path).
	 */
	private armColliders(
		id: DocumentId,
		body: RAPIER.RigidBody,
		armed: boolean,
	): void {
		for (let i = 0; i < body.numColliders(); i++) {
			const collider = body.collider(i);
			if (!collider) continue;
			if (armed) this.brittleColliders.set(collider.handle, id);
			else this.brittleColliders.delete(collider.handle);
		}
	}

	/** Drop every one of a body's collider handles (removal, any arm state). */
	private disarmColliders(body: RAPIER.RigidBody): void {
		for (let i = 0; i < body.numColliders(); i++) {
			const collider = body.collider(i);
			if (collider) this.brittleColliders.delete(collider.handle);
		}
	}

	/**
	 * Brittle shatter (see brittle.ts): drain the tick's contact-force events
	 * and replace every qualifying dynamic brittle body with same-material
	 * fragments. Candidates are collected across all events first (one body
	 * hit through several manifolds shatters once), and mutations happen only
	 * after the drain — the callback runs inside the Rapier event iteration.
	 */
	private processBrittleImpacts(): void {
		const gravity =
			Math.abs(this.world.gravity.x) + Math.abs(this.world.gravity.y);
		const shattered = new Set<DocumentId>();
		this.contactEvents.drainContactForceEvents((event) => {
			const force = event.totalForceMagnitude();
			for (const handle of [event.collider1(), event.collider2()]) {
				const id = this.brittleColliders.get(handle);
				if (id === undefined || shattered.has(id)) continue;
				const body = this.bodies.get(id);
				const entity = this.doc.get(id);
				if (!body || entity?.kind !== "body") continue;
				if (
					shouldShatter({
						shape: entity.shape,
						brittle: this.doc.material(entity.materialId).brittle === true,
						isStatic: body.isFixed(),
						mass: body.mass(),
						impactForce: force,
						gravity,
					})
				) {
					shattered.add(id);
				}
			}
		});
		for (const id of shattered) this.shatterBody(id);
	}

	/**
	 * Replace one brittle body with its fragments at its LIVE pose through the
	 * ordinary document paths (removeBody cascade, spawnEntity), so selection,
	 * joints, and undo snapshots all converge. A SIM event: NO undo boundary
	 * here — the next user action's snapshot absorbs the shatter (the
	 * rotate-fling precedent in interaction.ts).
	 */
	private shatterBody(id: DocumentId): void {
		const entity = this.doc.get(id);
		const body = this.bodies.get(id);
		if (entity?.kind !== "body" || !body) return;
		const live = {
			x: body.translation().x,
			y: body.translation().y,
			rot: body.rotation(),
		};
		const fragments = fragmentEntities(
			this.fragmentIdMinter ?? mintFragmentId,
			entity,
			live,
		);
		this.removeBody(id);
		for (const fragment of fragments) this.spawnEntity(fragment);
	}

	/** One fixed tick: advance physics, then cull bodies below the kill threshold. */
	step(): void {
		this.applyThrusters();
		this.world.step(this.contactEvents);
		if (this.brittleColliders.size > 0) this.processBrittleImpacts();
		for (const [id, body] of this.bodies) {
			if (body.translation().y > KILL_THRESHOLD_Y) {
				this.removeBody(id);
			}
		}
	}
}
