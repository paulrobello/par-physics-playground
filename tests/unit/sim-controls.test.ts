import { describe, expect, test } from "bun:test";
import {
	pauseButtonState,
	SIM_CONTROL_KEYS,
	type SimButtonState,
} from "../../src/lib/sim-controls";

describe("sim control keyboard map", () => {
	test("P toggles pause, Period steps one tick", () => {
		expect(SIM_CONTROL_KEYS.KeyP).toBe("toggle-pause");
		expect(SIM_CONTROL_KEYS.Period).toBe("step");
	});
});

describe("pauseButtonState", () => {
	test("running shows Pause offered, pressed=false", () => {
		const state: SimButtonState = pauseButtonState(false);
		expect(state.label).toBe("Pause simulation (P)");
		expect(state.pressed).toBe(false);
	});

	test("paused shows Play offered, pressed=true", () => {
		const state: SimButtonState = pauseButtonState(true);
		expect(state.label).toBe("Play simulation (P)");
		expect(state.pressed).toBe(true);
	});
});
