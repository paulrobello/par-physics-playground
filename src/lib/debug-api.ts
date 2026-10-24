/**
 * `?debug=1` inspection hooks: deterministic sim-time control and world probes
 * for browser tests. Installed only when debug mode is enabled.
 */
import type { Camera, CameraState } from "./camera";
import type { SimClock } from "./clock";
import type { DocumentId, PhysicsWorld } from "./world";

export interface DebugApi {
	/** Advance the simulation by `ms` of simulated time in fixed ticks, deterministically. */
	advanceTime(ms: number): void;
	/** Advance the simulation exactly one tick, ignoring pause. */
	stepOnce(): void;
	/** Drop a dynamic box (half extents `hx` × `hy`) at world position (x, y). */
	spawnBox(id: DocumentId, x: number, y: number, hx: number, hy: number): void;
	/** Drop a dynamic ball of radius `r` at world position (x, y). */
	spawnCircle(id: DocumentId, x: number, y: number, r: number): void;
	/** All registered body ids, in spawn order. */
	bodyIds(): DocumentId[];
	/** Current world position of a registered body, or undefined if culled. */
	bodyPosition(id: DocumentId): { x: number; y: number } | undefined;
	/** Current world linear velocity of a registered body, or undefined. */
	bodyLinvel(id: DocumentId): { x: number; y: number } | undefined;
	/** Whether a registered body is asleep. */
	bodyIsSleeping(id: DocumentId): boolean | undefined;
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
): DebugApi {
	const api: DebugApi = {
		advanceTime(ms) {
			clock.advanceSimTime(ms / 1000);
		},
		stepOnce() {
			clock.stepOnce();
		},
		spawnBox(id, x, y, hx, hy) {
			world.spawnBox(id, x, y, hx, hy);
		},
		spawnCircle(id, x, y, r) {
			world.spawnCircle(id, x, y, r);
		},
		bodyIds() {
			return [...world.bodies.keys()];
		},
		bodyPosition(id) {
			const p = world.bodyPosition(id);
			return p ? { x: p.x, y: p.y } : undefined;
		},
		bodyLinvel(id) {
			const v = world.bodies.get(id)?.linvel();
			return v ? { x: v.x, y: v.y } : undefined;
		},
		bodyIsSleeping(id) {
			return world.bodies.get(id)?.isSleeping();
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
