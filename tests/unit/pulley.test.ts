/**
 * Post-MVP pulley joint: placement (makePlacedJoint with a wheel point),
 * the one-sided velocity-level tension solve (pulley.ts — fixed total rope
 * length, equal pull on both legs, slack permitted), the fixed-step sim
 * behavior (heavy falls / light rises, static endpoints, slack and
 * degenerate states, off-center anchors), serialization round-trip, and
 * assembly stamping (the wheel translates with the stamp; body-local
 * anchors stay put).
 */
import { describe, expect, test } from "bun:test";
import { captureAssembly, stampAssembly } from "../../src/lib/assembly";
import { makePlacedJoint } from "../../src/lib/joint";
import {
	PULLEY_BAUMGARTE,
	PULLEY_MAX_REEL_SPEED,
	PULLEY_SLOP,
	solvePulleyImpulse,
} from "../../src/lib/pulley";
import {
	applySceneFile,
	buildSceneFile,
	validateSceneFile,
} from "../../src/lib/scene-file";
import { PhysicsWorld } from "../../src/lib/world";

const DT = 1 / 60;

/** Two boxes under a wheel directly between them: legs hypot(20, 120) each. */
async function fixture(isStatic = false): Promise<PhysicsWorld> {
	const w = await PhysicsWorld.create();
	w.spawnBox("heavy", 100, -200, 12, 12, undefined, isStatic);
	w.spawnBox("light", 140, -200, 6, 6);
	const e = makePlacedJoint(
		"jp",
		"pulley",
		"heavy",
		"light",
		{ x: 100, y: -200 },
		{ x: 140, y: -200 },
		{ x: 100, y: -200, rot: 0 },
		{ x: 140, y: -200, rot: 0 },
		{ x: 120, y: -320 },
	);
	if (!e || !w.spawnJoint(e)) throw new Error("pulley refused");
	return w;
}

/** Live rope path length through the wheel (legs from the wheel to both anchors). */
function pathOf(w: PhysicsWorld): number {
	const e = w.doc.get("jp");
	if (e?.kind !== "joint" || e.params.kind !== "pulley")
		throw new Error("joint missing");
	const p = w.jointWorldAnchors(e);
	if (!p) throw new Error("anchors missing");
	return (
		Math.hypot(p.a.x - e.params.wheelX, p.a.y - e.params.wheelY) +
		Math.hypot(p.b.x - e.params.wheelX, p.b.y - e.params.wheelY)
	);
}

describe("pulley placement", () => {
	test("wheel lands in params; length is the placed path length; anchors stay body-local", () => {
		const e = makePlacedJoint(
			"j",
			"pulley",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 40, y: -10 },
			{ x: 0, y: 0, rot: 0 },
			{ x: 40, y: -10, rot: 0.7 },
			{ x: 20, y: -60 },
		);
		if (!e) throw new Error("refused");
		expect(e.jointType).toBe("pulley");
		expect(e.params).toEqual({
			kind: "pulley",
			wheelX: 20,
			wheelY: -60,
			length: Math.hypot(20, 60) + Math.hypot(20, 50),
		});
		expect(e.anchorA).toEqual({ x: 0, y: 0 });
		expect(e.anchorB).toEqual({ x: 0, y: 0 });
	});

	test("refuses without a wheel point", () => {
		expect(
			makePlacedJoint(
				"j",
				"pulley",
				"a",
				"b",
				{ x: 0, y: 0 },
				{ x: 40, y: -10 },
				{ x: 0, y: 0, rot: 0 },
				{ x: 40, y: -10, rot: 0.7 },
			),
		).toBeUndefined();
	});
});

describe("solvePulleyImpulse (pure)", () => {
	test("slack or within slop: zero impulse regardless of separation velocity", () => {
		expect(solvePulleyImpulse(-5, 1, 1, DT)).toBe(0);
		expect(solvePulleyImpulse(0, 1, 1, DT)).toBe(0);
		expect(solvePulleyImpulse(PULLEY_SLOP, 5, 1, DT)).toBe(5);
	});

	test("taut: arrests outward motion exactly, biases the over-length back in", () => {
		// Separating at 2 u/s with K = 0.5: the impulse cancels the separation.
		expect(solvePulleyImpulse(PULLEY_SLOP, 2, 0.5, DT)).toBeCloseTo(4, 9);
		// Taut with over-length: reel-in bias adds β·(c−slop)/dt on top.
		const bias = (PULLEY_BAUMGARTE * (1 - PULLEY_SLOP)) / DT;
		expect(solvePulleyImpulse(1, 0, 1, DT)).toBeCloseTo(bias, 9);
		expect(solvePulleyImpulse(1, 0, 1, DT)).toBeGreaterThan(0);
	});

	test("one-sided: a fast-retracting taut rope never pulls (clamp at zero)", () => {
		expect(solvePulleyImpulse(1, -50, 1, DT)).toBe(0);
	});

	test("reel-in bias is capped (a teleport cannot rocket the bodies)", () => {
		expect(solvePulleyImpulse(1000, 0, 1, DT)).toBe(PULLEY_MAX_REEL_SPEED);
	});

	test("zero inverse effective mass (static endpoints) and NaN guard give zero", () => {
		expect(solvePulleyImpulse(1, 0, 0, DT)).toBe(0);
		expect(solvePulleyImpulse(Number.NaN, 0, 1, DT)).toBe(0);
		expect(solvePulleyImpulse(1, Number.NaN, 1, DT)).toBe(0);
		expect(solvePulleyImpulse(1, 0, Number.POSITIVE_INFINITY, DT)).toBe(0);
	});
});

describe("pulley physics (fixed-step sim)", () => {
	test("heavy falls, light rises along its leg; the rope path stays at its length", async () => {
		const w = await fixture();
		const L = pathOf(w);
		for (let i = 0; i < 240; i++) w.step();
		const heavy = w.bodyPosition("heavy");
		const light = w.bodyPosition("light");
		if (!heavy || !light) throw new Error("bodies missing");
		expect(heavy.y).toBeGreaterThan(-180); // clearly fell
		expect(light.y).toBeLessThan(-220); // clearly rose
		expect(Math.abs(pathOf(w) - L)).toBeLessThan(0.3); // rope holds
	}, 10_000);

	test("static endpoint: the dynamic side hangs from the rope without falling", async () => {
		const w = await fixture(true);
		const L = pathOf(w);
		for (let i = 0; i < 300; i++) w.step();
		expect(w.bodyPosition("heavy")).toEqual({ x: 100, y: -200 });
		expect(Math.abs(pathOf(w) - L)).toBeLessThan(0.3);
	}, 10_000);

	test("slack falls freely; re-tensioning reels the path back under its length", async () => {
		const w = await fixture();
		const L = pathOf(w);
		// Park the heavy body right under the wheel: path ≪ L → no tension,
		// both bodies free-fall.
		w.moveBody("heavy", 120, -319);
		for (let i = 0; i < 60; i++) w.step();
		const slackLight = w.bodyPosition("light");
		if (!slackLight) throw new Error("light missing");
		expect(slackLight.y).toBeGreaterThan(-196); // fell ~½g·(1s)² from -200
		expect(pathOf(w)).toBeLessThan(L);
		// Restore the heavy body: the path re-tautens and the rope (only
		// pulling) keeps the path at or under its length from here on.
		w.moveBody("heavy", 100, -200);
		for (let i = 0; i < 120; i++) w.step();
		expect(pathOf(w)).toBeLessThan(L + 0.5);
	}, 10_000);

	test("degenerate: a leg of length zero stays finite", async () => {
		const w = await fixture();
		w.moveBody("heavy", 120, -320);
		for (let i = 0; i < 60; i++) w.step();
		const heavy = w.bodyPosition("heavy");
		const light = w.bodyPosition("light");
		if (!heavy || !light) throw new Error("bodies missing");
		expect(Number.isFinite(heavy.x) && Number.isFinite(heavy.y)).toBe(true);
		expect(Number.isFinite(light.x) && Number.isFinite(light.y)).toBe(true);
	}, 10_000);

	test("off-center anchors torque the bodies through the rope and stay stable", async () => {
		const w = await fixture();
		const e = w.doc.get("jp");
		if (e?.kind !== "joint") throw new Error("joint missing");
		w.removeJoint("jp");
		w.spawnJoint({ ...e, anchorA: { x: 10, y: 0 }, anchorB: { x: -4, y: 0 } });
		let maxRot = 0;
		for (let i = 0; i < 600; i++) {
			w.step();
			maxRot = Math.max(
				maxRot,
				Math.abs(w.bodyRotation("heavy") ?? 0),
				Math.abs(w.bodyRotation("light") ?? 0),
			);
		}
		expect(maxRot).toBeGreaterThan(0.05); // the rope torqued the bodies
		const L = 2 * Math.hypot(20, 120);
		expect(pathOf(w)).toBeLessThan(L + 1); // never over-extends meaningfully
		expect(Number.isFinite(pathOf(w))).toBe(true);
	}, 10_000);
});

describe("pulley serialization and assemblies", () => {
	test("buildSceneFile → applySceneFile round-trip still exchanges weights", async () => {
		const w = await fixture();
		const file = buildSceneFile(w.doc);
		expect(validateSceneFile(file).ok).toBe(true);
		const restored = await PhysicsWorld.create();
		applySceneFile(restored, file);
		for (let i = 0; i < 180; i++) restored.step();
		expect(restored.bodyPosition("light")?.y).toBeLessThan(-210);
	}, 10_000);

	test("assembly stamp translates the wheel; body-local anchors stay put", async () => {
		const w = await fixture();
		const captured = captureAssembly(w.doc, new Set(["heavy", "light"]), "p");
		if (!captured.ok) throw new Error(captured.error);
		// Normalized: bodies at (∓20, 0) around the origin; wheel at (0, −120).
		const wheel = captured.assembly.file.entities.find(
			(e) => e.kind === "joint",
		);
		if (wheel?.kind !== "joint" || wheel.params.kind !== "pulley")
			throw new Error("joint missing from capture");
		expect(wheel.params.wheelX).toBe(0);
		expect(wheel.params.wheelY).toBe(-120);
		// Stamped at (400, −200): bodies land at (380/420, −200); the wheel
		// keeps its −120 offset; length and anchors are untouched.
		const ids = stampAssembly(w, captured.assembly.file, 400, -200);
		const e = w.doc.get(ids[2] ?? "");
		if (e?.kind !== "joint" || e.params.kind !== "pulley")
			throw new Error("stamped joint missing");
		expect(e.params).toEqual({
			kind: "pulley",
			wheelX: 400,
			wheelY: -320,
			length: 2 * Math.hypot(20, 120),
		});
		expect(e.anchorA).toEqual({ x: 0, y: 0 });
	});

	test("deleting an endpoint body cascades the pulley away", async () => {
		const w = await fixture();
		w.removeBody("heavy");
		expect(w.doc.get("jp")).toBeUndefined();
	});
});

describe("pulley scene-file validation", () => {
	test("rejects non-positive, non-finite, unbounded, or mistyped pulley params", () => {
		const w = PhysicsWorld.create().then((world) => {
			world.spawnBox("a", 0, -200, 10, 10);
			world.spawnBox("b", 40, -200, 10, 10);
			const ok = makePlacedJoint(
				"j",
				"pulley",
				"a",
				"b",
				{ x: 0, y: -200 },
				{ x: 40, y: -200 },
				{ x: 0, y: -200, rot: 0 },
				{ x: 40, y: -200, rot: 0 },
				{ x: 20, y: -320 },
			);
			if (!ok) throw new Error("refused");
			expect(world.spawnJoint(ok)).toBe(true);
			const base = buildSceneFile(world.doc);
			const good = base.entities.find(
				(e): e is Extract<(typeof base.entities)[number], { kind: "joint" }> =>
					e.kind === "joint",
			);
			if (!good) throw new Error("joint missing");
			const bad = (params: Record<string, unknown>) =>
				validateSceneFile({
					...base,
					entities: [{ ...good, params } as typeof good],
				}).ok;
			expect(bad({ kind: "pulley", wheelX: 0, wheelY: 0, length: 0 })).toBe(
				false,
			);
			expect(bad({ kind: "pulley", wheelX: 0, wheelY: 0, length: -5 })).toBe(
				false,
			);
			expect(
				bad({ kind: "pulley", wheelX: 0, wheelY: 0, length: Infinity }),
			).toBe(false);
			expect(bad({ kind: "pulley", wheelX: 0, wheelY: 0, length: 1e100 })).toBe(
				false,
			);
			expect(bad({ kind: "pulley", wheelX: 0, wheelY: 0, length: "10" })).toBe(
				false,
			);
			expect(
				bad({ kind: "pulley", wheelX: 1e100, wheelY: 0, length: 10 }),
			).toBe(false);
			expect(bad({ kind: "pulley", wheelX: 0, wheelY: "x", length: 10 })).toBe(
				false,
			);
			expect(
				bad({
					kind: "pulley",
					wheelX: 0,
					wheelY: 0,
					length: 4 * 10_000 + 1,
				}),
			).toBe(false);
		});
		expect(w).resolves.toBeUndefined();
	});
});

describe("pulley wake-at-placement (review F2)", () => {
	test("a pulley placed between two sleeping bodies engages the exchange", async () => {
		const w = await PhysicsWorld.create();
		w.spawnBox("heavy", 100, -200, 12, 12);
		w.spawnBox("light", 140, -200, 6, 6);
		// Force-sleep both endpoints BEFORE placement: at the exact placed
		// length the solve returns zero, so nothing but the spawn-time wake
		// can start the sim.
		w.bodies.get("heavy")?.sleep();
		w.bodies.get("light")?.sleep();
		expect(w.bodies.get("heavy")?.isSleeping()).toBe(true);
		expect(w.bodies.get("light")?.isSleeping()).toBe(true);
		const e = makePlacedJoint(
			"jp",
			"pulley",
			"heavy",
			"light",
			{ x: 100, y: -200 },
			{ x: 140, y: -200 },
			{ x: 100, y: -200, rot: 0 },
			{ x: 140, y: -200, rot: 0 },
			{ x: 120, y: -320 },
		);
		if (!e || !w.spawnJoint(e)) throw new Error("pulley refused");
		expect(w.bodies.get("heavy")?.isSleeping()).toBe(false);
		expect(w.bodies.get("light")?.isSleeping()).toBe(false);
		for (let i = 0; i < 240; i++) w.step();
		const light = w.bodyPosition("light");
		if (!light) throw new Error("light missing");
		expect(light.y).toBeLessThan(-220); // the exchange began
	}, 10_000);
});
