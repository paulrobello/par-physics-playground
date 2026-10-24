/**
 * P4-T5 first-run flag (PRD D16): a persisted boolean in injected storage —
 * true on first run, false afterwards, and marking re-arms nothing.
 */
import { describe, expect, test } from "bun:test";
import {
	FIRST_RUN_STORAGE,
	markDemoSceneSeen,
	shouldLoadDemoScene,
} from "../../src/lib/first-run";

/** Minimal in-memory storage double. */
function fakeStorage(): {
	getItem: (k: string) => string | null;
	setItem: (k: string, v: string) => void;
} {
	const map = new Map<string, string>();
	return {
		getItem: (k) => map.get(k) ?? null,
		setItem: (k, v) => {
			map.set(k, v);
		},
	};
}

describe("first-run flag", () => {
	test("loads on first run (no marker)", () => {
		const storage = fakeStorage();
		expect(shouldLoadDemoScene(storage)).toBe(true);
	});

	test("does not load once the marker exists", () => {
		const storage = fakeStorage();
		markDemoSceneSeen(storage);
		expect(shouldLoadDemoScene(storage)).toBe(false);
	});

	test("the marker is the versioned key, value opaque", () => {
		const storage = fakeStorage();
		markDemoSceneSeen(storage);
		expect(storage.getItem(FIRST_RUN_STORAGE)).not.toBeNull();
	});
});
