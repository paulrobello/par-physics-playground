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
import { MATERIAL_DEFAULT_ID } from "./material";
import {
	beamFromSegment,
	classifyEditKey,
	DUPLICATE_OFFSET,
	isToolId,
	TOOL_KEYS,
	type ToolId,
	type ToolSession,
	type ToolSessionEvents,
} from "./tools";
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
				case "chain":
					for (let i = 1; i < result.points.length; i++) {
						const a = result.points[i - 1] as { x: number; y: number };
						const b = result.points[i] as { x: number; y: number };
						const beam = beamFromSegment(a.x, a.y, b.x, b.y);
						world.spawnEntity({
							...defaultBody(
								freshBodyId(),
								{
									kind: "box",
									halfWidth: beam.halfLength,
									halfHeight: beam.halfWidth,
								},
								beam.cx,
								beam.cy,
								beam.rot,
							),
							isStatic,
							materialId,
						});
					}
					break;
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
				if (e) world.doc.setTransform(id, e.x + dx, e.y + dy, e.rot);
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
		onRotateEnd() {
			// Rotate-end boundary (release, cancel, or tool switch).
			recordAction();
		},
		onRotateStart() {
			beginAction();
			this.rotateBase.clear();
			for (const id of selectedIds()) {
				const rot = world.bodyRotation(id) ?? world.doc.get(id)?.rot;
				if (rot !== undefined) this.rotateBase.set(id, rot);
			}
			// Rotation overrides are kinematic; works paused or running.
		},
		onRotate(delta) {
			for (const [id, base] of this.rotateBase) {
				if (world.bodies.has(id)) world.rotateBody(id, base + delta);
				else {
					const e = world.doc.get(id);
					if (e) world.doc.setTransform(id, e.x, e.y, base + delta);
				}
			}
		},
		onDelete(ids) {
			beginAction();
			for (const id of ids) world.removeBody(id);
			recordAction();
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
}

/** Cursor while a draw tool is armed (the camera's resting cursor, too). */
export const CURSOR_DRAW = "crosshair";

export function attachToolControls(deps: ToolControlsDeps): () => void {
	const { toolbar, canvas, camera, session, undo } = deps;

	const toolButtons = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>("[data-tool]"),
	);
	for (const button of toolButtons) {
		button.addEventListener("click", () => {
			const tool = button.dataset.tool ?? "";
			if (isToolId(tool)) {
				setToolAndSync(tool);
			}
		});
	}

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
		for (const button of toolButtons) {
			const active = button.dataset.tool === session.tool;
			button.classList.toggle("active", active);
			button.setAttribute("aria-pressed", active ? "true" : "false");
		}
	}

	const setToolAndSync = (tool: ToolId): void => {
		session.setTool(tool);
		syncToolbar();
		applyCursor();
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
		// Text-entry targets keep their keys (matches camera-controls).
		if (
			event.target instanceof HTMLElement &&
			(event.target.tagName === "INPUT" ||
				event.target.tagName === "TEXTAREA" ||
				event.target.isContentEditable)
		)
			return;
		// Inline label edit: keys are the label text itself. Enter and Escape
		// commit; printable characters append; Backspace deletes. The branch
		// runs BEFORE every shortcut (including Cmd/Ctrl+Z): a label edit owns
		// the keyboard, so undo/redo must not commit-then-undo the label, and
		// modified keys (Cmd+Z etc.) are swallowed, not typed.
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
	window.addEventListener("keydown", onKeyDown);
	window.addEventListener("keyup", onKeyUp);
	window.addEventListener("blur", onWindowBlur);

	syncToolbar();
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
