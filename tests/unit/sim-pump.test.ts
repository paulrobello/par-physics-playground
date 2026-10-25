/**
 * Sim pump (the "super slow motion at 1x" fix): rAF drives rendering, but
 * when heavy host load starves rAF below the clock's catch-up cap, sim time
 * fell behind wall time. The pump consumes real elapsed wall time exactly
 * once regardless of whether the render loop or the fallback interval fires
 * first — pinned here with an injected clock.
 */
import { describe, expect, test } from "bun:test";
import { createSimPump } from "../../src/lib/sim-pump";

describe("createSimPump", () => {
	test("first pump only initializes; no time is advanced", () => {
		const nowMs = 1000;
		const advanced: number[] = [];
		const pump = createSimPump(
			(s) => advanced.push(s),
			() => nowMs,
		);
		pump.pump();
		expect(advanced).toEqual([]);
	});

	test("each pump consumes the real elapsed gap exactly once", () => {
		let nowMs = 1000;
		let total = 0;
		const pump = createSimPump(
			(s) => {
				total += s;
			},
			() => nowMs,
		);
		pump.pump();
		nowMs += 16;
		pump.pump();
		nowMs += 16;
		pump.pump();
		expect(total).toBeCloseTo(0.032, 9);
	});

	test("two pumps at the same instant: the second is a no-op", () => {
		const nowMs = 1000;
		let calls = 0;
		const pump = createSimPump(
			() => {
				calls += 1;
			},
			() => nowMs,
		);
		pump.pump(); // initializes
		pump.pump(); // zero-length gap → advance never fires
		expect(calls).toBe(0);
	});

	test("keeps flowing while the render loop is stalled (the starvation case)", () => {
		let nowMs = 0;
		let total = 0;
		const pump = createSimPump(
			(s) => {
				total += s;
			},
			() => nowMs,
		);
		pump.pump();
		// rAF dead: only the 100ms fallback interval pumps — 5s wall time.
		nowMs += 5000;
		pump.pump();
		expect(total).toBeCloseTo(5, 9);
	});

	test("dispose stops the fallback interval (no further pumping)", () => {
		const nowMs = 0;
		let calls = 0;
		const pump = createSimPump(
			() => {
				calls += 1;
			},
			() => nowMs,
		);
		pump.dispose();
		expect(calls).toBe(0);
	});
});
