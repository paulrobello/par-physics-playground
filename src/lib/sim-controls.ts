/**
 * Sim control cluster in the top bar (D15): pause/play toggle (P), single-step
 * (Period), reset world, gravity (direction + magnitude, with presets), and
 * time-scale. Pure helpers (key map, pause-button state, gravity vector math,
 * time-scale clamping, preset table) are exported for unit tests;
 * `attachSimControls` is the DOM wiring. Reset semantics live with the caller
 * via `onReset` (cancel any active drag before tearing the registry down).
 */
import type { SimClock } from "./clock";
import { paintRangeFill } from "./range-fill";
import type { PhysicsWorld } from "./world";

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

/**
 * Gravity direction convention (y-down world, world.ts): the angle is measured
 * in degrees CLOCKWISE ON SCREEN from "down" — 0° points down (+y), 90° right
 * (+x), 180° up (−y), 270° left. `gravityVector` maps (angle°, magnitude) to
 * the Rapier gravity vector; the dial/slider mapping the panel uses is this
 * identity (slider degrees are vector degrees), pinned by unit tests.
 */
export function gravityVector(
	angleDeg: number,
	magnitude: number,
): { x: number; y: number } {
	const rad = (angleDeg * Math.PI) / 180;
	return { x: magnitude * Math.sin(rad), y: magnitude * Math.cos(rad) };
}

/**
 * Inverse of {@link gravityVector}: maps a live gravity vector back to
 * (angle° clockwise on screen from down, magnitude) so a non-UI gravity
 * write (debug API) can sync the sliders, mirroring the TimeScale listener
 * pattern. The zero vector reads as 0° / 0.
 */
export function gravityFromVector(v: { x: number; y: number }): {
	angleDeg: number;
	magnitude: number;
} {
	const magnitude = Math.hypot(v.x, v.y);
	let angleDeg = (Math.atan2(v.x, v.y) * 180) / Math.PI;
	if (!Number.isFinite(angleDeg)) angleDeg = 0;
	if (angleDeg < 0) angleDeg += 360;
	return { angleDeg, magnitude };
}

/** Gravity presets (PRD D5): id, button label, direction (°), magnitude (m/s²). */
export interface GravityPreset {
	readonly id: "down" | "zero-g" | "moon";
	readonly label: string;
	readonly angleDeg: number;
	/** Magnitude in m/s²; 0 for zero-g, 1.62 for lunar surface gravity. */
	readonly magnitude: number;
}

export const GRAVITY_PRESETS: readonly GravityPreset[] = [
	{ id: "down", label: "Down", angleDeg: 0, magnitude: 9.81 },
	{ id: "zero-g", label: "0g", angleDeg: 0, magnitude: 0 },
	{ id: "moon", label: "Moon", angleDeg: 0, magnitude: 1.62 },
];

/** Time-scale slider bounds: 0.25×–2× per the PRD; anything else clamps in. */
export const TIME_SCALE_MIN = 0.25;
export const TIME_SCALE_MAX = 2;

/**
 * Clamp a raw slider/API value into the legal time-scale range; a non-finite
 * value falls back to 1× (the default) rather than a bound.
 */
export function clampTimeScale(scale: number): number {
	if (!Number.isFinite(scale)) return 1;
	return Math.min(TIME_SCALE_MAX, Math.max(TIME_SCALE_MIN, scale));
}

/**
 * Shared time-scale state (0.25×–2×): the accumulator FEED RATE only — the
 * rAF frame delta is multiplied by it before `advanceRealTime`, so the fixed
 * 60Hz tick and the deterministic `advanceSimTime` path are untouched. A
 * class with change listeners (not a bare mutable) so a debug-API write keeps
 * the slider in sync, matching how the user moved it.
 */
export class TimeScale {
	private valueInternal = 1;
	private readonly listeners = new Set<(value: number) => void>();

	get value(): number {
		return this.valueInternal;
	}

	set(raw: number): void {
		const clamped = clampTimeScale(raw);
		if (clamped === this.valueInternal) return;
		this.valueInternal = clamped;
		for (const listener of this.listeners) listener(clamped);
	}

	subscribe(listener: (value: number) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export interface SimControlsDeps {
	topBar: HTMLElement;
	clock: SimClock;
	/** Live world: gravity changes apply immediately (sleeping bodies wake). */
	world: PhysicsWorld;
	/** Shared time-scale state; the rAF feed multiplies its value in. */
	timeScale: TimeScale;
	/** Clears dynamic bodies; the caller cancels any active drag first. */
	onReset: () => void;
	isEditingText?: () => boolean;
	/** Fired after the pause toggle flips — the settings save hook. */
	onPauseChange?: ((paused: boolean) => void) | undefined;
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

	// Gravity + time-scale controls (P3-T3): optional elements, so the module
	// keeps working against the minimal P1 markup (unit-less attach tests).
	const angleInput = topBar.querySelector<HTMLInputElement>(
		'[data-sim="gravity-angle"]',
	);
	const magInput = topBar.querySelector<HTMLInputElement>(
		'[data-sim="gravity-mag"]',
	);
	const angleOut = topBar.querySelector<HTMLElement>(
		'[data-sim="gravity-angle-out"]',
	);
	const magOut = topBar.querySelector<HTMLElement>(
		'[data-sim="gravity-mag-out"]',
	);
	const timeInput = topBar.querySelector<HTMLInputElement>(
		'[data-sim="time-scale"]',
	);
	const timeOut = topBar.querySelector<HTMLElement>(
		'[data-sim="time-scale-out"]',
	);
	const presetButtons = [
		...topBar.querySelectorAll<HTMLButtonElement>("[data-gravity-preset]"),
	];

	function syncPause(): void {
		const { label, pressed } = pauseButtonState(clock.isPaused);
		pauseBtn.setAttribute("aria-label", label);
		pauseBtn.dataset.tip = label;
		pauseBtn.setAttribute("aria-pressed", pressed ? "true" : "false");
	}

	const togglePause = (): void => {
		clock.setPaused(!clock.isPaused);
		syncPause();
		deps.onPauseChange?.(clock.isPaused);
	};

	const stepOnce = (): void => clock.stepOnce();

	// Reset confirms (Paul, 2026-10-25): the first click ARMS the button for
	// 3s — danger styling + a confirm tooltip — and only a second click
	// inside the window wipes the world; timeout or cleanup disarms. The
	// wipe is undo-history-clearing, so a stray click must not be lethal.
	let resetArmed = false;
	let disarmTimer: ReturnType<typeof setTimeout> | undefined;
	const disarmReset = (): void => {
		resetArmed = false;
		clearTimeout(disarmTimer);
		resetBtn.classList.remove("armed");
		resetBtn.dataset.tip = "Reset world";
		resetBtn.setAttribute("aria-label", "Reset world");
	};
	const reset = (): void => {
		if (!resetArmed) {
			resetArmed = true;
			resetBtn.classList.add("armed");
			resetBtn.dataset.tip = "Click again to confirm reset";
			resetBtn.setAttribute("aria-label", "Confirm world reset");
			clearTimeout(disarmTimer);
			disarmTimer = setTimeout(disarmReset, 3000);
			return;
		}
		disarmReset();
		onReset();
	};

	pauseBtn.addEventListener("click", togglePause);
	stepBtn.addEventListener("click", stepOnce);
	resetBtn.addEventListener("click", reset);

	// Gravity (P3-T3): sliders and presets apply straight to the live world;
	// deliberately no keyboard shortcuts — modifier-free single keys are all
	// taken (V/B/C/G/L/F/T/S/P/.), and the presets are toolbar buttons.
	const applyGravity = (): void => {
		if (!angleInput || !magInput) return;
		const vector = gravityVector(
			Number(angleInput.value),
			Number(magInput.value),
		);
		deps.world.setGravity(vector.x, vector.y);
	};

	const syncGravityOutputs = (): void => {
		if (angleOut && angleInput) angleOut.textContent = `${angleInput.value}°`;
		if (magOut && magInput)
			magOut.textContent = Number(magInput.value).toFixed(2);
		if (angleInput) paintRangeFill(angleInput);
		if (magInput) paintRangeFill(magInput);
	};

	const onGravityInput = (): void => {
		syncGravityOutputs();
		applyGravity();
	};

	const presetHandlers: { button: HTMLButtonElement; handler: () => void }[] =
		[];
	if (angleInput && magInput) {
		angleInput.addEventListener("input", onGravityInput);
		magInput.addEventListener("input", onGravityInput);
		paintRangeFill(angleInput);
		paintRangeFill(magInput);
		for (const button of presetButtons) {
			const handler = (): void => {
				const preset = GRAVITY_PRESETS.find(
					(p) => p.id === button.dataset.gravityPreset,
				);
				if (!preset) return;
				angleInput.value = String(preset.angleDeg);
				magInput.value = String(preset.magnitude);
				onGravityInput();
			};
			presetHandlers.push({ button, handler });
			button.addEventListener("click", handler);
		}
	}

	// Fix-wave F4: a non-UI gravity write (debug API) must not leave the
	// sliders stale — moving one afterwards would apply the stale other value.
	// Mirrors the TimeScale listener pattern: sync the inputs from every world
	// gravity change. Skip when the sliders already express this vector (the
	// slider→world path re-entering would snap the inputs to their steps and
	// drift the value, e.g. 9.81 → 9.80 → 9.81 …).
	const syncGravityUi = (g: { x: number; y: number }): void => {
		if (!angleInput || !magInput) return;
		const { angleDeg, magnitude } = gravityFromVector(g);
		if (
			Math.abs(Number(angleInput.value) - angleDeg) <= 0.5 &&
			Math.abs(Number(magInput.value) - magnitude) <= 0.005
		)
			return;
		angleInput.value = String(Math.round(angleDeg) % 360);
		magInput.value = String(magnitude);
		syncGravityOutputs();
	};
	const unsubGravity = deps.world.subscribeGravity(syncGravityUi);

	// Time scale (P3-T3): scales the accumulator FEED only — the fixed 60Hz
	// tick and the deterministic advanceTime path are untouched (the e2e pins
	// advanceTime exactness with a non-1× scale set).
	const syncTimeScaleUi = (value: number): void => {
		if (timeInput) {
			timeInput.value = String(value);
			paintRangeFill(timeInput);
		}
		if (timeOut) timeOut.textContent = `${value.toFixed(2)}×`;
	};
	const onTimeInput = (): void => {
		deps.timeScale.set(Number(timeInput?.value));
	};
	if (timeInput) {
		timeInput.addEventListener("input", onTimeInput);
		syncTimeScaleUi(deps.timeScale.value);
	}
	const unsubTimeScale = deps.timeScale.subscribe(syncTimeScaleUi);

	const onKeyDown = (event: KeyboardEvent): void => {
		if (deps.isEditingText?.() || event.defaultPrevented) return;
		if (event.ctrlKey || event.metaKey || event.altKey) return;
		// Text-entry targets keep their keys; non-text-entry controls do not —
		// a tool radio keeps FOCUS after its label click and must not swallow
		// P / Period. Escape-like exemptions: none needed here (P and Period
		// have no cancel meaning).
		const target = event.target;
		const isTextEntryTarget =
			target instanceof HTMLElement &&
			(target.tagName === "TEXTAREA" ||
				target.isContentEditable ||
				(target instanceof HTMLInputElement &&
					!["radio", "checkbox", "button", "range"].includes(target.type)));
		if (isTextEntryTarget) return;
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
		if (angleInput) angleInput.removeEventListener("input", onGravityInput);
		if (magInput) magInput.removeEventListener("input", onGravityInput);
		for (const { button, handler } of presetHandlers)
			button.removeEventListener("click", handler);
		if (timeInput) timeInput.removeEventListener("input", onTimeInput);
		unsubTimeScale();
		unsubGravity();
		clearTimeout(disarmTimer);
		window.removeEventListener("keydown", onKeyDown);
	};
}
