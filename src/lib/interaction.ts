/**
 * DOM wiring for the tool system: toolbar buttons (Select V, Box B, Circle C),
 * keyboard shortcuts, and canvas pointer events feeding the ToolSession. The
 * session's commands are applied to the PhysicsWorld here (spawn + mouse
 * joint). Must be attached AFTER attachCameraControls: camera-controls claims
 * space-drag and middle-drag via stopImmediatePropagation, so this layer only
 * ever sees plain left-button presses.
 */
import type { Camera } from "./camera";
import {
	TOOL_KEYS,
	type ToolId,
	type ToolSession,
	type ToolSessionEvents,
} from "./tools";
import type { DocumentId, PhysicsWorld } from "./world";

type DragJoint = ReturnType<PhysicsWorld["startMouseJoint"]>;

let nextBodyId = 1;

/** Fresh document id for a newly spawned body: body-1, body-2, ... */
export function freshBodyId(): DocumentId {
	const id = `body-${nextBodyId}`;
	nextBodyId += 1;
	return id;
}

/** Builds the session-event to world-command wiring (spawns + drag joint). */
export function createToolEvents(
	world: PhysicsWorld,
): ToolSessionEvents & { activeJoint: DragJoint | null } {
	const events: ToolSessionEvents & {
		activeJoint: DragJoint | null;
		/** Body the activeJoint drags, if any; cleared alongside the joint. */
		draggedId: DocumentId | undefined;
		/** Cull-seam handler; also installed on the world below. */
		onCull(id: DocumentId): void;
	} = {
		activeJoint: null,
		// F5 seam: when step() culls the dragged body, Rapier destroys the
		// drag joint with it, so the retained handle is stale — drop it rather
		// than touching a removed joint on the next move/release.
		draggedId: undefined,
		onCull(id: DocumentId): void {
			if (this.draggedId === id) {
				this.activeJoint = null;
				this.draggedId = undefined;
			}
		},
		onSpawnBox({ cx, cy, halfWidth, halfHeight }) {
			world.spawnBox(freshBodyId(), cx, cy, halfWidth, halfHeight);
		},
		onSpawnCircle({ cx, cy, radius }) {
			world.spawnCircle(freshBodyId(), cx, cy, radius);
		},
		onDragStart(id, grab) {
			const body = world.bodies.get(id);
			if (!body) return;
			this.activeJoint = world.startMouseJoint(body, grab);
			this.draggedId = id;
		},
		onDragMove(target) {
			if (this.activeJoint)
				world.moveMouseJointTarget(this.activeJoint, target);
		},
		onDragEnd() {
			if (this.activeJoint) {
				world.endMouseJoint(this.activeJoint);
				this.activeJoint = null;
			}
			this.draggedId = undefined;
		},
	};
	// Arrow wrapper: a bare `world.onCull = events.onCull` would run the
	// handler with the world as `this`, missing the events object's fields.
	world.onCull = (id) => events.onCull(id);
	return events;
}

export interface ToolControlsDeps {
	toolbar: HTMLElement;
	canvas: HTMLCanvasElement;
	camera: Camera;
	session: ToolSession;
}

/** Cursor while a draw tool is armed (the camera's resting cursor, too). */
export const CURSOR_DRAW = "crosshair";

export function attachToolControls(deps: ToolControlsDeps): () => void {
	const { toolbar, canvas, camera, session } = deps;

	const toolButtons = Array.from(
		toolbar.querySelectorAll<HTMLButtonElement>("[data-tool]"),
	);
	for (const button of toolButtons) {
		button.addEventListener("click", () => {
			const tool = button.dataset.tool;
			if (tool === "select" || tool === "box" || tool === "circle") {
				setToolAndSync(tool);
			}
		});
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
		session.pointerDown(p.x, p.y);
	};

	const onPointerMove = (event: PointerEvent): void => {
		const p = worldFromEvent(event);
		session.pointerMove(p.x, p.y);
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

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		// Text-entry targets keep their keys (matches camera-controls).
		if (
			event.target instanceof HTMLElement &&
			(event.target.tagName === "INPUT" ||
				event.target.tagName === "TEXTAREA" ||
				event.target.isContentEditable)
		)
			return;
		const tool = TOOL_KEYS[event.code];
		if (tool) {
			event.preventDefault();
			setToolAndSync(tool);
			return;
		}
		if (event.code === "Escape") {
			session.cancel();
			return;
		}
	};

	const onWindowBlur = (): void => {
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
	window.addEventListener("blur", onWindowBlur);

	syncToolbar();
	applyCursor();
	return () => {
		canvas.removeEventListener("pointerdown", onPointerDown);
		canvas.removeEventListener("pointermove", onPointerMove);
		canvas.removeEventListener("pointerup", onPointerUp);
		canvas.removeEventListener("pointercancel", onPointerCancel);
		window.removeEventListener("keydown", onKeyDown);
		window.removeEventListener("blur", onWindowBlur);
	};
}
