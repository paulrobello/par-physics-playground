/**
 * P3 rotation momentum (angular fling): a rotate gesture released mid-motion
 * hands the recent angular velocity to onRotateEnd so the selection spins on.
 * The session's velocity estimate is pure (injected clock) — the events layer
 * applies it to the live bodies.
 */
import { describe, expect, test } from "bun:test";
import {
	ROTATE_RADIANS_PER_UNIT,
	ToolSession,
	type ToolSessionEvents,
} from "../../src/lib/tools";

describe("ToolSession rotate fling velocity", () => {
	function makeSession() {
		let t = 0;
		const ended: (number | undefined)[] = [];
		const events: ToolSessionEvents = {
			onSpawnBox() {},
			onSpawnCircle() {},
			onSpawnPolygon() {},
			onSpawnLine() {},
			onSpawnFreehand() {},
			onCreateLabel: () => "label-1",
			onCommitLabel() {},
			onDragStart() {},
			onDragMove() {},
			onDragEnd() {},
			onRotateStart() {},
			onRotate() {},
			onRotateEnd: (velocity?: number) => ended.push(velocity),
			onDelete() {},
			onDuplicate: () => [undefined],
		};
		const session = new ToolSession(
			events,
			(x, y) => (x > 0 && Math.abs(y) < 5 ? "body-1" : undefined),
			undefined,
			() => t,
		);
		return {
			session,
			ended,
			advance: (ms: number) => {
				t += ms;
			},
		};
	}

	test("a fast final drag flings: onRotateEnd carries signed rad/s", () => {
		const { session, ended, advance } = makeSession();
		session.pointerDown(10, 0, { rotate: true });
		advance(16);
		// 40 units down in 16 ms = 2500 u/s · 0.01 rad/unit = 25 rad/s.
		session.pointerMove(10, 40);
		advance(16);
		session.pointerMove(10, 80);
		session.pointerUp();
		expect(ended).toHaveLength(1);
		const v = ended[0];
		expect(v).toBeDefined();
		// 40 units / 16 ms = 2500 u/s · 0.01 rad/unit = 25 rad/s.
		expect(v as number).toBeCloseTo(25, 0);
	});

	test("a long pause before release flings nothing (stale velocity decays)", () => {
		const { session, ended, advance } = makeSession();
		session.pointerDown(10, 0, { rotate: true });
		advance(16);
		session.pointerMove(10, 40);
		advance(600); // finger hesitates on the way out
		session.pointerUp();
		const v = ended[0];
		// Stale samples must not fling: the estimate goes stale to ~0.
		expect(v === undefined || Math.abs(v as number) < 1).toBe(true);
	});

	test("an upward fling carries the negative sign", () => {
		const { session, ended, advance } = makeSession();
		session.pointerDown(10, 0, { rotate: true });
		advance(16);
		session.pointerMove(10, -40);
		session.pointerUp();
		const v = ended[0] as number;
		expect(v).toBeLessThan(0);
	});

	test("a single-frame gesture has no velocity sample and flings nothing", () => {
		const { session, ended } = makeSession();
		session.pointerDown(10, 0, { rotate: true });
		session.pointerUp();
		expect(ended[0]).toBeUndefined();
	});
});

describe("createToolEvents applies the fling to live bodies", () => {
	async function fixture(paused: boolean) {
		const { UndoStack } = await import("../../src/lib/undo");
		const { PhysicsWorld } = await import("../../src/lib/world");
		const { createToolEvents } = await import("../../src/lib/interaction");
		const world = await PhysicsWorld.create();
		world.spawnBox("spin-me", 0, -50, 8, 8);
		const stack = new UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => world.restoreSnapshot(entities),
		);
		stack.commit();
		let session: ToolSession;
		const events = createToolEvents(world, {
			isPaused: () => paused,
			selectedIds: () => session?.selectedIds ?? new Set<string>(),
			beginAction: () => stack.beginAction(),
			cancelAction: () => stack.cancelAction(),
			recordAction: () => stack.commit(),
		});
		let t = 0;
		session = new ToolSession(
			events,
			(x, y) => (x > -100 ? "spin-me" : undefined),
			undefined,
			() => t,
		);
		return {
			world,
			session,
			events,
			advance: (ms: number) => {
				t += ms;
			},
		};
	}

	test("a released fling sets signed angular velocity on the selection", async () => {
		const { world, session, advance } = await fixture(false);
		session.pointerDown(0, 0, { rotate: true });
		for (let i = 1; i <= 4; i++) {
			advance(16);
			session.pointerMove(0, i * 12);
		}
		session.pointerUp();
		const body = world.bodies.get("spin-me");
		if (!body) throw new Error("body missing");
		const omega = body.angvel();
		expect(Math.abs(omega)).toBeGreaterThanOrEqual(0.8);
		expect(omega).toBeGreaterThan(0); // downward drag = positive spin
	});

	test("a paused world never receives fling velocity", async () => {
		const { world, session, advance } = await fixture(true);
		session.pointerDown(0, 0, { rotate: true });
		for (let i = 1; i <= 4; i++) {
			advance(16);
			session.pointerMove(0, i * 12);
		}
		session.pointerUp();
		const body = world.bodies.get("spin-me");
		if (!body) throw new Error("body missing");
		expect(body.angvel()).toBe(0);
	});
});
