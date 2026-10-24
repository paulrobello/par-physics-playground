/**
 * P4-T5 demo scene: the built-in machine round-trips through the document
 * (restore fidelity, no orphan joints on any single-part deletion), and the
 * machine RUNS deterministically — the final ball crosses the FINISH marker.
 */
import { describe, expect, test } from "bun:test";
import {
	buildDemoScene,
	DEMO_FINAL_BODY_ID,
	DEMO_FINISH_X,
} from "../../src/lib/demo-scene";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

function freshDemoWorld(): Promise<PhysicsWorld> {
	return (async () => {
		const world = await PhysicsWorld.create();
		world.restoreSnapshot(buildDemoScene());
		return world;
	})();
}

describe("demo scene document", () => {
	test("round-trips: restoreSnapshot rebuilds every entity", async () => {
		const world = await freshDemoWorld();
		expect(world.doc.ids().sort()).toEqual(
			buildDemoScene()
				.map((e) => e.id)
				.sort(),
		);
	});

	test("deleting any machine part leaves no orphan joints", async () => {
		const world = await freshDemoWorld();
		for (const id of world.doc.ids()) {
			world.removeBody(id);
			for (const joint of world.doc.joints()) {
				expect(world.doc.get(joint.bodyA)).toBeDefined();
				expect(joint.bodyB === null || world.doc.get(joint.bodyB)).toBeTruthy();
			}
		}
	});

	test("capture pins disable contacts — beads sit half inside their targets", () => {
		// The T4-measured capture shape: the end beads overlap the hook and
		// cradle, so their pins must carry contactsOff exactly like the tool
		// path's capture pins (a contact-vs-pin fight stretches links).
		const pins = buildDemoScene().filter(
			(e) =>
				e.kind === "joint" &&
				(e.id === "demo-rope-cap-top" || e.id === "demo-rope-cap-bottom"),
		);
		expect(pins).toHaveLength(2);
		for (const pin of pins) {
			expect(pin.kind).toBe("joint");
			if (pin.kind === "joint" && pin.params.kind === "pin") {
				expect(pin.params.contactsOff).toBe(true);
			} else {
				throw new Error("capture pin is not a pin joint");
			}
		}
	});

	test("undo restores the machine after deleting a part", async () => {
		const world = await freshDemoWorld();
		const undo = new UndoStack(
			() => world.doc.all(),
			(entities) => world.restoreSnapshot(entities),
		);
		const before = world.doc.ids().length;
		undo.commit();
		undo.beginAction();
		world.removeBody("demo-domino-3");
		undo.commit();
		expect(world.doc.ids().length).toBe(before - 1); // one domino gone
		expect(undo.undo()).toBe(true);
		expect(world.doc.ids().length).toBe(before);
	});

	test("thruster is on, mounted on the final ball, +x", async () => {
		const world = await freshDemoWorld();
		const t = world.doc.get("demo-thruster");
		expect(t?.kind).toBe("thruster");
		if (t?.kind !== "thruster") return;
		expect(t.bodyId).toBe(DEMO_FINAL_BODY_ID);
		expect(t.on).toBe(true);
		expect(t.angle).toBe(0);
	});
});

describe("demo scene runs end-to-end", () => {
	test("final ball crosses the FINISH marker; dominoes topple late in the run", async () => {
		const world = await freshDemoWorld();
		// The thruster fires immediately: the final ball is at the marker
		// within ~4 s. The ball A cascade (ramp → wheel → dominoes) is slow
		// by design (~34 s for the whole run).
		for (let i = 0; i < 60 * 6; i++) world.step();
		const finalPos = world.bodyPosition(DEMO_FINAL_BODY_ID);
		expect(finalPos?.x ?? 0).toBeGreaterThan(DEMO_FINISH_X - 20);
		// Ball A has landed on the shelf and knocked the first dominoes.
		for (let i = 0; i < 60 * 22; i++) world.step();
		const toppled = ["demo-domino-1", "demo-domino-3", "demo-domino-6"]
			.map((id) => Math.abs(world.bodyRotation(id) ?? 0) > 0.5)
			.filter(Boolean).length;
		expect(toppled).toBeGreaterThanOrEqual(2);
	}, 30_000);
});
