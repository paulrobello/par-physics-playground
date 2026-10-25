/**
 * Settings store unit tests: round-trip and merge semantics, corrupt-payload
 * fallback, per-field validation/clamping (a bad stored value must degrade to
 * a safe default, never throw), and storage-write failure tolerance.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_SETTINGS,
	loadSettings,
	SETTINGS_STORAGE_KEY,
	type SettingsStorage,
	saveSettings,
} from "../../src/lib/settings-store";

/** Fresh in-memory storage per test (the window.localStorage surface). */
function makeStorage(initial: Record<string, string> = {}): SettingsStorage {
	const map = new Map<string, string>(Object.entries(initial));
	return {
		getItem: (key) => map.get(key) ?? null,
		setItem: (key, value) => {
			map.set(key, value);
		},
	};
}

describe("settings store", () => {
	let storage: SettingsStorage;

	beforeEach(() => {
		storage = makeStorage();
	});

	test("empty storage loads the defaults", () => {
		expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
	});

	test("save then load round-trips a patch", () => {
		saveSettings(storage, { timeScale: 1.5, tool: "circle" });
		const settings = loadSettings(storage);
		expect(settings.timeScale).toBe(1.5);
		expect(settings.tool).toBe("circle");
	});

	test("a second save of one field preserves the other", () => {
		saveSettings(storage, { gridSize: 64 });
		saveSettings(storage, { fpsVisible: true });
		const settings = loadSettings(storage);
		expect(settings.gridSize).toBe(64);
		expect(settings.fpsVisible).toBe(true);
	});

	test("corrupt JSON degrades to the defaults", () => {
		storage.setItem(SETTINGS_STORAGE_KEY, "{not json");
		expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
	});

	test("non-object JSON degrades to the defaults", () => {
		storage.setItem(SETTINGS_STORAGE_KEY, "42");
		expect(loadSettings(storage)).toEqual(DEFAULT_SETTINGS);
	});

	test("out-of-range values clamp to legal ranges", () => {
		storage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({
				timeScale: 99,
				gridSize: 100000,
				gravityAngleDeg: -30,
				gravityMagnitude: 50_000,
			}),
		);
		const s = loadSettings(storage);
		expect(s.timeScale).toBe(2);
		expect(s.gridSize).toBe(512);
		expect(s.gravityAngleDeg).toBe(330);
		expect(s.gravityMagnitude).toBe(10_000);
	});

	test("invalid field types fall back per-field", () => {
		storage.setItem(
			SETTINGS_STORAGE_KEY,
			JSON.stringify({
				timeScale: "fast",
				gridSnap: "yes",
				tool: "banana",
				gravityAngleDeg: "up",
			}),
		);
		const s = loadSettings(storage);
		expect(s.timeScale).toBe(1);
		expect(s.gridSnap).toBe(false);
		expect(s.tool).toBe("select");
		expect(s.gravityAngleDeg).toBe(0);
	});

	test("a throwing setItem never breaks the caller", () => {
		const failing: SettingsStorage = {
			getItem: () => null,
			setItem: () => {
				throw new Error("quota");
			},
		};
		expect(() => saveSettings(failing, { tool: "box" })).not.toThrow();
	});
});
