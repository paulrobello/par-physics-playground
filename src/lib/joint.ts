/**
 * Joint document entities (P4-T1): joints are document entities in the same
 * id namespace as bodies and labels (Controller Ruling 22), so undo snapshots,
 * save/load, and rebuild all route through the document layer. Anchors are
 * stored in BODY-LOCAL coordinates for jointed bodies (a pinned box carries
 * its pivot through moves and rotations); when `bodyB` is null the joint is
 * anchored to the world and `anchorB` holds WORLD coordinates (the ground
 * never moves, so world = ground-local).
 *
 * Rapier 0.21 compat mapping (phase-4 plan preamble): pin = revolute; motor =
 * revolute with configured motor (P4-T3); slider = prismatic with limits
 * (P4-T2); rod = stiff spring, NOT rope — the 0.21 bindings' rope joint is a
 * max-distance-only constraint (raw creation takes just `length`, no limits),
 * so it cannot hold min=max; a stiff spring holds both directions (see the
 * ROD_* constants); spring = Rapier spring joint with per-mass stiffness/
 * damping (P4-T4); weld = fixed (P4-T2); rope = segment chain of small bodies
 * + rope-kind links (P4-T4, src/lib/rope.ts — links materialize as stiff
 * springs, see ROPE_LINK_* in this file). `JointParams` is a
 * discriminated union keyed by `kind`; adding a type means one new param
 * record, one `spawnJoint` branch, one glyph — the document/rebuild/removal
 * machinery below is type-agnostic.
 */
import type RAPIER from "@dimforge/rapier2d-compat";
import type { Vec2 } from "./triangulate";
import type { DocumentId } from "./world";

/** Implemented and planned joint types (PRD D7). Rope is a chain, not a joint. */
export type JointType =
	| "pin"
	| "motor"
	| "slider"
	| "rod"
	| "spring"
	| "weld"
	| "rope"
	| "pulley";

/**
 * Per-type parameters, discriminated on `kind` (matches the entity's
 * `jointType` by construction — see {@link makeJoint}). T1 materialized
 * pin; T2 weld/rod/slider; T3 motor.
 */
export type JointParams =
	| {
			readonly kind: "pin";
			/**
			 * Contacts-off marker for ROPE CAPTURE pins (P4-T4): the captured
			 * end segment usually sits half inside its capture target, so the
			 * bead/target contact pair is disabled — the pin does the holding.
			 * Ordinary tool-placed pins leave it unset (contacts on).
			 */
			readonly contactsOff?: boolean;
	  }
	| {
			readonly kind: "weld";
			/**
			 * Relative rotation the weld preserves (rotB − rotA at placement,
			 * radians). Rapier's fixed joint enforces θA + frame1 = θB + frame2;
			 * with frame2 = 0, frame1 = this keeps the placement pose instead of
			 * snapping both bodies to equal angles.
			 */
			readonly relRot: number;
	  }
	| {
			readonly kind: "slider";
			/**
			 * Slide axis in bodyA-local coordinates (rotates with bodyA, like the
			 * anchors). Rapier takes the prismatic axis in BOTH bodies' local
			 * frames, so body-to-body sliders require the two bodies' local axes
			 * to agree — true at placement (both anchors derive from one world
			 * point and the relative pose is as placed) and for the dominant
			 * static-rail case.
			 */
			readonly axisX: number;
			readonly axisY: number;
			/** Translation limits along the axis; 0 = the placement configuration. */
			readonly min: number;
			readonly max: number;
	  }
	| {
			readonly kind: "motor";
			/**
			 * Drive speed, rad/s. Sign semantics (pinned by
			 * tests/unit/joint-motor.test.ts): positive spins bodyA FORWARD —
			 * increasing `rotation()` — relative to bodyB, exact when bodyB is
			 * static or the world (the 0.21 wasm drives ω(bodyB) − ω(bodyA) to
			 * the configured velocity, so materialization negates).
			 */
			readonly targetVelocity: number;
			/** Stall torque cap, N·u (world torque units). */
			readonly maxTorque: number;
			/**
			 * On/off toggle (P4-T3): off materializes a plain revolute (no motor
			 * configured). Lives in the params record so the state is document
			 * data — undo/redo and rebuild preserve it exactly.
			 */
			readonly on: boolean;
	  }
	| { readonly kind: "rod"; readonly length: number }
	| {
			readonly kind: "spring";
			/** Natural length (world units); the spring pulls AND pushes around it. */
			readonly restLength: number;
			/**
			 * Stiffness PER UNIT OF EFFECTIVE MASS (the rod precedent — Rapier's
			 * spring motor is force-based, so raw constants sag differently for
			 * different loads): ω = √stiffness rad/s regardless of the load, so
			 * the period T = 2π/√stiffness is a property of the parameter alone.
			 * Static extension under gravity = g/stiffness.
			 */
			readonly stiffness: number;
			/** Damping per unit of effective mass; ζ = damping / (2√stiffness). */
			readonly damping: number;
	  }
	| {
			readonly kind: "rope";
			/**
			 * Link rest length (world units). Rope links materialize as stiff
			 * mass-scaled springs (ROPE_LINK_* here) — placement multiplies the
			 * bead spacing by ROPE_LINK_SLACK so a bridging chain has droop
			 * room; the panel edit replaces this one link's spring.
			 */
			readonly length: number;
	  }
	| {
			readonly kind: "pulley";
			/**
			 * The wheel point in WORLD coordinates — a fixed scene attachment,
			 * not a body (moving an endpoint never moves the wheel; the panel
			 * readout shows it, the wheel is its own pickable glyph). Lives in
			 * params so the whole pulley rides the JointEntity shape (undo,
			 * save/load, assemblies) without touching the entity union.
			 */
			readonly wheelX: number;
			readonly wheelY: number;
			/**
			 * Total rope length (world units): locked at placement to
			 * dist(A→wheel) + dist(wheel→B). The rope only PULLS (tension ≥ 0),
			 * so a path shorter than this hangs slack.
			 */
			readonly length: number;
	  };

/**
 * Rod materialization (stiff spring): Rapier's spring motor is FORCE-based
 * (measured: fixed stiffness sagged a 400-mass box ~3 units), so stiffness
 * and damping are scaled per unit of the effective load mass (the mouse-joint
 * precedent in world.ts). ω = √1600 = 40 rad/s, critical damping 2ω = 80:
 * sag = g/ω² ≈ 0.006 world units under Earth gravity, and ω·dt ≈ 0.67 stays
 * far inside the fixed-tick stability window. Verified in
 * tests/unit/joint-types.test.ts.
 */
export const ROD_STIFFNESS_PER_MASS = 1600;
export const ROD_DAMPING_PER_MASS = 80;

/**
 * Rope-link spring constants (P4-T4), per unit of effective mass like the
 * rod's: ω = √6400 = 80 rad/s (ω·dt ≈ 1.33 at 60 Hz — inside the semi-implicit
 * stability window of 2, measured stable with ζ = 110/160 ≈ 0.7 fast-settling
 * damping). Stiffer than the rod because a bridge's end links carry the whole
 * half-chain plus load: at the rod's 1600 a loaded interior link stretched to
 * ~1.9× rest; 6400 holds it under ~1.35×.
 */
export const ROPE_LINK_STIFFNESS_PER_MASS = 6400;
export const ROPE_LINK_DAMPING_PER_MASS = 110;

/** Default slider translation limits (world units) applied at placement. */
export const SLIDER_DEFAULT_LIMIT = 100;

/**
 * Spring defaults (P4-T4), per-mass like the rod constants: stiffness 30 →
 * ω ≈ 5.5 rad/s (period ≈ 1.1 s — a visibly bouncy hang), damping 4 →
 * ζ ≈ 0.36 (a few visible oscillations before settling). Static extension
 * under gravity = g/30 ≈ 0.33 world units.
 */
export const SPRING_DEFAULT_STIFFNESS = 30;
export const SPRING_DEFAULT_DAMPING = 4;

/**
 * Motor defaults (P4-T3) applied at placement. Torque default is sized for
 * machine-scale loads in this sandbox (bodies of mass ~10²–10⁴, world-unit
 * lever arms — it lifts a 360-mass boom on a 30-unit arm with 10× headroom)
 * and spins a unit-density r=20 wheel up in under a second. Stall behavior
 * itself is pinned by tests with explicit caps (setMotorMaxForce is a literal
 * world-torque clamp, measured).
 */
export const MOTOR_DEFAULT_VELOCITY = 3;
export const MOTOR_DEFAULT_TORQUE = 1_000_000;
/**
 * Motor PD velocity damping factor (the `factor` argument of Rapier's
 * `configureMotorVelocity`). Measured semantics (0.21 wasm): the motor's
 * demand is I·factor·(target − current), clamped by maxTorque — so spin-up
 * is TORQUE-limited (α = maxTorque/I) and `factor` only shapes the approach
 * once the error is small (factor·dt ≈ 0.33 at 60 Hz: deadbeat-ish without
 * ringing). Pinned in tests/unit/joint-motor.test.ts.
 */
export const MOTOR_VELOCITY_FACTOR = 20;

/**
 * The joint types the placement tool offers (P4-T2 passive kinds + the P4-T3
 * motor + the P4-T4 spring/rope). Rope placement is a freehand STROKE (the
 * chain builder), not a two-click attach — {@link makePlacedJoint} still
 * refuses it; the spring places exactly like a rod.
 */
export type PlaceableJointKind =
	| "pin"
	| "weld"
	| "rod"
	| "slider"
	| "motor"
	| "spring"
	| "rope"
	| "pulley";

/** DOM-validation guard for the tool rail's joint-kind buttons. */
export function isPlaceableJointKind(
	value: string,
): value is PlaceableJointKind {
	return (
		value === "pin" ||
		value === "weld" ||
		value === "rod" ||
		value === "slider" ||
		value === "motor" ||
		value === "spring" ||
		value === "rope" ||
		value === "pulley"
	);
}

/**
 * RESERVED custom-constraint seam (PRD R6 — post-MVP gears/pulleys): a
 * non-Rapier constraint plugs in behind this interface without touching the
 * document union or `spawnJoint`'s type switch. Interface only; no
 * implementation ships in this phase.
 */
export interface CustomConstraint {
	/** Stable registry key (e.g. "gear-pair"). */
	readonly id: string;
	createImpulseJoint(
		world: RAPIER.World,
		bodyA: RAPIER.RigidBody,
		bodyB: RAPIER.RigidBody,
		anchorA: Vec2,
		anchorB: Vec2,
	): RAPIER.ImpulseJoint;
}

/** One document joint: identity, endpoints, body-local anchors, params. */
export interface JointEntity {
	readonly kind: "joint";
	readonly id: DocumentId;
	/** The joint type; always equal to `params.kind` (enforced by makeJoint). */
	readonly jointType: JointType;
	/** First body (always a simulated body — world-anchored joints use bodyB=null). */
	readonly bodyA: DocumentId;
	/** Pivot on bodyA, body-local. */
	readonly anchorA: Vec2;
	/** Second body, or null for a world (ground) anchor. */
	readonly bodyB: DocumentId | null;
	/** Pivot on bodyB (body-local), or the world point when bodyB is null. */
	readonly anchorB: Vec2;
	readonly params: JointParams;
}

/**
 * World point → a body's local frame (inverse rotation + translation, y-down
 * world per world.ts). The ONE anchor computation shared by placement (tool),
 * rebuild (spawnJoint asserts it), and tests.
 */
export function worldPointToLocal(
	px: number,
	py: number,
	bodyX: number,
	bodyY: number,
	bodyRot: number,
): Vec2 {
	const cos = Math.cos(-bodyRot);
	const sin = Math.sin(-bodyRot);
	const dx = px - bodyX;
	const dy = py - bodyY;
	return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

/** A body's local point → world coordinates (the anchor-math inverse). */
export function localPointToWorld(
	lx: number,
	ly: number,
	bodyX: number,
	bodyY: number,
	bodyRot: number,
): Vec2 {
	const cos = Math.cos(bodyRot);
	const sin = Math.sin(bodyRot);
	return { x: bodyX + lx * cos - ly * sin, y: bodyY + lx * sin + ly * cos };
}

/**
 * Build a joint entity from a world-space placement click: both anchors are
 * derived from the SAME world point, so the pivots coincide at placement time
 * (Rapier snaps the bodies together along the joint's error, and a pin keeps
 * each body's current rotation). `transformB` is null for a world anchor.
 * `worldPointB` overrides anchorB's source point (the rod's two-endpoint
 * placement); it defaults to `worldPoint`.
 */
export function makeJoint(
	id: DocumentId,
	params: JointParams,
	bodyA: DocumentId,
	bodyB: DocumentId | null,
	worldPoint: Vec2,
	transformA: { x: number; y: number; rot: number },
	transformB: { x: number; y: number; rot: number } | null,
	worldPointB?: Vec2,
): JointEntity {
	const pb = worldPointB ?? worldPoint;
	return {
		kind: "joint",
		id,
		jointType: params.kind,
		bodyA,
		anchorA: worldPointToLocal(
			worldPoint.x,
			worldPoint.y,
			transformA.x,
			transformA.y,
			transformA.rot,
		),
		bodyB,
		anchorB:
			bodyB && transformB
				? worldPointToLocal(
						pb.x,
						pb.y,
						transformB.x,
						transformB.y,
						transformB.rot,
					)
				: { x: pb.x, y: pb.y },
		params,
	};
}

/** Live world position of a joint's anchor (drawn glyph + picking). */
export function jointWorldAnchor(
	entity: JointEntity,
	transformA: { x: number; y: number; rot: number } | undefined,
): Vec2 | undefined {
	if (!transformA) return undefined;
	return localPointToWorld(
		entity.anchorA.x,
		entity.anchorA.y,
		transformA.x,
		transformA.y,
		transformA.rot,
	);
}

/**
 * Glyph sizing, shared by the renderer and the picker so what you see is what
 * you click (the label precedent): the ring stays within [5, 14] CSS pixels
 * on screen, and never exceeds JOINT_GLYPH_RADIUS world units.
 */
export const JOINT_GLYPH_RADIUS = 0.45;
export const JOINT_GLYPH_MIN_PX = 5;
export const JOINT_GLYPH_MAX_PX = 14;

/** The visible glyph radius in world units at this zoom (pick uses it too). */
export function jointGlyphRadius(zoom: number): number {
	return Math.min(
		Math.max(JOINT_GLYPH_RADIUS, JOINT_GLYPH_MIN_PX / zoom),
		JOINT_GLYPH_MAX_PX / zoom,
	);
}

/** Pick radius: the drawn glyph plus a small forgiveness pad (20%). */
export function jointPickRadius(zoom: number): number {
	return jointGlyphRadius(zoom) * 1.2;
}

/** Human-readable label per joint type (panel + toolbar). */
export const JOINT_TYPE_LABELS: Record<JointType, string> = {
	pin: "Pin",
	motor: "Motor",
	slider: "Slider",
	rod: "Rod",
	spring: "Spring",
	weld: "Weld",
	rope: "Rope",
	pulley: "Pulley",
};

/**
 * Build a joint entity from a TWO-CLICK placement: `p1` is the arming click
 * (on bodyA), `p2` the placement click (on bodyB or empty space = world
 * anchor). Pin/weld/slider/motor derive BOTH anchors from `p2` (coincident
 * pivots — the T1 semantics; the motor is a powered pin), a rod uses `p1` and
 * `p2` as its two ENDPOINTS and takes its length from their distance. Returns
 * undefined for kinds without this placement path (rope — P4-T4: the
 * freehand stroke; pulley without the `wheel` third click). The ONE
 * placement computation shared by the joint tool (interaction.ts) and the
 * debug API, so both paths produce identical entities.
 */
export function makePlacedJoint(
	id: DocumentId,
	kind: PlaceableJointKind,
	bodyA: DocumentId,
	bodyB: DocumentId | null,
	p1: Vec2,
	p2: Vec2,
	transformA: { x: number; y: number; rot: number },
	transformB: { x: number; y: number; rot: number } | null,
	wheel?: Vec2,
): JointEntity | undefined {
	let params: JointParams;
	let pivot: Vec2;
	let endpointB: Vec2 | null = null;
	switch (kind) {
		case "pin":
			params = { kind: "pin" };
			pivot = p2;
			break;
		case "weld":
			params = {
				kind: "weld",
				relRot: (transformB?.rot ?? 0) - transformA.rot,
			};
			pivot = p2;
			break;
		case "slider": {
			// Axis from the click vector, expressed in bodyA-local coordinates
			// (rotates with the body like the anchors). Degenerate clicks (same
			// point) default to +x. Limits: 0 = the placement configuration.
			const dx = p2.x - p1.x;
			const dy = p2.y - p1.y;
			const len = Math.hypot(dx, dy);
			const worldAxis =
				len > 1e-9 ? { x: dx / len, y: dy / len } : { x: 1, y: 0 };
			const cos = Math.cos(-transformA.rot);
			const sin = Math.sin(-transformA.rot);
			params = {
				kind: "slider",
				axisX: worldAxis.x * cos - worldAxis.y * sin,
				axisY: worldAxis.x * sin + worldAxis.y * cos,
				min: -SLIDER_DEFAULT_LIMIT,
				max: SLIDER_DEFAULT_LIMIT,
			};
			pivot = p2;
			break;
		}
		case "rod":
			params = { kind: "rod", length: Math.hypot(p2.x - p1.x, p2.y - p1.y) };
			pivot = p1;
			endpointB = p2;
			break;
		case "spring":
			// Two clicks = the two anchors, like the rod; the natural length is
			// the placed distance and the stiffness/damping take the per-mass
			// defaults (editable in the panel afterwards).
			params = {
				kind: "spring",
				restLength: Math.hypot(p2.x - p1.x, p2.y - p1.y),
				stiffness: SPRING_DEFAULT_STIFFNESS,
				damping: SPRING_DEFAULT_DAMPING,
			};
			pivot = p1;
			endpointB = p2;
			break;
		case "motor":
			// Powered pin: coincident pivots, default drive params, ON at
			// placement (the glyph shows the running state immediately).
			params = {
				kind: "motor",
				targetVelocity: MOTOR_DEFAULT_VELOCITY,
				maxTorque: MOTOR_DEFAULT_TORQUE,
				on: true,
			};
			pivot = p2;
			break;
		case "pulley": {
			// Three-click placement (two bodies + the fixed wheel): the wheel is
			// a scene attachment in params, the rope length locks to the placed
			// path through it, and the two clicks are the ENDPOINTS (anchors are
			// body-local, like the rod's). The third click is the wheel, so a
			// missing `wheel` is a refused placement.
			if (!wheel) return undefined;
			params = {
				kind: "pulley",
				wheelX: wheel.x,
				wheelY: wheel.y,
				length:
					Math.hypot(wheel.x - p1.x, wheel.y - p1.y) +
					Math.hypot(wheel.x - p2.x, wheel.y - p2.y),
			};
			pivot = p1;
			endpointB = p2;
			break;
		}
		default:
			// Rope (the only remaining non-attached kind): placement is the
			// freehand stroke path in interaction.ts, not a two-click attach.
			return undefined;
	}
	return makeJoint(
		id,
		params,
		bodyA,
		bodyB,
		pivot,
		transformA,
		transformB,
		endpointB ?? undefined,
	);
}
