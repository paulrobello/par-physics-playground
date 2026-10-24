/**
 * Sim control cluster in the top bar (D15): pause/play toggle (P), single-step
 * (Period), reset world. Pure helpers (key map, pause-button state) are
 * exported for unit tests; `attachSimControls` is the DOM wiring. Reset
 * semantics live with the caller via `onReset` (cancel any active drag before
 * tearing the registry down).
 */
import type { SimClock } from "./clock";

/** Actions the sim-control keyboard shortcuts map to. */
export type SimControlAction = "toggle-pause" | "step";

/**
 * Keyboard shortcuts: P toggles pause/play, Period steps one tick. Space is
 * taken by camera pan-drag, so it was unavailable; P and "." are unused by the
 * tool shortcuts (V/B/C) and camera (Space, Escape).
 */
export const SIM_CONTROL_KEYS: Readonly<Record<string, SimControlAction>> = {
	KeyP: "toggle-pause",
	Period: "step",
};

export interface SimButtonState {
	readonly label: string;
	readonly pressed: boolean;
}

/**
 * Pause-button presentation for a given paused state: while paused the button
 * offers Play (pressed = true, a toggle showing the current paused state),
 * while running it offers Pause.
 */
export function pauseButtonState(paused: boolean): SimButtonState {
	return paused
		? { label: "Play simulation (P)", pressed: true }
		: { label: "Pause simulation (P)", pressed: false };
}

export interface SimControlsDeps {
	topBar: HTMLElement;
	clock: SimClock;
	/** Clears dynamic bodies; the caller cancels any active drag first. */
	onReset: () => void;
}

/** Attaches click + keyboard wiring to the top-bar cluster. Returns a cleanup. */
export function attachSimControls(deps: SimControlsDeps): () => void {
	const { topBar, clock, onReset } = deps;

	const pauseButton =
		topBar.querySelector<HTMLButtonElement>('[data-sim="pause"]');
	const stepButton =
		topBar.querySelector<HTMLButtonElement>('[data-sim="step"]');
	const resetButton =
		topBar.querySelector<HTMLButtonElement>('[data-sim="reset"]');
	if (!pauseButton || !stepButton || !resetButton)
		throw new Error("sim control buttons missing from the top bar");
	// tsgo does not carry narrowing into closures; alias with explicit types.
	const pauseBtn: HTMLButtonElement = pauseButton;
	const stepBtn: HTMLButtonElement = stepButton;
	const resetBtn: HTMLButtonElement = resetButton;

	function syncPause(): void {
		const { label, pressed } = pauseButtonState(clock.isPaused);
		pauseBtn.setAttribute("aria-label", label);
		pauseBtn.title = label;
		pauseBtn.setAttribute("aria-pressed", pressed ? "true" : "false");
	}

	const togglePause = (): void => {
		clock.setPaused(!clock.isPaused);
		syncPause();
	};

	const stepOnce = (): void => clock.stepOnce();
	const reset = (): void => onReset();

	pauseBtn.addEventListener("click", togglePause);
	stepBtn.addEventListener("click", stepOnce);
	resetBtn.addEventListener("click", reset);

	const onKeyDown = (event: KeyboardEvent): void => {
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		// Text-entry targets keep their keys (matches camera/tool controls).
		if (
			event.target instanceof HTMLElement &&
			(event.target.tagName === "INPUT" ||
				event.target.tagName === "TEXTAREA" ||
				event.target.isContentEditable)
		)
			return;
		const action = SIM_CONTROL_KEYS[event.code];
		if (!action) return;
		event.preventDefault();
		if (action === "toggle-pause") togglePause();
		else clock.stepOnce();
	};

	window.addEventListener("keydown", onKeyDown);

	syncPause();
	return () => {
		pauseBtn.removeEventListener("click", togglePause);
		stepBtn.removeEventListener("click", stepOnce);
		resetBtn.removeEventListener("click", reset);
		window.removeEventListener("keydown", onKeyDown);
	};
}
