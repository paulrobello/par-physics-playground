/**
 * Rapier2D world wrapper: static ground line at y=0, kill-threshold culling,
 * and the document-ID → Rapier body registry.
 *
 * World convention (owned here since P1-T3, which first draws bodies): a
 * single y-down world. Positive world y is DOWN on screen — the same y-down
 * mapping the Camera already uses — so gravity is +y and bodies rest ABOVE
 * the ground line (negative y, at y = −halfHeight). The ground slab sits
 * below the line (y ∈ [0, 1]).
 */
import RAPIER from "@dimforge/rapier2d-compat";
import { SIM_DT_SECONDS } from "./clock";
import { MATERIAL_DEFAULT } from "./material";

/** Ground cuboid half-width: a "line" far beyond any scene the app can show. */
export const GROUND_HALF_EXTENT = 10_000;
/** Bodies whose centre falls past this y (y-down world: falls are +y) are removed. */
export const KILL_THRESHOLD_Y = 1_000;
/** Ground is a thin slab whose top surface sits at y=0. */
const GROUND_HALF_THICKNESS = 0.5;

/** y-down world: gravity accelerates toward positive y (down on screen). */
export const WORLD_GRAVITY: RAPIER.Vector = { x: 0, y: 9.81 };

/** Document IDs are strings throughout the app (canvas docs, later persistence). */
export type DocumentId = string;

/** Render shape of a registry body, recorded at spawn for drawing and picking. */
export type BodyShape =
	| {
			readonly kind: "box";
			readonly halfWidth: number;
			readonly halfHeight: number;
	  }
	| { readonly kind: "circle"; readonly radius: number };

export interface SpawnBoxOptions {
	readonly restitution?: number;
}

/**
 * Spring-drag tuning, per unit of dragged-body mass. Stiffness ω = √k/m = 20
 * rad/s and damping 2·m·ω (critical) — fast follow without oscillation.
 */
const MOUSE_JOINT_STIFFNESS_PER_MASS = 400;
const MOUSE_JOINT_DAMPING_PER_MASS = 40;

export class PhysicsWorld {
	readonly world: RAPIER.World;
	readonly bodies = new Map<DocumentId, RAPIER.RigidBody>();
	readonly shapes = new Map<DocumentId, BodyShape>();

	private groundBody: RAPIER.RigidBody | null = null;
	/**
	 * Invoked for each body removed by kill-threshold culling in {@link step}.
	 * Consumers holding per-body handles (e.g. the interaction layer's active
	 * drag joint) must drop them here: a culled body's joints are destroyed
	 * with it, so a retained joint handle is stale.
	 */
	onCull: ((id: DocumentId) => void) | null = null;

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

	spawnBox(
		id: DocumentId,
		x: number,
		y: number,
		halfWidth: number,
		halfHeight: number,
		options: SpawnBoxOptions = {},
	): RAPIER.RigidBody {
		const existing = this.bodies.get(id);
		if (existing) this.world.removeRigidBody(existing);
		const body = this.world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y),
		);
		const collider = RAPIER.ColliderDesc.cuboid(halfWidth, halfHeight)
			.setDensity(MATERIAL_DEFAULT.density)
			.setFriction(MATERIAL_DEFAULT.friction)
			.setRestitution(options.restitution ?? MATERIAL_DEFAULT.restitution);
		this.world.createCollider(collider, body);
		this.bodies.set(id, body);
		this.shapes.set(id, { kind: "box", halfWidth, halfHeight });
		return body;
	}

	spawnCircle(
		id: DocumentId,
		x: number,
		y: number,
		radius: number,
	): RAPIER.RigidBody {
		const existing = this.bodies.get(id);
		if (existing) this.world.removeRigidBody(existing);
		const body = this.world.createRigidBody(
			RAPIER.RigidBodyDesc.dynamic().setTranslation(x, y),
		);
		this.world.createCollider(
			RAPIER.ColliderDesc.ball(radius)
				.setDensity(MATERIAL_DEFAULT.density)
				.setFriction(MATERIAL_DEFAULT.friction)
				.setRestitution(MATERIAL_DEFAULT.restitution),
			body,
		);
		this.bodies.set(id, body);
		this.shapes.set(id, { kind: "circle", radius });
		return body;
	}

	bodyPosition(id: DocumentId): RAPIER.Vector | undefined {
		return this.bodies.get(id)?.translation();
	}

	shapeOf(id: DocumentId): BodyShape | undefined {
		return this.shapes.get(id);
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

	/** Remove every dynamic body and its recorded shape; the ground stays. */
	reset(): void {
		for (const body of this.bodies.values()) this.world.removeRigidBody(body);
		this.bodies.clear();
		this.shapes.clear();
	}

	/** One fixed tick: advance physics, then cull bodies below the kill threshold. */
	step(): void {
		this.world.step();
		for (const [id, body] of this.bodies) {
			if (body.translation().y > KILL_THRESHOLD_Y) {
				this.world.removeRigidBody(body);
				this.bodies.delete(id);
				this.shapes.delete(id);
				this.onCull?.(id);
			}
		}
	}
}
