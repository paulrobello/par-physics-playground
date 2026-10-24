/**
 * `?debug=1` inspection hooks: deterministic sim-time control and world probes
 * for browser tests. Installed only when debug mode is enabled.
 */
import type { Camera, CameraState } from "./camera";
import type { SimClock } from "./clock";
import type { BodyShape } from "./document";
import type { Material } from "./material";
import type { TimeScale } from "./sim-controls";
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
	/** Current tick count (advanceTime determinism check). */
	tick(): number;
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
		tick() {
			return clock.tick;
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
