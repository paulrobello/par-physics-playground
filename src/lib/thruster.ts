/**
 * Thruster document entity (P4-T5, PRD P4): an attachable force applicator.
 * Like a label it has no Rapier body of its own — it rides a body at a
 * BODY-LOCAL anchor and applies a continuous force at that point while `on`.
 * Direction is a body-local angle (radians, y-down world per world.ts:
 * 0 = +x/right, π/2 = +y/down), so a thruster mounted on a body rotates with
 * it. All state is document data: undo/redo and rebuild carry it exactly
 * (the motor precedent). Flat scalar fields keep cloneDocEntities' shallow
 * copy sufficient.
 */
import type { DocumentId } from "./world";

export interface ThrusterEntity {
	readonly kind: "thruster";
	readonly id: DocumentId;
	/** The simulated body the thruster is mounted on. */
	readonly bodyId: DocumentId;
	/** Mount point on the body, body-local (rotates with the body). */
	readonly anchorX: number;
	readonly anchorY: number;
	/** Thrust direction in the body's local frame, radians (0 = +x). */
	readonly angle: number;
	/** Continuous force magnitude while on (world force units). */
	readonly strength: number;
	/** On/off toggle; off applies no force (document data, rebuild-safe). */
	readonly on: boolean;
	/**
	 * Burn-time limit in seconds (Paul, 2026-10-25): the thruster stops
	 * applying force once it has thrusting-burned this long; undefined =
	 * unlimited (the pre-duration behavior). Two-decimal precision. The
	 * elapsed burn clock is SIM state, not document data — a saved scene
	 * replays the full burn on load, pause freezes it, and a duration edit
	 * restarts the countdown.
	 */
	readonly duration?: number | undefined;
}

/**
 * Default strength at placement (world force units). Sized for machine-scale
 * bodies (mass 10²–10³): it accelerates a unit-density r=8 ball (mass ≈ 201)
 * at ≈ 50 u/s² — five gravities, a visible kick — while a 10⁴-mass terrain
 * hunk barely notices. Editable in the panel; tests pin the exact semantics.
 */
export const THRUSTER_DEFAULT_STRENGTH = 10_000;

/** Upper bound for a burn duration (10 minutes of thrust). */
export const THRUSTER_MAX_DURATION = 600;

/**
 * Panel/scene normalization for a duration entry: non-finite, zero, or
 * negative clears the limit (undefined); otherwise round to 2 decimals and
 * clamp into [0.01, THRUSTER_MAX_DURATION].
 */
export function clampThrusterDuration(raw: number): number | undefined {
	if (!Number.isFinite(raw) || raw <= 0) return undefined;
	return Math.min(
		Math.max(Math.round(raw * 100) / 100, 0.01),
		THRUSTER_MAX_DURATION,
	);
}

/** World-space pose of a thruster: its anchor point and thrust direction. */
export interface ThrusterPose {
	readonly x: number;
	readonly y: number;
	readonly angle: number;
}

/**
 * A thruster's live world pose: the stored body-local anchor and angle
 * rotated/translated by the mounted body's CURRENT transform (the joint
 * anchor precedent). Undefined when the body is gone (culled mid-frame).
 */
export function thrusterWorldPose(
	entity: ThrusterEntity,
	transform: { x: number; y: number; rot: number } | undefined,
): ThrusterPose | undefined {
	if (!transform) return undefined;
	const cos = Math.cos(transform.rot);
	const sin = Math.sin(transform.rot);
	return {
		x: transform.x + entity.anchorX * cos - entity.anchorY * sin,
		y: transform.y + entity.anchorX * sin + entity.anchorY * cos,
		angle: transform.rot + entity.angle,
	};
}

/** Human-readable label (panel). */
export const THRUSTER_TYPE_LABEL = "Thruster";

/**
 * Drag-to-aim conversion (placement): a drag vector's WORLD angle becomes
 * the thruster's BODY-LOCAL angle by subtracting the mounted body's
 * placement rotation, wrapped into (−π, π]. A thruster placed by dragging
 * toward world-up on a rotated body keeps aiming world-up as the body
 * spins — the same convention as the panel's Angle field.
 */
export function aimAngleLocal(dx: number, dy: number, bodyRot: number): number {
	const world = Math.atan2(dy, dx);
	let local = world - bodyRot;
	while (local > Math.PI) local -= Math.PI * 2;
	while (local <= -Math.PI) local += Math.PI * 2;
	return local;
}

/** Minimum drag (world units) below which placement keeps angle 0. */
export const THRUSTER_AIM_MIN_DRAG = 4;
