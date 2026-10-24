/**
 * Input wiring for the camera: wheel zoom (anchored at the cursor), trackpad
 * pinch zoom (ctrl+wheel), horizontal two-finger trackpad pan (wheel with a
 * deltaX component), space-drag and middle-drag pan. Attaches listeners to the
 * canvas (wheel/pointer) and window (keyboard); returns a detach function.
 * The camera is pure state — controls only mutate it.
 */
import { type Camera, WHEEL_ZOOM_SENSITIVITY } from "./camera";

/** deltaY (CSS px) per line for Firefox line-mode wheel events. */
const LINE_HEIGHT_PX = 16;

/** Canvas cursor while space-pan is armed. */
const CURSOR_GRAB = "grab";
const CURSOR_GRABBING = "grabbing";

/**
 * The cursor camera-controls restores when its own override ends (key released,
 * drag finished, window blurred). The interaction layer installs the tool
 * cursor here so the camera never stomps a draw tool's crosshair to the arrow.
 */
export type RestingCursorFn = () => string;

export function attachCameraControls(
	canvas: HTMLCanvasElement,
	camera: Camera,
	getRestingCursor?: RestingCursorFn,
): () => void {
	let spaceHeld = false;
	let dragging = false;
	let lastX = 0;
	let lastY = 0;
	const restingCursor = (): string => getRestingCursor?.() ?? "";

	/**
	 * Space pressed while an interactive HUD element has focus must keep the
	 * browser's native activation (button press, select open) — the camera
	 * neither arms space-pan nor claims the key. Text-entry targets
	 * (input/textarea/contenteditable) are included so typing a space keeps
	 * typing a space.
	 */
	const isInteractiveTarget = (target: EventTarget | null): boolean =>
		target instanceof HTMLElement &&
		(target.isContentEditable ||
			target.closest("button, a, select, input, textarea, [role=toolbar]") !==
				null);

	const onKeyDown = (event: KeyboardEvent): void => {
		if (
			event.code !== "Space" ||
			event.repeat ||
			isInteractiveTarget(event.target)
		)
			return;
		spaceHeld = true;
		event.preventDefault();
		if (!dragging) canvas.style.cursor = CURSOR_GRAB;
	};

	const onKeyUp = (event: KeyboardEvent): void => {
		if (event.code !== "Space") return;
		spaceHeld = false;
		if (!dragging) canvas.style.cursor = restingCursor();
	};

	const onWheel = (event: WheelEvent): void => {
		event.preventDefault();
		if (event.deltaX !== 0 && !event.ctrlKey) {
			// Horizontal scroll component = two-finger trackpad pan.
			camera.panBy(event.deltaX, 0);
			return;
		}
		// Plain wheel and trackpad pinch (ctrl+wheel) both zoom, anchored at the
		// cursor; pinch events carry zoom in deltaY.
		const rect = canvas.getBoundingClientRect();
		const dy =
			event.deltaMode === 1 ? event.deltaY * LINE_HEIGHT_PX : event.deltaY;
		camera.zoomAt(
			event.clientX - rect.left,
			event.clientY - rect.top,
			Math.exp(-dy * WHEEL_ZOOM_SENSITIVITY),
		);
	};

	const onPointerDown = (event: PointerEvent): void => {
		const panButton = event.button === 1 || (spaceHeld && event.button === 0);
		if (!panButton) return;
		event.stopImmediatePropagation();
		dragging = true;
		lastX = event.clientX;
		lastY = event.clientY;
		canvas.setPointerCapture(event.pointerId);
		event.preventDefault();
		canvas.style.cursor = CURSOR_GRABBING;
	};

	const onPointerMove = (event: PointerEvent): void => {
		if (!dragging) return;
		camera.panBy(event.clientX - lastX, event.clientY - lastY);
		lastX = event.clientX;
		lastY = event.clientY;
	};

	const endDrag = (event: PointerEvent): void => {
		if (!dragging) return;
		dragging = false;
		canvas.style.cursor = spaceHeld ? CURSOR_GRAB : restingCursor();
		if (canvas.hasPointerCapture(event.pointerId))
			canvas.releasePointerCapture(event.pointerId);
	};

	const onWindowBlur = (): void => {
		spaceHeld = false;
		dragging = false;
		canvas.style.cursor = restingCursor();
	};

	canvas.addEventListener("wheel", onWheel, { passive: false });
	canvas.addEventListener("pointerdown", onPointerDown);
	window.addEventListener("pointermove", onPointerMove);
	window.addEventListener("pointerup", endDrag);
	window.addEventListener("pointercancel", endDrag);
	window.addEventListener("keydown", onKeyDown);
	window.addEventListener("keyup", onKeyUp);
	window.addEventListener("blur", onWindowBlur);

	return () => {
		canvas.removeEventListener("wheel", onWheel);
		canvas.removeEventListener("pointerdown", onPointerDown);
		window.removeEventListener("pointermove", onPointerMove);
		window.removeEventListener("pointerup", endDrag);
		window.removeEventListener("pointercancel", endDrag);
		window.removeEventListener("keydown", onKeyDown);
		window.removeEventListener("keyup", onKeyUp);
		window.removeEventListener("blur", onWindowBlur);
	};
}
