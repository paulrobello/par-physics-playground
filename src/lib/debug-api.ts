/**
 * `?debug=1` inspection hooks: deterministic sim-time control and world probes
 * for browser tests. Installed only when debug mode is enabled.
 */
import type { Camera, CameraState } from "./camera";
import type { SimClock } from "./clock";
import { buildDemoScene } from "./demo-scene";
import type { BodyShape, DocEntity } from "./document";
import type { RopeChainSpawned } from "./interaction";
import { placeRopeChain } from "./interaction";
import type { JointEntity, JointParams } from "./joint";
import { localPointToWorld, makeJoint, makePlacedJoint } from "./joint";
import type { Material } from "./material";
import { MATERIAL_DEFAULT_ID } from "./material";
import type { TimeScale } from "./sim-controls";
import type { ThrusterEntity } from "./thruster";
import { THRUSTER_DEFAULT_STRENGTH } from "./thruster";
import type { ToolSession } from "./tools";
import type { UndoStack } from "./undo";
import type { DocumentId, PhysicsWorld } from "./world";

export interface DebugApi {
	/** Advance the simulation by `ms` of simulated time in fixed ticks, deterministically. */
	advanceTime(ms: number): void;
	/** Advance the simulation exactly one tick, ignoring pause. */
	stepOnce(): void;
	/**
	 * Set the live world gravity (m/s², y-down convention): applies on the next
	 * tick; sleeping bodies wake immediately.
	 */
	setGravityVector(x: number, y: number): void;
	/** The live gravity vector (m/s²). */
	gravity(): { x: number; y: number };
	/** Set the accumulator feed-rate scale (clamped to 0.25×–2×). */
	setTimeScale(scale: number): void;
	/** The current accumulator feed-rate scale. */
	timeScale(): number;
	/**
	 * Drop a box (half extents `hx` × `hy`) at world position (x, y); optional
	 * material id (default ink) and static flag (terrain ramps for tests).
	 */
	spawnBox(
		id: DocumentId,
		x: number,
		y: number,
		hx: number,
		hy: number,
		materialId?: string,
		isStatic?: boolean,
	): void;
	/** Drop a ball of radius `r` at world position (x, y). */
	spawnCircle(
		id: DocumentId,
		x: number,
		y: number,
		r: number,
		isStatic?: boolean,
		materialId?: string,
	): void;
	/** All registered body ids, in spawn order. */
	bodyIds(): DocumentId[];
	/** Current world position of a registered body, or undefined if culled. */
	bodyPosition(id: DocumentId): { x: number; y: number } | undefined;
	/** Current world rotation of a registered body (radians), or undefined. */
	bodyRot(id: DocumentId): number | undefined;
	/** The document shape of a registered body (kind + geometry), or undefined. */
	bodyShape(id: DocumentId): BodyShape | undefined;
	/** Current world linear velocity of a registered body, or undefined. */
	bodyLinvel(id: DocumentId): { x: number; y: number } | undefined;
	/** Whether a registered body is asleep. */
	bodyIsSleeping(id: DocumentId): boolean | undefined;
	/** Whether a registered body is static (terrain). */
	bodyIsStatic(id: DocumentId): boolean | undefined;
	/** The registered body's resolved material, or undefined. */
	bodyMaterial(id: DocumentId): Material | undefined;
	/** Mass Rapier derived for a registered body, or undefined. */
	bodyMass(id: DocumentId): number | undefined;
	/** Whether a body is currently burning (runtime fire state; flammable.ts). */
	isBurning(id: DocumentId): boolean;
	/** All registered materials (palette + customs), registry order. */
	materials(): Material[];
	/** The material id new draw-tool spawns take (panel active material). */
	activeMaterialId(): string;
	/** All label ids, in document order. */
	labelIds(): DocumentId[];
	/** A label's position, rotation, and text, or undefined. */
	label(
		id: DocumentId,
	): { x: number; y: number; rot: number; text: string } | undefined;
	/** Undo one action; false when the undo stack is empty. */
	undo(): boolean;
	/** Redo one action; false when the redo stack is empty. */
	redo(): boolean;
	/** Undo/redo stack depths. */
	undoDepth(): { undo: number; redo: number };
	/** Currently selected body ids (live selection set of the tool session). */
	selectedIds(): DocumentId[];
	/**
	 * Place a pin (revolute) joint at world point (x, y) between two bodies,
	 * or between bodyA and the world when bodyBId is null. Same document path
	 * as the joint tool (makeJoint + world.spawnJoint); false when refused
	 * (missing body). The e2e/constraint assertions use it for deterministic
	 * placement without pointer synthesis.
	 */
	placePin(
		id: DocumentId,
		bodyAId: DocumentId,
		bodyBId: DocumentId | null,
		x: number,
		y: number,
	): boolean;
	/**
	 * Place any P4-T2/T3/T4 attached joint (pin/weld/rod/slider/motor/spring)
	 * from two world anchor points: `ax, ay` is the anchor on bodyA (the
	 * tool's arming click), `bx, by` the anchor on bodyB (or the world point
	 * when bodyBId is null). Rod length = |b − a|; slider axis =
	 * normalize(b − a) with the default limits; weld preserves the placement
	 * relative rotation; motor takes the default drive params, ON; spring
	 * rest length = |b − a| with the default stiffness/damping. Same document
	 * path as the joint tool (makePlacedJoint + spawnJoint); false when
	 * refused. Test-only path: it bypasses undo bookkeeping exactly like
	 * placePin.
	 */
	placeJoint(
		id: DocumentId,
		kind: "pin" | "weld" | "rod" | "slider" | "motor" | "spring",
		bodyAId: DocumentId,
		bodyBId: DocumentId | null,
		ax: number,
		ay: number,
		bx: number,
		by: number,
	): boolean;
	/**
	 * Spawn a rope chain (P4-T4) from stroke points: same path as the tool
	 * (placeRopeChain). An endpoint whose capture id is given captures to
	 * that body; an omitted capture id pins that end to the WORLD at the
	 * endpoint (matching the tool's empty-space semantics). Null when
	 * refused (D17 bounds — the rejection is surfaced visibly).
	 */
	spawnRope(
		points: readonly { x: number; y: number }[],
		captureA?: DocumentId,
		captureB?: DocumentId,
	): RopeChainSpawned | null;
	/** All joint ids, in document order. */
	jointIds(): DocumentId[];
	/** A joint's document entity (plain data), or undefined. */
	joint(id: DocumentId): JointEntity | undefined;
	/**
	 * Replace a joint's params (the panel-edit path, ONE-shot; the impulse
	 * joint is re-materialized from stored anchors). Test/e2e hook for motor
	 * drive params and the toggle. False when refused.
	 */
	setJointParams(id: DocumentId, params: JointParams): boolean;
	/**
	 * Mount a thruster (P4-T5) on `bodyId` with a BODY-LOCAL anchor (x, y),
	 * thrusting at `angleDeg` degrees (y-down screen convention). Same
	 * document path as the future tool placement will be; false when the body
	 * is missing.
	 */
	placeThruster(
		id: DocumentId,
		bodyId: DocumentId,
		x: number,
		y: number,
		angleDeg: number,
		strength?: number,
		on?: boolean,
	): boolean;
	/** Replace a thruster's mutable state (strength / on / duration). */
	setThrusterParams(
		id: DocumentId,
		patch: { strength?: number; on?: boolean; duration?: number | undefined },
	): boolean;
	/** All thruster ids, in document order. */
	thrusterIds(): DocumentId[];
	/** A thruster's document entity (plain data), or undefined. */
	thruster(id: DocumentId): ThrusterEntity | undefined;
	/** Live world pose (anchor point + thrust direction) of a thruster. */
	thrusterPose(
		id: DocumentId,
	): { x: number; y: number; angle: number } | undefined;
	/** Load the built-in demo scene (P4-T5) through the ordinary restore path. */
	loadDemo(): void;
	/**
	 * Live world positions of a joint's two anchor points — coincident while
	 * the revolute constraint holds (the e2e relative-pose assertion).
	 */
	jointAnchorWorld(
		id: DocumentId,
	):
		| { anchorA: { x: number; y: number }; anchorB: { x: number; y: number } }
		| undefined;
	/** Current tick count (advanceTime determinism check). */
	tick(): number;
	/** Live sim telemetry: tick, dropped sim seconds, body/joint counts. */
	simTelemetry(): {
		tick: number;
		droppedSeconds: number;
		bodies: number;
		joints: number;
		timeScale: number;
	};
	/** The whole document as plain entities (scene round-trip compares). */
	documentAll(): DocEntity[];
	/** Registered materials, predefined and custom. */
	customMaterials(): Material[];
	/** Register a custom material (scene fixtures); false on id collision. */
	addCustomMaterial(material: Material): boolean;
	/** Point a body at a different material; false when refused. */
	setBodyMaterial(id: DocumentId, materialId: string): boolean;
	/** World coordinates under a screen position (CSS pixels, canvas-relative). */
	screenToWorld(sx: number, sy: number): { x: number; y: number };
	/** Current camera pan/zoom state. */
	cameraState(): CameraState;
}

declare global {
	interface Window {
		__ppg?: DebugApi;
	}
}

export function installDebugApi(
	clock: SimClock,
	world: PhysicsWorld,
	camera: Camera,
	session: ToolSession,
	undo: UndoStack,
	activeMaterialId: () => string,
	timeScale: TimeScale,
): DebugApi {
	const api: DebugApi = {
		advanceTime(ms) {
			clock.advanceSimTime(ms / 1000);
		},
		stepOnce() {
			clock.stepOnce();
		},
		setGravityVector(x, y) {
			world.setGravity(x, y);
		},
		gravity() {
			const g = world.gravity;
			return { x: g.x, y: g.y };
		},
		setTimeScale(scale) {
			timeScale.set(scale);
		},
		timeScale: () => timeScale.value,
		spawnBox(id, x, y, hx, hy, materialId, isStatic) {
			world.spawnBox(id, x, y, hx, hy, materialId, isStatic);
		},
		spawnCircle(id, x, y, r, isStatic, materialId) {
			world.spawnCircle(id, x, y, r, isStatic, materialId);
		},
		bodyMaterial(id) {
			const e = world.doc.get(id);
			return e?.kind === "body" ? world.doc.material(e.materialId) : undefined;
		},
		bodyMass(id) {
			return world.bodies.get(id)?.mass();
		},
		isBurning(id) {
			return world.isBurning(id);
		},
		materials() {
			return world.doc.allMaterials();
		},
		activeMaterialId: () => activeMaterialId(),
		bodyIds() {
			return [...world.bodies.keys()];
		},
		bodyPosition(id) {
			const p = world.bodyPosition(id);
			return p ? { x: p.x, y: p.y } : undefined;
		},
		bodyRot(id) {
			return world.bodyRotation(id);
		},
		bodyShape(id) {
			return world.shapeOf(id);
		},
		bodyLinvel(id) {
			const v = world.bodies.get(id)?.linvel();
			return v ? { x: v.x, y: v.y } : undefined;
		},
		bodyIsSleeping(id) {
			return world.bodies.get(id)?.isSleeping();
		},
		bodyIsStatic(id) {
			const e = world.doc.get(id);
			return e?.kind === "body" ? e.isStatic : undefined;
		},
		labelIds() {
			return world.labels().map((label) => label.id);
		},
		label(id) {
			const label = world.labelOf(id);
			return label
				? { x: label.x, y: label.y, rot: label.rot, text: label.text }
				: undefined;
		},
		undo() {
			// Match the keyboard/toolbar path: an in-progress gesture (e.g. an
			// inline label edit) cancels first.
			session.cancel();
			return undo.undo();
		},
		redo() {
			session.cancel();
			return undo.redo();
		},
		undoDepth() {
			return undo.depths();
		},
		selectedIds() {
			return [...session.selectedIds];
		},
		placePin(id, bodyAId, bodyBId, x, y) {
			const a = world.bodies.get(bodyAId);
			const b = bodyBId ? world.bodies.get(bodyBId) : null;
			if (!a || (bodyBId && !b)) return false;
			return world.spawnJoint(
				makeJoint(
					id,
					{ kind: "pin" },
					bodyAId,
					bodyBId,
					{ x, y },
					{
						x: a.translation().x,
						y: a.translation().y,
						rot: a.rotation(),
					},
					b
						? {
								x: b.translation().x,
								y: b.translation().y,
								rot: b.rotation(),
							}
						: null,
				),
			);
		},
		jointIds() {
			return world.jointEntities().map((e) => e.id);
		},
		placeJoint(id, kind, bodyAId, bodyBId, ax, ay, bx, by) {
			const a = world.bodies.get(bodyAId);
			const b = bodyBId ? world.bodies.get(bodyBId) : null;
			if (!a || (bodyBId && !b)) return false;
			const entity = makePlacedJoint(
				id,
				kind,
				bodyAId,
				bodyBId,
				{ x: ax, y: ay },
				{ x: bx, y: by },
				{
					x: a.translation().x,
					y: a.translation().y,
					rot: a.rotation(),
				},
				b
					? {
							x: b.translation().x,
							y: b.translation().y,
							rot: b.rotation(),
						}
					: null,
			);
			return entity ? world.spawnJoint(entity) : false;
		},
		spawnRope(points, captureA, captureB) {
			return placeRopeChain(world, {
				points,
				captureA,
				captureB,
				materialId: MATERIAL_DEFAULT_ID,
			});
		},
		joint(id) {
			const e = world.doc.get(id);
			return e?.kind === "joint" ? e : undefined;
		},
		setJointParams(id, params) {
			return world.updateJointParams(id, params);
		},
		placeThruster(id, bodyId, x, y, angleDeg, strength, on) {
			return world.spawnThruster({
				kind: "thruster",
				id,
				bodyId,
				anchorX: x,
				anchorY: y,
				angle: (angleDeg * Math.PI) / 180,
				strength: strength ?? THRUSTER_DEFAULT_STRENGTH,
				on: on ?? true,
			});
		},
		setThrusterParams(id, patch) {
			return world.updateThruster(id, patch);
		},
		thrusterIds() {
			return world.thrusterEntities().map((t) => t.id);
		},
		thruster(id) {
			const e = world.doc.get(id);
			return e?.kind === "thruster" ? e : undefined;
		},
		thrusterPose(id) {
			const e = world.doc.get(id);
			return e?.kind === "thruster" ? world.thrusterPose(e) : undefined;
		},
		loadDemo() {
			world.restoreSnapshot(buildDemoScene());
		},
		jointAnchorWorld(id) {
			const e = world.doc.get(id);
			if (e?.kind !== "joint") return undefined;
			const a = world.jointWorldAnchor(e);
			if (!a) return undefined;
			// anchorB: bodyB-local → world; a null bodyB stores the world point.
			const bBody = e.bodyB ? world.bodies.get(e.bodyB) : undefined;
			if (e.bodyB !== null && !bBody) return undefined;
			const anchorB =
				e.bodyB === null || !bBody
					? { x: e.anchorB.x, y: e.anchorB.y }
					: localPointToWorld(
							e.anchorB.x,
							e.anchorB.y,
							bBody.translation().x,
							bBody.translation().y,
							bBody.rotation(),
						);
			return { anchorA: a, anchorB };
		},
		tick() {
			return clock.tick;
		},
		simTelemetry() {
			return {
				tick: clock.tick,
				droppedSeconds: clock.droppedSeconds,
				bodies: world.bodies.size,
				joints: world.doc.joints().length,
				timeScale: timeScale.value,
			};
		},
		documentAll() {
			return world.doc.all().map((e) => structuredClone(e));
		},
		customMaterials() {
			return world.doc.allMaterials().map((m) => ({ ...m }));
		},
		addCustomMaterial(material) {
			return world.doc.addMaterial({ ...material });
		},
		setBodyMaterial(id, materialId) {
			return world.setBodyMaterial(id, materialId);
		},
		screenToWorld(sx, sy) {
			const p = camera.screenToWorld(sx, sy);
			return { x: p.x, y: p.y };
		},
		cameraState() {
			return camera.state();
		},
	};
	window.__ppg = api;
	return api;
}
