/**
 * DOM wiring for the tool system: toolbar buttons (Select V, Box B, Circle C,
 * Polygon G, Line L, Freehand F, Text T), the static-mode toggle (S — draw
 * spawns become terrain), edit actions (Delete, Duplicate), keyboard
 * shortcuts (Enter closes a polygon placement; Enter/Escape commit an inline
 * label edit; typing edits the label text), and canvas pointer events feeding
 * the ToolSession. The session's commands are applied to the
 * PhysicsWorld here: spawn, pause-aware selection drag (spring joint while
 * running, kinematic teleport while paused; labels move through the
 * document), R-drag rotation, delete, and offset-duplicate. Must be attached
 * AFTER attachCameraControls: camera-controls claims space-drag and
 * middle-drag via stopImmediatePropagation, so this layer only ever sees
 * plain left-button presses.
 */
import type { Camera } from "./camera";
import { defaultBody } from "./document";
import {
	isPlaceableJointKind,
	makeJoint,
	makePlacedJoint,
	worldPointToLocal,
} from "./joint";
import { MATERIAL_DEFAULT_ID } from "./material";
import { showNotice } from "./notice";
import {
	buildRopeChain,
	countRopeSegmentIds,
	freshRopeSegmentId,
	ROPE_LINK_SLACK,
	ROPE_MAX_SEGMENTS_PER_CHAIN,
	ROPE_MAX_TOTAL_SEGMENTS,
	ROPE_SEGMENT_RADIUS,
	ROPE_SEGMENT_SPACING,
	syncRopeSegmentCounter,
} from "./rope";
import {
	aimAngleLocal,
	THRUSTER_DEFAULT_STRENGTH,
	type ThrusterEntity,
} from "./thruster";
import {
	BEAM_HALF_WIDTH,
	beamFromSegment,
	classifyEditKey,
	DUPLICATE_OFFSET,
	isToolId,
	MIN_SHAPE_HALF_SIZE,
	pickBody,
	ROTATE_FLING_MAX_RAD_S,
	snapAngle,
	TOOL_KEYS,
	type ToolId,
	type ToolSession,
	type ToolSessionEvents,
} from "./tools";
import type { Vec2 } from "./triangulate";
import type { UndoStack } from "./undo";
import type { DocumentId, PhysicsWorld } from "./world";

type DragJoint = ReturnType<PhysicsWorld["startMouseJoint"]>;

let nextBodyId = 1;

/** Fresh document id for a newly spawned body: body-1, body-2, ... */
export function freshBodyId(): DocumentId {
	const id = `body-${nextBodyId}`;
	nextBodyId += 1;
	return id;
}

let nextJointId = 1;

/** Fresh document id for a newly placed joint: joint-1, joint-2, ... */
export function freshJointId(): DocumentId {
	const id = `joint-${nextJointId}`;
	nextJointId += 1;
	return id;
}

let nextThrusterId = 1;

/** Fresh document id for a newly mounted thruster: thruster-1, thruster-2, ... */
export function freshThrusterId(): DocumentId {
	const id = `thruster-${nextThrusterId}`;
	nextThrusterId += 1;
	return id;
}

/**
 * Advance every id minter past the highest N in `entities` (P5 review C1):
 * a restored scene carries ids this page's counters never issued, and a
 * later mint colliding with a restored id silently REPLACES that body (and
 * cascades its joints/thrusters away). Labels share the body counter; rope
 * segments carry their own (the rope-seg-N prefix).
 */
export function syncEntityIdCounters(
	entities: readonly { readonly id: DocumentId }[],
): void {
	let maxBody = 0;
	let maxJoint = 0;
	let maxThruster = 0;
	for (const { id } of entities) {
		maxBody = Math.max(maxBody, trailingNumber(id, "body-"));
		maxJoint = Math.max(maxJoint, trailingNumber(id, "joint-"));
		maxThruster = Math.max(maxThruster, trailingNumber(id, "thruster-"));
	}
	if (maxBody >= nextBodyId) nextBodyId = maxBody + 1;
	if (maxJoint >= nextJointId) nextJointId = maxJoint + 1;
	if (maxThruster >= nextThrusterId) nextThrusterId = maxThruster + 1;
	syncRopeSegmentCounter(entities);
}

/** "body-42" → 42 for the given prefix; 0 when it does not match. */
function trailingNumber(id: string, prefix: string): number {
	if (!id.startsWith(prefix)) return 0;
	const n = Number.parseInt(id.slice(prefix.length), 10);
	return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Rope chain spawn spec (P4-T4): see {@link placeRopeChain}. */
export interface RopeChainSpec {
	readonly points: readonly Vec2[];
	/**
	 * Pick id under each stroke endpoint. A pick id that resolves to a live
	 * body captures that endpoint by a pin joint; anything else (undefined,
	 * a label or joint id) captures it to the WORLD at the endpoint point
	 * (D18 "bodies/world").
	 */
	readonly captureA?: string | undefined;
	readonly captureB?: string | undefined;
	/**
	 * Material the rope segment beads take (the panel's active material;
	 * defaults to ink — the debug API omits it).
	 */
	readonly materialId?: string | undefined;
}

/** Ids a committed rope chain created. */
export interface RopeChainSpawned {
	readonly segments: readonly DocumentId[];
	readonly joints: readonly DocumentId[];
}

/**
 * Convert a rope stroke into a segment chain (P4-T4): resample, enforce the
 * D17 bounds (refusal surfaces VISIBLY via the notice toast, returns null),
 * spawn the small circle bodies, the rope-kind links, and the endpoint
 * capture pins (body → pin to that body; otherwise pin to world). Shared by
 * the tool path (createToolEvents) and the debug API so both produce
 * identical documents. The undo boundary belongs to the caller: the
 * session's pointer-down already began the action; the debug path is
 * test-only and skips undo like placeJoint.
 */
export function placeRopeChain(
	world: PhysicsWorld,
	spec: RopeChainSpec,
): RopeChainSpawned | null {
	const plan = buildRopeChain(spec.points, {
		existingTotal: countRopeSegmentIds(world.doc.ids()),
	});
	if (!plan.ok) {
		showNotice(
			plan.reason === "per-chain"
				? `Rope rejected: a chain is limited to ${ROPE_MAX_SEGMENTS_PER_CHAIN} segments`
				: plan.reason === "total"
					? `Rope rejected: the scene is limited to ${ROPE_MAX_TOTAL_SEGMENTS} rope segments in total`
					: "Rope rejected: the stroke is too short",
		);
		return null;
	}
	const transformOf = (
		id: DocumentId,
	): { x: number; y: number; rot: number } | undefined => {
		const b = world.bodies.get(id);
		return b
			? { x: b.translation().x, y: b.translation().y, rot: b.rotation() }
			: undefined;
	};
	const resolveCapture = (pickId: string | undefined): DocumentId | null =>
		pickId && world.bodies.has(pickId) ? pickId : null;
	const capA = resolveCapture(spec.captureA);
	const capB = resolveCapture(spec.captureB);
	/**
	 * A bead whose center lands STRICTLY INSIDE a capture target gets ejected
	 * by the deep-penetration contact, and the violent repeated impulses tear
	 * the end links (measured: end links at 3.5× link length). The pinned end
	 * bead itself is fine (its pair with the target is contacts-off via the
	 * capture pin), so every interior bead inside the target is dropped and
	 * the link across the gap takes the placed distance × slack.
	 */
	const insideCapture = (p: Vec2, bodyId: DocumentId): boolean => {
		const shape = world.shapeOf(bodyId);
		const body = world.bodies.get(bodyId);
		if (!shape || !body) return false;
		return (
			pickBody(
				[
					{
						id: bodyId,
						shape,
						x: body.translation().x,
						y: body.translation().y,
						rot: body.rotation(),
					},
				],
				p.x,
				p.y,
			) !== undefined
		);
	};
	const centers: Vec2[] = [...plan.segments];
	if (capA) {
		while (centers.length > 2 && insideCapture(centers[1] as Vec2, capA)) {
			centers.splice(1, 1);
		}
	}
	if (capB) {
		while (
			centers.length > 2 &&
			insideCapture(centers[centers.length - 2] as Vec2, capB)
		) {
			centers.splice(centers.length - 2, 1);
		}
	}
	if (centers.length < 2) {
		showNotice("Rope rejected: the stroke is too short");
		return null;
	}
	const segments: DocumentId[] = [];
	const joints: DocumentId[] = [];
	// Segment bodies: small touching beads along the kept resampled centers.
	for (const center of centers) {
		const id = freshRopeSegmentId();
		world.spawnEntity({
			...defaultBody(
				id,
				{ kind: "circle", radius: ROPE_SEGMENT_RADIUS },
				center.x,
				center.y,
			),
			isStatic: false,
			materialId: spec.materialId ?? MATERIAL_DEFAULT_ID,
		});
		segments.push(id);
	}
	// Rope links between consecutive kept beads, anchors at the bead centers.
	// A link across a capture-trim gap spans the placed distance × slack.
	for (let i = 1; i < segments.length; i++) {
		const aId = segments[i - 1] as DocumentId;
		const bId = segments[i] as DocumentId;
		const a = centers[i - 1] as Vec2;
		const b = centers[i] as Vec2;
		const ta = transformOf(aId);
		const tb = transformOf(bId);
		if (!ta || !tb) return null;
		const id = freshJointId();
		const placed = Math.hypot(b.x - a.x, b.y - a.y);
		if (
			!world.spawnJoint(
				makeJoint(
					id,
					{ kind: "rope", length: placed * ROPE_LINK_SLACK },
					aId,
					bId,
					{ x: a.x, y: a.y },
					ta,
					tb,
					{ x: b.x, y: b.y },
				),
			)
		) {
			return null;
		}
		joints.push(id);
	}
	// Endpoint capture (D18): a body under the endpoint captures it by a pin
	// joint; anything else pins to the world at the endpoint point.
	const capture = (
		capId: DocumentId | null,
		point: Vec2,
		segId: DocumentId,
	): void => {
		const ta = transformOf(segId);
		if (!ta) return;
		const tb = capId ? transformOf(capId) : null;
		if (capId && !tb) return;
		const id = freshJointId();
		// contactsOff: the captured bead sits half inside its target — the
		// contact pair would fight the pin (measured: the bridge chain
		// stretched to 2.5× link length before this rule). Lives in the
		// params record, so rebuild restores it.
		if (
			!world.spawnJoint(
				makeJoint(
					id,
					{ kind: "pin", contactsOff: true },
					segId,
					capId,
					{ x: point.x, y: point.y },
					ta,
					tb ?? null,
				),
			)
		) {
			return;
		}
		joints.push(id);
	};
	capture(capA, centers[0] as Vec2, segments[0] as DocumentId);
	capture(
		capB,
		centers[centers.length - 1] as Vec2,
		segments[segments.length - 1] as DocumentId,
	);
	return { segments, joints };
}

/** Getters the event wiring needs from the app (pause state, live selection). */
export interface ToolEventsDeps {
	/** True while the sim is paused: drag becomes a kinematic teleport. */
	isPaused: () => boolean;
	/** The live selection set, so multi-body moves hit every selected body. */
	selectedIds: () => ReadonlySet<string>;
	/** Drop a culled body from the live selection (no ghost selection). */
	pruneSelection: (id: string) => void;
	/**
	 * Static mode: while true, draw-tool spawns are committed with
	 * `isStatic: true` (terrain — infinite mass). Read per spawn.
	 */
	isStaticSpawn?: () => boolean;
	/**
	 * The material id new draw-tool spawns take — the material panel's active
	 * material (P3-T2, PRD D20). Read per spawn; defaults to ink.
	 */
	activeMaterialId?: () => string;
	/**
	 * Angle snap (draw options): while true the rotate gesture quantizes the
	 * pose to 15° steps and the release fling is suppressed. Read per move.
	 */
	angleSnap?: () => boolean;
	/**
	 * A mutation boundary completed: snapshot for undo (shape commit, delete,
	 * duplicate, label commit, move-end, rotate-end). Called after applying.
	 */
	recordAction?: () => void;
	beginAction?: () => void;
	cancelAction?: () => void;
}

/**
 * Builds the session-event to world-command wiring (spawns, drag, rotate,
 * delete, duplicate).
 */
export function createToolEvents(
	world: PhysicsWorld,
	deps?: Partial<ToolEventsDeps>,
): ToolSessionEvents & {
	activeJoint: DragJoint | null;
	/** Body the activeJoint drags, if any; cleared alongside the joint. */
	draggedId: DocumentId | undefined;
	/** Removal handler; also installed on the world below. */
	onRemove(id: DocumentId): void;
} {
	const isPaused = deps?.isPaused ?? (() => false);
	const selectedIds = deps?.selectedIds ?? (() => new Set<string>());
	const pruneSelection = deps?.pruneSelection ?? (() => {});
	const isStaticSpawn = deps?.isStaticSpawn ?? (() => false);
	const activeMaterialId =
		deps?.activeMaterialId ?? (() => MATERIAL_DEFAULT_ID);
	const recordAction = deps?.recordAction ?? (() => {});
	const beginAction = deps?.beginAction ?? (() => {});
	const events: ToolSessionEvents & {
		activeJoint: DragJoint | null;
		draggedId: DocumentId | undefined;
		/** Grab point of the active drag; null between gestures. */
		dragGrab: { x: number; y: number } | null;
		/** Base rotations captured at rotate-gesture start, by body id. */
		rotateBase: Map<DocumentId, number>;
		/** Removal handler; also installed on the world below. */
		onRemove(id: DocumentId): void;
	} = {
		onBeginAction: beginAction,
		onCancelAction: () => deps?.cancelAction?.(),
		labelAt: (id) => world.labelOf(id),
		activeJoint: null,
		// F5 seam: when step() culls the dragged body, Rapier destroys the
		// drag joint with it, so the retained handle is stale — drop it rather
		// than touching a removed joint on the next move/release.
		draggedId: undefined,
		dragGrab: null,
		rotateBase: new Map(),
		onRemove(id: DocumentId): void {
			if (this.draggedId === id) {
				this.activeJoint = null;
				this.draggedId = undefined;
				this.dragGrab = null;
			}
			this.rotateBase.delete(id);
			pruneSelection(id);
		},
		onSpawnBox({ cx, cy, halfWidth, halfHeight }) {
			beginAction();
			world.spawnEntity({
				...defaultBody(
					freshBodyId(),
					{ kind: "box", halfWidth, halfHeight },
					cx,
					cy,
				),
				isStatic: isStaticSpawn(),
				materialId: activeMaterialId(),
			});
			recordAction();
		},
		onSpawnCircle({ cx, cy, radius }) {
			beginAction();
			world.spawnCircle(
				freshBodyId(),
				cx,
				cy,
				radius,
				isStaticSpawn(),
				activeMaterialId(),
			);
			recordAction();
		},
		onSpawnPolygon(points) {
			// Degenerate input (zero area) is dropped by the world: no body.
			beginAction();
			if (
				world.spawnPolygon(
					freshBodyId(),
					points,
					isStaticSpawn(),
					activeMaterialId(),
				)
			)
				recordAction();
			else deps?.cancelAction?.();
		},
		onSpawnLine({ cx, cy, rot, halfLength, halfWidth }) {
			beginAction();
			// The beam is a thin rotated box — the box shape commit boundary.
			world.spawnEntity({
				...defaultBody(
					freshBodyId(),
					{ kind: "box", halfWidth: halfLength, halfHeight: halfWidth },
					cx,
					cy,
					rot,
				),
				isStatic: isStaticSpawn(),
				materialId: activeMaterialId(),
			});
			recordAction();
		},
		onSpawnFreehand(result) {
			beginAction();
			// Cleanup already happened in decideFreehand; commit per decision.
			// Open strokes become a chain of independent beam segments (the beam
			// precedent: thin rotated boxes); rope joints are P4, not here.
			// Static mode applies to every decision, so a freehand-drawn ramp
			// paints terrain just like the polygon tool.
			const isStatic = isStaticSpawn();
			const materialId = activeMaterialId();
			switch (result.kind) {
				case "circle":
					world.spawnCircle(
						freshBodyId(),
						result.cx,
						result.cy,
						result.radius,
						isStatic,
						materialId,
					);
					break;
				case "rect":
					world.spawnEntity({
						...defaultBody(
							freshBodyId(),
							{
								kind: "box",
								halfWidth: result.halfWidth,
								halfHeight: result.halfHeight,
							},
							result.cx,
							result.cy,
							result.rot,
						),
						isStatic,
						materialId,
					});
					break;
				case "polygon":
					if (
						!world.spawnPolygon(
							freshBodyId(),
							result.points,
							isStatic,
							materialId,
						)
					) {
						deps?.cancelAction?.();
						return;
					}
					break;
				case "chain": {
					// P4 chain geometry: STATIC chains square-cap each segment
					// half a beam width past its joint — the bend notch fills and
					// the rendered surface reads continuous (static-static pairs
					// never collide, so the cap overlap is free). DYNAMIC chains
					// accumulate points into whole segments of at least the
					// minimum half-size instead of clamping halfLengths into
					// overlapping neighbors.
					const pts = result.points;
					const emit = (ax: number, ay: number, bx: number, by: number) => {
						const len = Math.hypot(bx - ax, by - ay);
						const beam = beamFromSegment(ax, ay, bx, by);
						world.spawnEntity({
							...defaultBody(
								freshBodyId(),
								{
									kind: "box",
									halfWidth: isStatic
										? len / 2 + BEAM_HALF_WIDTH
										: Math.max(len / 2, MIN_SHAPE_HALF_SIZE),
									halfHeight: BEAM_HALF_WIDTH,
								},
								beam.cx,
								beam.cy,
								beam.rot,
							),
							isStatic,
							materialId,
						});
					};
					if (isStatic) {
						for (let i = 1; i < pts.length; i++) {
							const a = pts[i - 1] as { x: number; y: number };
							const b = pts[i] as { x: number; y: number };
							emit(a.x, a.y, b.x, b.y);
						}
					} else {
						let runX = (pts[0] as { x: number; y: number }).x;
						let runY = (pts[0] as { x: number; y: number }).y;
						for (let i = 1; i < pts.length; i++) {
							const p = pts[i] as { x: number; y: number };
							const runLen = Math.hypot(p.x - runX, p.y - runY);
							if (runLen >= MIN_SHAPE_HALF_SIZE * 2 || i === pts.length - 1) {
								emit(runX, runY, p.x, p.y);
								runX = p.x;
								runY = p.y;
							}
						}
					}
					break;
				}
			}
			// Freehand shape-commit boundary (any decision that spawned).
			recordAction();
		},
		onCreateLabel({ x, y }) {
			beginAction();
			return world.addLabel(freshBodyId(), x, y);
		},
		onCommitLabel(id, text) {
			world.setLabelText(id, text);
			// Label-text commit boundary (creation commits only when the text
			// is non-empty; the discard path commits through onDelete).
			recordAction();
		},
		onDragStart(id, grab) {
			beginAction();
			this.draggedId = id;
			// Doc-only entities (labels) have no Rapier body to grab; the paused-
			// teleport drag path still needs the grab point to move them.
			this.dragGrab = grab;
			const body = world.bodies.get(id);
			if (!body) return;
			if (isPaused() || body.isFixed()) return; // paused: teleport on move, no joint
			this.activeJoint = world.startMouseJoint(body, grab);
			this.draggedId = id;
		},
		onDragMove(target) {
			if (this.activeJoint) {
				world.moveMouseJointTarget(this.activeJoint, target);
			}
			// Paused teleport: every selected body shifts by the pointer delta.
			// Doc-only entities (labels) shift through the document — they have
			// no Rapier body to consult.
			const grab = this.dragGrab;
			if (!grab) return;
			const dx = target.x - grab.x;
			const dy = target.y - grab.y;
			for (const id of selectedIds()) {
				if (this.activeJoint && !world.bodies.get(id)?.isFixed()) {
					if (world.bodies.has(id)) continue;
				}
				const p = world.bodyPosition(id);
				if (p) {
					world.moveBody(id, p.x + dx, p.y + dy);
					continue;
				}
				const e = world.doc.get(id);
				if (e && (e.kind === "body" || e.kind === "label"))
					world.doc.setTransform(id, e.x + dx, e.y + dy, e.rot);
			}
			this.dragGrab = target;
		},
		onDragEnd() {
			if (this.activeJoint) {
				world.endMouseJoint(this.activeJoint);
				this.activeJoint = null;
			}
			this.draggedId = undefined;
			this.dragGrab = null;
			// Move-end: snapshot whatever the drag left behind (a click-drag
			// that moved nothing dedupes in the stack).
			recordAction();
		},
		onRotateEnd(angularVelocity) {
			// Rotate-end boundary (release, cancel, or tool switch).
			// P3 rotation momentum: a mid-motion RELEASE flings the selection
			// — signed rad/s onto every selected dynamic body (physical state
			// like the mouse-joint drag, folded into the document at the next
			// action boundary, never an undo entry of its own). Paused worlds
			// and cancellations (undefined velocity) never fling.
			if (
				angularVelocity !== undefined &&
				!deps?.isPaused?.() &&
				!(deps?.angleSnap?.() ?? false) &&
				Math.abs(angularVelocity) <= ROTATE_FLING_MAX_RAD_S
			) {
				for (const id of selectedIds()) {
					const body = world.bodies.get(id);
					if (body && !body.isFixed()) {
						body.setAngvel(angularVelocity, true);
					}
				}
			}
			recordAction();
		},
		onRotateStart() {
			beginAction();
			this.rotateBase.clear();
			for (const id of selectedIds()) {
				const e = world.doc.get(id);
				const rot =
					world.bodyRotation(id) ??
					(e && (e.kind === "body" || e.kind === "label") ? e.rot : undefined);
				if (rot !== undefined) this.rotateBase.set(id, rot);
			}
			// Rotation overrides are kinematic; works paused or running.
		},
		onRotate(delta) {
			// Angle snap (draw options): the ABSOLUTE pose quantizes to 15°
			// steps, so an arbitrary prior rotation lands exactly on the grid.
			const snapStep = deps?.angleSnap?.() ?? false;
			for (const [id, base] of this.rotateBase) {
				const target = base + delta;
				const applied = snapStep ? snapAngle(target) : target;
				if (world.bodies.has(id)) world.rotateBody(id, applied);
				else {
					const e = world.doc.get(id);
					if (e && (e.kind === "body" || e.kind === "label"))
						world.doc.setTransform(id, e.x, e.y, applied);
				}
			}
		},
		onDelete(ids) {
			beginAction();
			for (const id of ids) world.removeBody(id);
			recordAction();
		},
		onPlaceJoint(spec) {
			beginAction();
			const bodyA = world.bodies.get(spec.bodyAId);
			const bodyB = spec.bodyBId ? world.bodies.get(spec.bodyBId) : null;
			if (!bodyA || (spec.bodyBId && !bodyB)) {
				// Refused placement (body gone mid-gesture): drop the undo snapshot
				// this gesture began instead of committing a no-op.
				deps?.cancelAction?.();
				return undefined;
			}
			// T2: the tool's joint kind drives the params; makePlacedJoint is the
			// ONE placement computation (shared with the debug API). The pulley's
			// third-click wheel point rides the spec (absent for other kinds).
			const entity = makePlacedJoint(
				freshJointId(),
				spec.jointKind,
				spec.bodyAId,
				spec.bodyBId,
				{ x: spec.anchorX, y: spec.anchorY },
				{ x: spec.x, y: spec.y },
				{
					x: bodyA.translation().x,
					y: bodyA.translation().y,
					rot: bodyA.rotation(),
				},
				bodyB
					? {
							x: bodyB.translation().x,
							y: bodyB.translation().y,
							rot: bodyB.rotation(),
						}
					: null,
				spec.wheelX !== undefined
					? { x: spec.wheelX, y: spec.wheelY ?? 0 }
					: undefined,
			);
			if (!entity || !world.spawnJoint(entity)) {
				deps?.cancelAction?.();
				return undefined;
			}
			recordAction();
			return entity.id;
		},
		onPlaceThruster(spec) {
			beginAction();
			const body = world.bodies.get(spec.bodyId);
			if (!body) {
				// Refused placement (body gone mid-gesture): drop the undo
				// snapshot instead of committing a no-op.
				deps?.cancelAction?.();
				return undefined;
			}
			// The mount anchor is the click point in the body's local frame
			// (the joint anchor precedent); defaults come from the thruster
			// module, and the panel owns later edits.
			const t = body.translation();
			const local = worldPointToLocal(
				spec.x,
				spec.y,
				t.x,
				t.y,
				body.rotation(),
			);
			const entity: ThrusterEntity = {
				kind: "thruster",
				id: freshThrusterId(),
				bodyId: spec.bodyId,
				anchorX: local.x,
				anchorY: local.y,
				angle: 0,
				strength: THRUSTER_DEFAULT_STRENGTH,
				on: true,
			};
			if (!world.spawnThruster(entity)) {
				deps?.cancelAction?.();
				return undefined;
			}
			// NO recordAction here: the aim drag completes the gesture, and the
			// mount + aim land as ONE undo step (recorded by onThrusterAim).
			return entity.id;
		},
		onThrusterAim(spec) {
			// Mount + aim as ONE undo step. Null (tiny drag / Escape / tool
			// switch) keeps the placed angle and still records the mount.
			const t = world.doc.get(spec.id);
			if (t?.kind !== "thruster") {
				// Gone mid-drag (sim event): drop the dangling mount snapshot.
				deps?.cancelAction?.();
				return;
			}
			if (spec.worldAngle !== null) {
				const body = world.bodies.get(t.bodyId);
				if (body) {
					// World drag angle → body-local stored angle (the panel's
					// Angle field reads the same convention).
					const w = spec.worldAngle;
					world.updateThruster(spec.id, {
						angle: aimAngleLocal(Math.cos(w), Math.sin(w), body.rotation()),
					});
				}
			}
			recordAction();
		},
		onSpawnRope(spec) {
			// Rope stroke commit (P4-T4). The session's pointer-down already
			// began the undo action for this gesture; a refused chain (D17
			// bounds) drops the snapshot, a committed one records it.
			const result = placeRopeChain(world, {
				...spec,
				materialId: activeMaterialId(),
			});
			if (result) recordAction();
			else deps?.cancelAction?.();
			return result;
		},
		onMotorGlyphClick(id) {
			// Glyph toggle affordance (P4-T3 motor, P4-T5 thruster): the
			// select-tool press landed on a joint/thruster glyph; a MOTOR flips
			// its `on` state through updateJointParams, a THRUSTER through
			// updateThruster — each inside ONE undo boundary (the toggle is
			// undoable; rebuild carries the state). Other kinds: not consumed.
			const e = world.doc.get(id);
			if (e?.kind === "joint" && e.params.kind === "motor") {
				const params = e.params;
				beginAction();
				world.updateJointParams(id, { ...params, on: !params.on });
				recordAction();
				return true;
			}
			if (e?.kind === "thruster") {
				beginAction();
				world.updateThruster(id, { on: !e.on });
				recordAction();
				return true;
			}
			return false;
		},
		onDuplicate(ids) {
			beginAction();
			const newIds = ids.map((id) =>
				world.bodies.has(id)
					? world.duplicateBody(
							id,
							freshBodyId(),
							DUPLICATE_OFFSET.x,
							DUPLICATE_OFFSET.y,
						)
					: world.duplicateLabel(
							id,
							freshBodyId(),
							DUPLICATE_OFFSET.x,
							DUPLICATE_OFFSET.y,
						),
			);
			// Duplicate boundary (copies become the selection afterwards).
			recordAction();
			return newIds;
		},
	};
	// Arrow wrapper: a bare `world.onRemove = events.onRemove` would run the
	// handler with the world as `this`, missing the events object's fields.
	world.onRemove = (id) => events.onRemove(id);
	return events;
}

export interface ToolControlsDeps {
	toolbar: HTMLElement;
	canvas: HTMLCanvasElement;
	camera: Camera;
	session: ToolSession;
	/**
	 * The undo stack, for the undo/redo toolbar buttons and shortcuts. When
	 * absent, undo/redo buttons are rendered but permanently disabled.
	 */
	undo?: UndoStack;
	/**
	 * Double-click on a label (select tool): re-enter its inline text edit.
	 * Implemented in main.ts (the pickable label list lives there); a miss
	 * returns false and the double-click means nothing.
	 */
	onLabelDoubleClick?: (wx: number, wy: number) => boolean;
	/** Fired after a tool change commits — the settings save hook. */
	onToolChange?: ((tool: ToolId) => void) | undefined;
	/** Fired after the static-mode toggle flips — the settings save hook. */
	onStaticModeChange?: ((on: boolean) => void) | undefined;
}

/** Cursor while a draw tool is armed (the camera's resting cursor, too). */
export const CURSOR_DRAW = "crosshair";

export function attachToolControls(deps: ToolControlsDeps): () => void {
	const { toolbar, canvas, camera, session, undo } = deps;

	const toolButtons = Array.from(
		toolbar.querySelectorAll<HTMLLabelElement>("[data-tool]"),
	);
	// The tool rail is a native radio group (P3-T4 a11y): label clicks and
	// arrow-key navigation both land as a change event on the input — one
	// listener covers mouse and keyboard.
	toolbar.addEventListener("change", (event) => {
		const input = event.target;
		if (!(input instanceof HTMLInputElement) || !input.checked) return;
		if (input.name === "tool" && isToolId(input.value)) {
			setToolAndSync(input.value);
		} else if (input.name === "joint-kind") {
			// setJointKind cancels an in-progress placement gesture — a kind
			// switch mid-placement must not leak the taken clicks across.
			if (isPlaceableJointKind(input.value)) session.setJointKind(input.value);
			syncToolbar();
		}
	});

	// Edit actions (not tools): delete and duplicate the selection.
	const actionHandlers: Record<string, () => void> = {
		delete: () => {
			session.requestDelete();
		},
		duplicate: () => {
			session.requestDuplicate();
		},
		undo: () => {
			session.cancel();
			undo?.undo();
		},
		redo: () => {
			session.cancel();
			undo?.redo();
		},
	};
	const actionButtons = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>("[data-action]"),
	);
	for (const button of actionButtons) {
		const handler = actionHandlers[button.dataset.action ?? ""];
		if (handler) button.addEventListener("click", handler);
	}

	// Static mode toggle (S, or the toolbar button): while on, draw-tool
	// spawns are committed static (terrain). A mode, not a tool — the current
	// tool keeps working, only the static flag of new spawns changes.
	const staticButtons = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>('[data-mode="static"]'),
	);

	const toggleStaticMode = (): void => {
		session.staticMode = !session.staticMode;
		syncStaticMode();
		deps.onStaticModeChange?.(session.staticMode);
	};

	function syncStaticMode(): void {
		for (const button of staticButtons) {
			button.classList.toggle("active", session.staticMode);
			button.setAttribute(
				"aria-pressed",
				session.staticMode ? "true" : "false",
			);
		}
	}
	for (const button of staticButtons) {
		button.addEventListener("click", toggleStaticMode);
	}

	// Joint-kind picker (P4-T2): segmented buttons in the tool rail, visible
	// only while the joint tool is active. Clicking sets the session's
	// placement kind; syncToolbar mirrors it into checked radios.
	const kindRow = toolbar.querySelector<HTMLElement>("[data-joint-kinds]");
	const jointKindButtons = Array.from(
		toolbar.querySelectorAll<HTMLLabelElement>("[data-joint-kind]"),
	);

	// Undo/redo buttons: disabled when the respective stack is empty.
	const undoButtons = {
		undo: Array.from(
			toolbar.querySelectorAll<HTMLButtonElement>('[data-action="undo"]'),
		),
		redo: Array.from(
			toolbar.querySelectorAll<HTMLButtonElement>('[data-action="redo"]'),
		),
	};

	function syncUndoButtons(): void {
		for (const button of undoButtons.undo) button.disabled = !undo?.canUndo;
		for (const button of undoButtons.redo) button.disabled = !undo?.canRedo;
	}
	if (undo) {
		undo.onChange = syncUndoButtons;
		syncUndoButtons();
	}

	function syncToolbar(): void {
		// Radio-group semantics: the tool choice is 1-of-N; the label's
		// hidden input carries checked state (markup + change wiring above).
		for (const label of toolButtons) {
			const active = label.dataset.tool === session.tool;
			label.classList.toggle("active", active);
			const input = label.querySelector("input");
			if (input) input.checked = active;
		}
		// Joint-kind picker row: visible only while the joint tool is active;
		// its buttons mirror the session's placement kind.
		if (kindRow) kindRow.hidden = session.tool !== "joint";
		for (const label of jointKindButtons) {
			const active = label.dataset.jointKind === session.jointKind;
			label.classList.toggle("active", active);
			const input = label.querySelector("input");
			if (input) input.checked = active;
		}
	}

	const setToolAndSync = (tool: ToolId): void => {
		session.setTool(tool);
		syncToolbar();
		applyCursor();
		deps.onToolChange?.(tool);
	};

	function worldFromEvent(event: PointerEvent): { x: number; y: number } {
		const rect = canvas.getBoundingClientRect();
		return camera.screenToWorld(
			event.clientX - rect.left,
			event.clientY - rect.top,
		);
	}

	let pointerDownId = -1;

	const onPointerDown = (event: PointerEvent): void => {
		if (event.button !== 0) return;
		pointerDownId = event.pointerId;
		canvas.setPointerCapture(event.pointerId);
		event.preventDefault();
		const p = worldFromEvent(event);
		session.pointerDown(p.x, p.y, pointerMods(event));
	};

	const onPointerMove = (event: PointerEvent): void => {
		const p = worldFromEvent(event);
		session.pointerMove(p.x, p.y, { shift: event.shiftKey });
	};

	const onPointerUp = (event: PointerEvent): void => {
		if (event.pointerId !== pointerDownId) return;
		pointerDownId = -1;
		if (canvas.hasPointerCapture(event.pointerId)) {
			canvas.releasePointerCapture(event.pointerId);
		}
		session.pointerUp();
	};

	// pointercancel must not commit the in-progress gesture: drop pointer
	// ownership and cancel (matching the window-blur path) instead of routing
	// to the normal release handler.
	const onPointerCancel = (event: PointerEvent): void => {
		if (event.pointerId !== pointerDownId) return;
		pointerDownId = -1;
		if (canvas.hasPointerCapture(event.pointerId)) {
			canvas.releasePointerCapture(event.pointerId);
		}
		session.cancel();
	};

	// R is tracked as a held modifier (R-drag rotates), so keyup must clear it;
	// window blur clears it too, matching the gesture-cancel path.
	let rotateHeld = false;
	const syncRotate = (down: boolean): void => {
		rotateHeld = down;
	};

	const onKeyDown = (event: KeyboardEvent): void => {
		// Duplicate takes Ctrl/Cmd+D; the other shortcuts reject modifiers.
		// Inline label edit: keys are the label text itself. Enter and Escape
		// commit; printable characters append; Backspace deletes. This branch
		// runs FIRST — before the text-entry-target guard below — because a
		// tool radio keeps FOCUS after its label click, and the edit must own
		// the keyboard regardless of where focus sits (typing into a new
		// label with the radio focused is the normal text-tool flow). It also
		// runs before every shortcut (including Cmd/Ctrl+Z): a label edit
		// owns the keyboard, so undo/redo must not commit-then-undo the
		// label, and modified keys (Cmd+Z etc.) are swallowed, not typed.
		if (session.isEditingText()) {
			const action = classifyEditKey(event);
			if (action === "commit") {
				event.preventDefault();
				session.commitText();
			} else if (action === "backspace") {
				event.preventDefault();
				session.editTextBackspace();
			} else if (action === "insert") {
				event.preventDefault();
				session.editTextKey(event.key);
			}
			// "ignore" (modifier combos, F-keys, …): swallowed, edit continues.
			return;
		}
		// Text-entry targets keep their keys (matches camera-controls) — but
		// Escape always cancels: the joint-kind radios keep FOCUS after their
		// label click, and the pulley's three-click flow must cancel with the
		// radio still focused (a focused number input keeps its value too).
		if (
			event.target instanceof HTMLElement &&
			(event.target.tagName === "INPUT" ||
				event.target.tagName === "TEXTAREA" ||
				event.target.isContentEditable) &&
			event.code !== "Escape"
		)
			return;
		if (event.code === "KeyR" && !event.repeat) syncRotate(true);
		if ((event.ctrlKey || event.metaKey) && event.code === "KeyD") {
			event.preventDefault();
			session.requestDuplicate();
			return;
		}
		// Undo/redo: Cmd/Ctrl+Z (Cmd on mac, Ctrl elsewhere — both accepted);
		// Shift inverts to redo. Any in-progress gesture cancels first.
		if ((event.ctrlKey || event.metaKey) && event.code === "KeyZ") {
			event.preventDefault();
			session.cancel();
			if (event.shiftKey) undo?.redo();
			else undo?.undo();
			return;
		}
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		const tool = TOOL_KEYS[event.code];
		if (tool) {
			event.preventDefault();
			setToolAndSync(tool);
			return;
		}
		// S toggles static mode — a spawn property (terrain), not a tool.
		if (event.code === "KeyS" && !event.repeat) {
			toggleStaticMode();
			return;
		}
		if (event.code === "Delete" || event.code === "Backspace") {
			event.preventDefault();
			session.requestDelete();
			return;
		}
		// Enter closes the polygon the polygon tool is placing.
		if (event.code === "Enter") {
			session.closePolygon();
			return;
		}
		if (event.code === "Escape") {
			session.cancel();
			return;
		}
	};

	const onKeyUp = (event: KeyboardEvent): void => {
		if (event.code === "KeyR") syncRotate(false);
	};

	const pointerMods = (
		event: PointerEvent,
	): { shift: boolean; rotate: boolean } => ({
		shift: event.shiftKey,
		rotate: rotateHeld,
	});

	const onWindowBlur = (): void => {
		rotateHeld = false;
		session.cancel();
	};

	function applyCursor(): void {
		canvas.style.cursor = session.tool === "select" ? "" : CURSOR_DRAW;
	}

	canvas.addEventListener("pointerdown", onPointerDown);
	canvas.addEventListener("pointermove", onPointerMove);
	canvas.addEventListener("pointerup", onPointerUp);
	canvas.addEventListener("pointercancel", onPointerCancel);
	// Double-click re-enters a label's inline text edit (select tool). The
	// label lookup is injected (main.ts owns the pickable list); a miss is a
	// no-op so double-clicks on bodies/space keep their meaning.
	const onLabelDblClick = (event: MouseEvent): void => {
		if (session.tool !== "select") return;
		const p = worldFromEvent(event as unknown as PointerEvent);
		deps.onLabelDoubleClick?.(p.x, p.y);
	};
	if (deps.onLabelDoubleClick)
		canvas.addEventListener("dblclick", onLabelDblClick);
	window.addEventListener("keydown", onKeyDown);
	window.addEventListener("keyup", onKeyUp);
	window.addEventListener("blur", onWindowBlur);

	syncToolbar();
	syncStaticMode();
	applyCursor();
	return () => {
		canvas.removeEventListener("pointerdown", onPointerDown);
		canvas.removeEventListener("pointermove", onPointerMove);
		canvas.removeEventListener("pointerup", onPointerUp);
		canvas.removeEventListener("pointercancel", onPointerCancel);
		window.removeEventListener("keydown", onKeyDown);
		window.removeEventListener("keyup", onKeyUp);
		window.removeEventListener("blur", onWindowBlur);
	};
}
