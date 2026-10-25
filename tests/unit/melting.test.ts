import { describe, expect, test } from "bun:test";
import { SIM_DT_SECONDS } from "../../src/lib/clock";
import { BURN_SECONDS } from "../../src/lib/flammable";
import { MELT_SECONDS, meltRenderScale } from "../../src/lib/melting";
import { validateSceneFile } from "../../src/lib/scene-file";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * Melting materials extra: sustained thruster exhaust heat accumulates on a
 * melting body and, after MELT_SECONDS, the body disappears. No fire, no
 * spread — only the aimed exhaust heats. Heat is runtime-only (repainting or
 * a reload clears it), and on a body with both flags flammable wins: the
 * burn consumes it before the melt window completes.
 *
 * Geometry convention (flammable.test.ts): a static mount box resting on the
 * ground line fires +x (thrust), so the exhaust beam shoots −x along y = −1;
 * targets rest in that beam.
 */

const WAX = {
	id: "wax",
	name: "Wax",
	color: "#e6d8b8",
	density: 1,
	friction: 0.5,
	restitution: 0.1,
	melting: true,
};

const WAXFIRE = {
	id: "waxfire",
	name: "Waxfire",
	color: "#e6d8b8",
	density: 1,
	friction: 0.5,
	restitution: 0.1,
	melting: true,
	flammable: true,
};

const MELT_TICKS = Math.ceil(MELT_SECONDS / SIM_DT_SECONDS);
const BURN_TICKS = Math.ceil(BURN_SECONDS / SIM_DT_SECONDS);

async function meltingWorld(): Promise<PhysicsWorld> {
	const world = await PhysicsWorld.create();
	world.doc.addMaterial({ ...WAX });
	world.doc.addMaterial({ ...WAXFIRE });
	return world;
}

/** Static mount on the ground line with a firing thruster exhausting −x. */
function mountThruster(world: PhysicsWorld): void {
	world.spawnBox("mount", 0, -1, 1, 1, "ink", true);
	world.spawnThruster({
		kind: "thruster",
		id: "th",
		bodyId: "mount",
		anchorX: 0,
		anchorY: 0,
		angle: 0,
		strength: 10_000,
		on: true,
	});
}

function tick(world: PhysicsWorld, n: number): void {
	for (let i = 0; i < n; i++) world.step();
}

describe("melting constants", () => {
	test("owner-approved spec values are pinned", () => {
		expect(MELT_SECONDS).toBe(6);
	});

	test("render scale holds 1 until the final second, then shrinks to the floor", () => {
		expect(meltRenderScale(0)).toBe(1);
		expect(meltRenderScale(MELT_SECONDS - 1)).toBe(1);
		const mid = meltRenderScale(MELT_SECONDS - 0.5);
		expect(mid).toBeGreaterThan(0.45);
		expect(mid).toBeLessThan(1);
		expect(meltRenderScale(MELT_SECONDS)).toBe(0.45);
	});
});

describe("sustained exhaust heat melts", () => {
	test("an aimed beam melts the body after MELT_SECONDS", async () => {
		const world = await meltingWorld();
		mountThruster(world);
		world.spawnBox("wax1", -4, -1, 1, 1, "wax");
		expect(world.isBurning("wax1")).toBe(false);
		tick(world, 2);
		expect(world.isBurning("wax1")).toBe(false);
		expect(world.meltProgressOf("wax1")).toBeGreaterThan(0);
		tick(world, MELT_TICKS - 4);
		expect(world.bodies.has("wax1")).toBe(true);
		expect(world.meltScaleOf("wax1")).toBeLessThan(1);
		tick(world, 4);
		expect(world.bodies.has("wax1")).toBe(false);
		expect(world.doc.get("wax1")).toBeUndefined();
	}, 10_000);

	test("heat accumulates only while the beam is on the body, and holds between passes", async () => {
		const world = await meltingWorld();
		mountThruster(world);
		world.spawnBox("wax1", -4, -1, 1, 1, "wax");
		tick(world, 120); // 2s of aim
		expect(world.meltProgressOf("wax1")).toBeGreaterThan(0.3);
		// Beam away: no accumulation, no decay — the clock holds.
		expect(world.updateThruster("th", { angle: Math.PI })).toBe(true);
		const held = world.meltProgressOf("wax1");
		tick(world, 120);
		expect(world.meltProgressOf("wax1")).toBe(held);
		// Re-aim: the remaining 4s completes the melt.
		expect(world.updateThruster("th", { angle: 0 })).toBe(true);
		tick(world, 245);
		expect(world.bodies.has("wax1")).toBe(false);
	}, 10_000);

	test("melting never spreads: only the aimed body is lost", async () => {
		const world = await meltingWorld();
		mountThruster(world);
		world.spawnBox("B", -4, -1, 1, 1, "wax");
		world.spawnBox("A", -4, -3, 1, 1, "wax");
		tick(world, MELT_TICKS + 10);
		expect(world.bodies.has("B")).toBe(false);
		expect(world.bodies.has("A")).toBe(true);
		expect(world.isBurning("A")).toBe(false);
	}, 10_000);
});

describe("flammable wins on a body with both flags", () => {
	test("the body ignites instead of accumulating melt heat, and burns out at 4s not 6s", async () => {
		const world = await meltingWorld();
		mountThruster(world);
		world.spawnBox("both1", -4, -1, 1, 1, "waxfire");
		tick(world, 2);
		expect(world.isBurning("both1")).toBe(true);
		expect(world.meltProgressOf("both1")).toBe(0);
		tick(world, BURN_TICKS);
		expect(world.bodies.has("both1")).toBe(false);
	}, 10_000);
});

describe("heat is runtime-only", () => {
	test("repainting to a non-melting material clears the accumulated heat", async () => {
		const world = await meltingWorld();
		mountThruster(world);
		world.spawnBox("wax1", -4, -1, 1, 1, "wax");
		tick(world, 310); // 5.17s: inside the shrink window
		expect(world.meltScaleOf("wax1")).toBeLessThan(1);
		expect(world.setBodyMaterial("wax1", "ink")).toBe(true);
		expect(world.meltScaleOf("wax1")).toBe(1);
		expect(world.meltProgressOf("wax1")).toBe(0);
		// Five more aimed seconds on the fresh clock cannot melt it.
		tick(world, 300);
		expect(world.bodies.has("wax1")).toBe(true);
	}, 10_000);
});

describe("scene-file melting round-trip", () => {
	const base = {
		id: "custom-9",
		name: "Wax",
		color: "#e6d8b8",
		density: 1,
		friction: 0.5,
		restitution: 0.1,
	};
	const file = (melting?: boolean) => ({
		schemaVersion: 1,
		entities: [],
		customMaterials: [
			melting === undefined ? { ...base } : { ...base, melting },
		],
		savedAt: 1,
	});

	test("boolean flag round-trips; non-boolean rejected", () => {
		const truthy = validateSceneFile(file(true));
		expect(truthy.ok).toBe(true);
		if (truthy.ok) expect(truthy.file.customMaterials[0]?.melting).toBe(true);
		const absent = validateSceneFile(file());
		expect(absent.ok).toBe(true);
		if (absent.ok)
			expect(absent.file.customMaterials[0]?.melting).toBeUndefined();
		const bad = validateSceneFile(file(1 as unknown as boolean));
		expect(bad.ok).toBe(false);
		if (!bad.ok) expect(bad.error).toContain("melting");
	});
});
