/**
 * First-run demo-scene semantics (PRD D16): the built-in demo scene preloads
 * ON FIRST RUN, and the choice is remembered — a boolean in localStorage is
 * enough at this stage. Pure logic with injected storage so unit tests don't
 * need a DOM, with the app wiring a one-liner.
 */

/**
 * The persisted first-run marker. Versioned key: changing the demo scene or
 * the semantics can move to `v2` to re-offer the demo without a migration.
 */
export const FIRST_RUN_STORAGE = "ppg.demo-scene.v1";

/** The storage surface first-run needs (satisfied by window.localStorage). */
export interface FirstRunStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** True when the demo scene should preload (no marker in storage yet). */
export function shouldLoadDemoScene(storage: FirstRunStorage): boolean {
	return storage.getItem(FIRST_RUN_STORAGE) === null;
}

/** Record that the first-run choice was made (call after a preload). */
export function markDemoSceneSeen(storage: FirstRunStorage): void {
	storage.setItem(FIRST_RUN_STORAGE, "loaded");
}
