import { describe, expect, test } from "bun:test";
import { createToolEvents } from "../../src/lib/interaction";
import { axisLockMove, ToolSession } from "../../src/lib/tools";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * Shift axis-lock move (Paul, 2026-10-26): while Shift is held during a body
 * move drag, the move point locks to the drag's dominant axis — the minor
 * component of the total delta zeroes continuously (self-correcting each
 * move), so pressing/releasing Shift mid-drag toggles the lock live.
 */

describe("axisLockMove", () => {
	test("a dominant x delta keeps x and zeroes the y offset", () => {
		const out = { x: 0, y: 0 };
		axisLockMove(100, 100, 140, 90, out);
		expect(out.x).toBe(140);
		expect(out.y).toBe(100);
	});
	test("a dominant y delta keeps y and zeroes the x offset", () => {
		const out = { x: 0, y: 0 };
		axisLockMove(100, 100, 90, 140, out);
		expect(out.x).toBe(100);
		expect(out.y).toBe(140);
	});
	test("ties keep x (|dx| >= |dy|)", () => {
		const out = { x: 0, y: 0 };
		axisLockMove(100, 100, 130, 70, out);
		expect(out.x).toBe(130);
		expect(out.y).toBe(100);
	});
	test("the lock self-corrects: each move re-picks the dominant axis", () => {
		const out = { x: 0, y: 0 };
		// The same start, a move that flips dominance mid-drag re-locks.
		axisLockMove(0, 0, 40, 10, out);
		expect(out.y).toBe(0);
		axisLockMove(0, 0, 10, 40, out);
		expect(out.x).toBe(0);
	});
});

describe("shift-lock drag through the real wiring (paused teleport path)", () => {
	test("a multi-move diagonal drag advances only the dominant axis", async () => {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world, {
			selectedIds: () => session.selectedIds,
			isPaused: () => true,
		});
		let pickableId: string | undefined;
		const session = new ToolSession(events, () => pickableId);
		world.spawnBox("m", 300, -300, 20, 20);
		session.selectedIds = new Set(["m"]);
		pickableId = "m";

		session.pointerDown(300, -300, {}, 1);
		// Four diagonal moves (dx 10 > |dy| each step): the lock keeps the
		// pointer's x and zeroes y against the PRESS point every move.
		session.pointerMove(310, -307.5, { shift: true }, 1);
		session.pointerMove(320, -315, { shift: true }, 1);
		session.pointerMove(330, -322.5, { shift: true }, 1);
		session.pointerMove(340, -330, { shift: true }, 1);
		let p = world.bodyPosition("m");
		if (!p) throw new Error("box m missing");
		expect(p.x).toBeCloseTo(340, 3);
		expect(p.y).toBeCloseTo(-300, 3);

		// Releasing Shift drops the lock: the next move is free.
		session.pointerMove(350, -350, {}, 1);
		p = world.bodyPosition("m");
		if (!p) throw new Error("box m missing after unlock");
		expect(p.x).toBeCloseTo(350, 3);
		expect(p.y).toBeCloseTo(-350, 3);
		session.pointerUp(1);
	}, 10_000);
});
