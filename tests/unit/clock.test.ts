import { describe, expect, test } from "bun:test";
import { SIM_DT_SECONDS, SIM_TICK_HZ, SimClock } from "../../src/lib/clock";

describe("SimClock", () => {
	test("SIM_TICK_HZ is 60 and dt matches", () => {
		expect(SIM_TICK_HZ).toBe(60);
		expect(SIM_DT_SECONDS).toBeCloseTo(1 / 60, 15);
	});

	test("advances the exact number of ticks for whole-frame feeds", () => {
		const cases: Array<[number, number]> = [
			[0, 0],
			[1000, 60],
			[500, 30],
			[100, 6],
			[16, 0],
			[17, 1],
			[33, 1],
			[34, 2],
		];
		for (const [ms, expected] of cases) {
			const clock = new SimClock();
			clock.advanceSimTime(ms / 1000);
			expect(clock.tick).toBe(expected);
		}
	});

	test("remainder carries between frames: 60 × 16.7ms still yields 60 ticks", () => {
		const clock = new SimClock();
		for (let i = 0; i < 60; i += 1) clock.advanceRealTime(16.7 / 1000);
		expect(clock.tick).toBe(60);
	});

	test("no drift: 10 simulated minutes in one call, in 1/60s frames, and in 10s chunks all yield 36000 ticks", () => {
		const tenMinutesSeconds = 600;
		const expectedTicks = 600 * 60;

		const single = new SimClock();
		single.advanceSimTime(tenMinutesSeconds);
		expect(single.tick).toBe(expectedTicks);

		const frames = new SimClock();
		for (let i = 0; i < expectedTicks; i += 1) frames.advanceRealTime(1 / 60);
		expect(frames.tick).toBe(expectedTicks);

		const chunks = new SimClock();
		for (let i = 0; i < 60; i += 1) chunks.advanceSimTime(10);
		expect(chunks.tick).toBe(expectedTicks);
	});

	test("pause excludes time: no ticks while paused, resume picks up", () => {
		const clock = new SimClock();
		clock.setPaused(true);
		clock.advanceRealTime(5000);
		expect(clock.tick).toBe(0);
		// advanceSimTime is the debug path and deliberately ignores pause.
		const ticksWhilePaused = clock.tick;
		clock.advanceSimTime(1);
		expect(clock.tick).toBe(ticksWhilePaused + 60);

		clock.setPaused(false);
		for (let i = 0; i < 60; i += 1) clock.advanceRealTime(1 / 60);
		expect(clock.tick).toBe(ticksWhilePaused + 120);
	});

	test("real-time catch-up caps at maxCatchUpSteps and drops the excess", () => {
		const clock = new SimClock({ maxCatchUpSteps: 5 });
		clock.advanceRealTime(1); // 1s would need 60 ticks; only 5 run, rest dropped
		expect(clock.tick).toBe(5);
		// The dropped backlog must not resurface on the next frame.
		clock.advanceRealTime(1 / 60);
		expect(clock.tick).toBe(6);
	});

	test("droppedSeconds telemetry counts the discarded backlog", () => {
		const clock = new SimClock({ maxCatchUpSteps: 5 });
		expect(clock.droppedSeconds).toBe(0);
		clock.advanceRealTime(1); // 55 of 60 ticks dropped = 55/60 s
		expect(clock.droppedSeconds).toBeCloseTo(55 / 60, 5);
	});

	test("interpolationAlpha is the carried fraction of the next tick", () => {
		const clock = new SimClock();
		clock.advanceRealTime(8 / 1000); // half a 16.67ms tick
		expect(clock.interpolationAlpha).toBeGreaterThan(0);
		expect(clock.interpolationAlpha).toBeLessThan(1);
	});

	test("rejects invalid inputs", () => {
		const clock = new SimClock();
		expect(() => clock.advanceRealTime(-1)).toThrow(RangeError);
		expect(() => clock.advanceSimTime(Number.NaN)).toThrow(RangeError);
		expect(() => new SimClock({ maxCatchUpSteps: 0 })).toThrow(RangeError);
	});

	test("unsubscribe stops a listener", () => {
		const clock = new SimClock();
		let calls = 0;
		const unsubscribe = clock.subscribe(() => {
			calls += 1;
		});
		clock.advanceSimTime(1 / 60);
		unsubscribe();
		clock.advanceSimTime(1 / 60);
		expect(calls).toBe(1);
	});
});
