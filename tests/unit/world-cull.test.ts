import { describe, expect, test } from "bun:test";
import { createToolEvents } from "../../src/lib/interaction";
import { ToolSession } from "../../src/lib/tools";
import { KILL_THRESHOLD_Y, PhysicsWorld } from "../../src/lib/world";

/**
 * F5 regression: kill-threshold culling must invalidate the drag joint the
 * interaction layer still holds. A culled body's joints are destroyed with it
 * in Rapier, so the world exposes an onRemove seam and createToolEvents drops
 * the stale joint handle; the pending pointer move/release then become no-ops
 * and a fresh grab works. Runs against a real Rapier world (loads in bun).
 */
describe("kill-threshold cull vs. active drag", () => {
	test("culling the dragged body drops the joint; move+release are safe; a new grab drags", async () => {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world);
		// The pick resolves to whichever body the test currently exposes
		// (the app's pickBody works off the live registry; this stands in).
		let pickableId: string | undefined;
		const session = new ToolSession(events, () => pickableId);
		world.spawnBox("faller", 0, -100, 5, 5);
		pickableId = "faller";

		session.pointerDown(0, -100);
		expect(events.activeJoint).not.toBeNull();

		// Teleport the held body past the kill threshold and tick once:
		// step() culls it, and the cull seam must clear the active joint.
		const body = world.bodies.get("faller");
		if (!body) throw new Error("spawned body missing");
		body.setTranslation({ x: 0, y: KILL_THRESHOLD_Y + 10 }, true);
		world.step();
		expect(world.bodies.has("faller")).toBe(false);
		expect(events.activeJoint).toBeNull();

		// The session is still mid-drag from its point of view; the pending
		// move and release must be tolerant no-ops, not exceptions on a
		// removed joint handle.
		session.pointerMove(50, -50);
		session.pointerUp();

		// A fresh body can be grabbed and dragged end to end.
		world.spawnBox("second", 0, -100, 5, 5);
		pickableId = "second";
		session.pointerDown(0, -100);
		expect(events.activeJoint).not.toBeNull();
		session.pointerMove(20, -80);
		session.pointerUp();
		expect(events.activeJoint).toBeNull();
	}, 10_000);
});
