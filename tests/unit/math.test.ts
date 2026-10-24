import { describe, expect, test } from "bun:test";
import { clamp } from "../../src/lib/math";

describe("clamp", () => {
	test("returns the value when it is inside the bounds", () => {
		expect(clamp(5, 0, 10)).toBe(5);
	});
	test("clamps below the minimum and above the maximum", () => {
		expect(clamp(-1, 0, 10)).toBe(0);
		expect(clamp(11, 0, 10)).toBe(10);
	});
});
