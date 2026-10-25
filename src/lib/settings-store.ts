/**
 * Persisted app settings (Paul, 2026-10-24): every user-adjustable control
 * survives a reload. localStorage under a versioned key, stored as a JSON
 * object merged field-wise over DEFAULT_SETTINGS on load — corrupt JSON,
 * missing fields, and out-of-range values degrade to safe defaults (the
 * first-run.ts pattern: pure functions + injected storage so unit tests need
 * no DOM).
 */
import { clampTimeScale } from "./sim-controls";
import type { ToolId } from "./tools";
import { isToolId } from "./tools";

/** The persisted settings object. Versioned key below; shape changes move to v2. */
export interface PersistedSettings {
	/** Time-scale slider, clamped 0.25–2 by the store on load. */
	timeScale: number;
	/** Gravity as the controls express it: angle° clockwise on screen from down, magnitude m/s². */
	gravityAngleDeg: number;
	gravityMagnitude: number;
	/** Draw options (header): grid size + toggles. */
	gridSize: number;
	gridSnap: boolean;
	circleFromCenter: boolean;
	constrainBox: boolean;
	angleSnap: boolean;
	/** Static spawn mode (S / toolbar toggle). */
	staticMode: boolean;
	/** Status-bar FPS readout visibility. */
	fpsVisible: boolean;
	/** X-ray view: bodies draw translucent so occluded shapes stay visible. */
	xRay: boolean;
	/** Active tool. */
	tool: ToolId;
}

/** Storage surface needed (window.localStorage satisfies it). */
export interface SettingsStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

export const SETTINGS_STORAGE_KEY = "ppg.settings.v1";

/**
 * Defaults mirror the control markup exactly (grid 32, gravity 9.81 down,
 * 1.00× speed) so a fresh boot with empty storage matches today's behavior.
 */
export const DEFAULT_SETTINGS: PersistedSettings = {
	timeScale: 1,
	gravityAngleDeg: 0,
	gravityMagnitude: 9.81,
	gridSize: 32,
	gridSnap: false,
	circleFromCenter: false,
	constrainBox: false,
	angleSnap: false,
	staticMode: false,
	fpsVisible: false,
	xRay: false,
	tool: "select",
};

/** Field validators: anything not representable falls back to the default. */
const num = (v: unknown): number | null =>
	typeof v === "number" && Number.isFinite(v) ? v : null;

const bool = (v: unknown, fallback: boolean): boolean =>
	typeof v === "boolean" ? v : fallback;

const clampGravityAngle = (raw: number): number => {
	if (!Number.isFinite(raw)) return DEFAULT_SETTINGS.gravityAngleDeg;
	const wrapped = raw % 360;
	return wrapped < 0 ? wrapped + 360 : wrapped;
};

const clampGravityMagnitude = (raw: number): number =>
	Number.isFinite(raw) && raw >= 0
		? Math.min(raw, 10_000)
		: DEFAULT_SETTINGS.gravityMagnitude;

const clampGridSize = (raw: number): number =>
	Number.isFinite(raw) && raw >= 2
		? Math.min(Math.round(raw), 512)
		: DEFAULT_SETTINGS.gridSize;

/**
 * Load the stored settings, merged field-wise over the defaults. Corrupt
 * JSON, a non-object payload, or a bad field value yields the default for
 * that field (or the whole object) — a bad payload must never throw at boot.
 */
export function loadSettings(storage: SettingsStorage): PersistedSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? "null");
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
	if (typeof parsed !== "object" || parsed === null) {
		return { ...DEFAULT_SETTINGS };
	}
	const raw = parsed as Record<string, unknown>;
	return {
		timeScale: clampTimeScale(num(raw.timeScale) ?? DEFAULT_SETTINGS.timeScale),
		gravityAngleDeg: clampGravityAngle(
			num(raw.gravityAngleDeg) ?? DEFAULT_SETTINGS.gravityAngleDeg,
		),
		gravityMagnitude: clampGravityMagnitude(
			num(raw.gravityMagnitude) ?? DEFAULT_SETTINGS.gravityMagnitude,
		),
		gridSize: clampGridSize(num(raw.gridSize) ?? DEFAULT_SETTINGS.gridSize),
		gridSnap: bool(raw.gridSnap, DEFAULT_SETTINGS.gridSnap),
		circleFromCenter: bool(
			raw.circleFromCenter,
			DEFAULT_SETTINGS.circleFromCenter,
		),
		constrainBox: bool(raw.constrainBox, DEFAULT_SETTINGS.constrainBox),
		angleSnap: bool(raw.angleSnap, DEFAULT_SETTINGS.angleSnap),
		staticMode: bool(raw.staticMode, DEFAULT_SETTINGS.staticMode),
		fpsVisible: bool(raw.fpsVisible, DEFAULT_SETTINGS.fpsVisible),
		xRay: bool(raw.xRay, DEFAULT_SETTINGS.xRay),
		tool:
			typeof raw.tool === "string" && isToolId(raw.tool)
				? raw.tool
				: DEFAULT_SETTINGS.tool,
	};
}

/**
 * Merge `patch` over the stored settings and write them back. Per-change
 * saves are tiny patches; the store merges so independent writers (sim
 * controls, draw options, tool rail) never erase each other's fields.
 */
export function saveSettings(
	storage: SettingsStorage,
	patch: Partial<PersistedSettings>,
): void {
	const current = loadSettings(storage);
	const merged = { ...current, ...patch };
	try {
		storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(merged));
	} catch {
		// Private-browsing quota/permission failures degrade to session-only
		// settings — never break the interaction that triggered the save.
	}
}
