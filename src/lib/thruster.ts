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
}

/**
 * Default strength at placement (world force units). Sized for machine-scale
 * bodies (mass 10²–10³): it accelerates a unit-density r=8 ball (mass ≈ 201)
 * at ≈ 50 u/s² — five gravities, a visible kick — while a 10⁴-mass terrain
 * hunk barely notices. Editable in the panel; tests pin the exact semantics.
 */
export const THRUSTER_DEFAULT_STRENGTH = 10_000;

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
