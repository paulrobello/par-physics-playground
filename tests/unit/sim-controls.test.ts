import { describe, expect, test } from "bun:test";
import {
	clampTimeScale,
	GRAVITY_PRESETS,
	gravityFromVector,
	gravityVector,
	pauseButtonState,
	SIM_CONTROL_KEYS,
	type SimButtonState,
	TIME_SCALE_MAX,
	TIME_SCALE_MIN,
	TimeScale,
} from "../../src/lib/sim-controls";
import { PhysicsWorld } from "../../src/lib/world";

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

describe("gravityVector mapping (dial/slider degrees → vector)", () => {
	test("0° points down (+y in the y-down world)", () => {
		const v = gravityVector(0, 9.81);
		expect(v.x).toBeCloseTo(0, 12);
		expect(v.y).toBeCloseTo(9.81, 12);
	});

	test("90° points right, 180° up, 270° left (screen-clockwise from down)", () => {
		const right = gravityVector(90, 5);
		expect(right.x).toBeCloseTo(5, 12);
		expect(right.y).toBeCloseTo(0, 12);
		const up = gravityVector(180, 5);
		expect(up.x).toBeCloseTo(0, 12);
		expect(up.y).toBeCloseTo(-5, 12);
		const left = gravityVector(270, 5);
		expect(left.x).toBeCloseTo(-5, 12);
		expect(left.y).toBeCloseTo(0, 12);
	});

	test("magnitude carries through at off-axis angles", () => {
		const v = gravityVector(45, 10);
		expect(v.x).toBeCloseTo(10 * Math.SQRT1_2, 12);
		expect(v.y).toBeCloseTo(10 * Math.SQRT1_2, 12);
	});
});

describe("gravity presets (PRD D5)", () => {
	test("down = 9.81 m/s² at 0°, zero-g = 0, moon = 1.62 m/s² down", () => {
		const byId = new Map(GRAVITY_PRESETS.map((p) => [p.id, p]));
		expect(byId.get("down")?.magnitude).toBe(9.81);
		expect(byId.get("down")?.angleDeg).toBe(0);
		expect(byId.get("zero-g")?.magnitude).toBe(0);
		expect(byId.get("moon")?.magnitude).toBe(1.62);
		expect(byId.get("moon")?.angleDeg).toBe(0);
	});
});

describe("clampTimeScale (feed-rate scaling math)", () => {
	test("values inside 0.25–2 pass through", () => {
		expect(clampTimeScale(0.25)).toBe(TIME_SCALE_MIN);
		expect(clampTimeScale(1)).toBe(1);
		expect(clampTimeScale(2)).toBe(TIME_SCALE_MAX);
		expect(clampTimeScale(0.5)).toBe(0.5);
	});

	test("out-of-range values clamp to the bounds", () => {
		expect(clampTimeScale(0)).toBe(TIME_SCALE_MIN);
		expect(clampTimeScale(-3)).toBe(TIME_SCALE_MIN);
		expect(clampTimeScale(5)).toBe(TIME_SCALE_MAX);
		expect(clampTimeScale(100)).toBe(TIME_SCALE_MAX);
	});

	test("non-finite falls back to 1×", () => {
		expect(clampTimeScale(Number.NaN)).toBe(1);
		expect(clampTimeScale(Number.POSITIVE_INFINITY)).toBe(1);
	});
});

describe("TimeScale handle", () => {
	test("starts at 1×, clamps on set, notifies listeners on change", () => {
		const ts = new TimeScale();
		expect(ts.value).toBe(1);
		const seen: number[] = [];
		ts.subscribe((v) => seen.push(v));
		ts.set(0.5);
		expect(ts.value).toBe(0.5);
		expect(seen).toEqual([0.5]);
		ts.set(99);
		expect(ts.value).toBe(TIME_SCALE_MAX);
		expect(seen).toEqual([0.5, TIME_SCALE_MAX]);
	});

	test("setting the same value does not re-notify", () => {
		const ts = new TimeScale();
		let calls = 0;
		ts.subscribe(() => {
			calls += 1;
		});
		ts.set(1);
		expect(calls).toBe(0);
		ts.set(1.5);
		ts.set(1.5);
		expect(calls).toBe(1);
	});
});

describe("gravityFromVector (fix-wave F4: vector → slider degrees)", () => {
	test("inverts gravityVector: roundtrip is exact on the slider's grid", () => {
		for (const angleDeg of [0, 30, 90, 180, 270, 359]) {
			for (const magnitude of [0, 1.62, 5, 9.81, 25]) {
				const v = gravityVector(angleDeg, magnitude);
				const back = gravityFromVector(v);
				expect(back.magnitude).toBeCloseTo(magnitude, 9);
				// A zero-magnitude vector carries no direction (the -0/+0 sign of
				// the components decides the recovered angle) — only its magnitude
				// is pinned here; the true zero-vector case has its own test.
				if (magnitude !== 0) {
					expect(back.angleDeg % 360).toBeCloseTo(angleDeg % 360, 6);
				}
			}
		}
	});

	test("the zero vector reads as 0° / 0", () => {
		expect(gravityFromVector({ x: 0, y: 0 })).toEqual({
			angleDeg: 0,
			magnitude: 0,
		});
	});
});

describe("PhysicsWorld gravity seam (fix-wave T3 + F4)", () => {
	test("the gravity getter returns a copy: callers cannot bypass setGravity", async () => {
		const world = await PhysicsWorld.create();
		const g = world.gravity;
		g.x = 999;
		g.y = 999;
		// A mutated copy never reaches the live world — only setGravity does,
		// and setGravity is what wakes sleepers.
		expect(world.gravity.x).toBe(0);
		expect(world.gravity.y).toBeCloseTo(9.81, 12);
	}, 10_000);

	test("setGravity notifies gravity subscribers (slider sync seam)", async () => {
		const world = await PhysicsWorld.create();
		const seen: { x: number; y: number }[] = [];
		const unsub = world.subscribeGravity((v) => seen.push(v));
		world.setGravity(90, 5);
		unsub();
		world.setGravity(0, 1);
		expect(seen).toEqual([{ x: 90, y: 5 }]);
	}, 10_000);
});
