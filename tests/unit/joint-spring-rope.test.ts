/**
 * P4-T4 spring + rope: placement math (makePlacedJoint spring = rod-style
 * two-endpoint with per-mass defaults), materialization and behavior under
 * the fixed-step sim (per-mass static extension is mass-independent, period
 * scales with stiffness), rope chain geometry (resample, D17 bounds), rope
 * link physics (contacts off, links hold, endpoint capture, bridge holds a
 * dropped box), and rebuild fidelity through the undo snapshot path.
 */
import { describe, expect, test } from "bun:test";
import { placeRopeChain } from "../../src/lib/interaction";
import {
	makeJoint,
	makePlacedJoint,
	SPRING_DEFAULT_DAMPING,
	SPRING_DEFAULT_STIFFNESS,
} from "../../src/lib/joint";
import {
	buildRopeChain,
	countRopeSegmentIds,
	freshRopeSegmentId,
	ROPE_SEGMENT_SPACING,
	resamplePolyline,
} from "../../src/lib/rope";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

const A = { x: 0, y: 0, rot: 0 };
const B = { x: 40, y: -10, rot: 0.7 };

/** Local anchor → world (mirrors localPointToWorld for readability). */
function local(
	l: { x: number; y: number },
	t: { x: number; y: number; rot: number },
): { x: number; y: number } {
	const cos = Math.cos(t.rot);
	const sin = Math.sin(t.rot);
	return {
		x: t.x + l.x * cos - l.y * sin,
		y: t.y + l.x * sin + l.y * cos,
	};
}

/**
 * Turning points in a sampled series (velocity sign changes): two turning
 * points make one oscillation period.
 */
function countTurningPoints(samples: readonly number[]): number {
	let count = 0;
	for (let i = 1; i + 1 < samples.length; i++) {
		const prev = samples[i - 1] as number;
		const cur = samples[i] as number;
		const next = samples[i + 1] as number;
		if ((cur - prev) * (next - cur) < 0) count += 1;
	}
	return count;
}

/**
 * Spawn a spring joint between two bodies at world anchor points (the
 * makeJoint path spawnJoint takes; rest length = the placed distance).
 */
function spawnSpring(
	world: PhysicsWorld,
	id: string,
	bodyA: string,
	bodyB: string | null,
	ax: number,
	ay: number,
	bx: number,
	by: number,
	stiffness: number,
	damping: number,
	restLength?: number,
): boolean {
	const a = world.bodies.get(bodyA);
	const b = bodyB ? world.bodies.get(bodyB) : null;
	if (!a || (bodyB && !b)) return false;
	return world.spawnJoint(
		makeJoint(
			id,
			{
				kind: "spring",
				restLength: restLength ?? Math.hypot(bx - ax, by - ay),
				stiffness,
				damping,
			},
			bodyA,
			bodyB,
			{ x: ax, y: ay },
			{ x: a.translation().x, y: a.translation().y, rot: a.rotation() },
			b
				? { x: b.translation().x, y: b.translation().y, rot: b.rotation() }
				: null,
			{ x: bx, y: by },
		),
	);
}

/** Neighbor-center distance check across a rope chain (links hold). */
function expectChainConnected(
	world: PhysicsWorld,
	segments: readonly string[],
	maxDist: number,
): void {
	for (let i = 1; i < segments.length; i++) {
		const a = world.bodyPosition(segments[i - 1] as string);
		const b = world.bodyPosition(segments[i] as string);
		if (!a || !b) throw new Error("rope segment missing");
		expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThanOrEqual(maxDist);
	}
}

describe("spring placement math", () => {
	test("two clicks are the endpoints; rest length derives, per-mass defaults apply", () => {
		const e = makePlacedJoint(
			"s",
			"spring",
			"a",
			"b",
			{ x: 0, y: 0 },
			{ x: 30, y: 40 },
			A,
			B,
		);
		if (!e) throw new Error("refused");
		if (e.params.kind !== "spring") throw new Error("kind");
		expect(e.params.restLength).toBeCloseTo(50, 9);
		expect(e.params.stiffness).toBe(SPRING_DEFAULT_STIFFNESS);
		expect(e.params.damping).toBe(SPRING_DEFAULT_DAMPING);
		// Rod-style endpoints: anchorA at the first click, anchorB at the second.
		const wa = local(e.anchorA, A);
		const wb = local(e.anchorB, B);
		expect(wa.x).toBeCloseTo(0, 9);
		expect(wa.y).toBeCloseTo(0, 9);
		expect(wb.x).toBeCloseTo(30, 9);
		expect(wb.y).toBeCloseTo(40, 9);
	});
});

describe("spring behavior", () => {
	test("static extension is mass-independent (per-mass constants): x = g/k", async () => {
		const world = await PhysicsWorld.create();
		// Two identical springs, a light (half 5) and a heavy (half 10, 4x the
		// mass) bob. Per-mass k keeps the extension at g/k for both.
		world.spawnBox("anch1", 0, -300, 10, 10, undefined, true);
		world.spawnBox("light", 0, -240, 5, 5);
		world.spawnBox("anch2", 200, -300, 10, 10, undefined, true);
		world.spawnBox("heavy", 200, -240, 10, 10);
		expect(
			spawnSpring(world, "jsp1", "anch1", "light", 0, -300, 0, -240, 30, 10),
		).toBe(true);
		expect(
			spawnSpring(
				world,
				"jsp2",
				"anch2",
				"heavy",
				200,
				-300,
				200,
				-240,
				30,
				10,
			),
		).toBe(true);
		for (let i = 0; i < 480; i++) world.step();
		const expected = 9.81 / 30;
		for (const [anchId, boxId] of [
			["anch1", "light"],
			["anch2", "heavy"],
		] as const) {
			const pa = world.bodyPosition(anchId);
			const pb = world.bodyPosition(boxId);
			if (!pa || !pb) throw new Error("bodies missing");
			const ext = Math.hypot(pb.x - pa.x, pb.y - pa.y) - 60;
			expect(Math.abs(ext - expected)).toBeLessThan(0.1);
		}
	}, 10_000);

	test("oscillation period scales with stiffness (per-mass ω = √k)", async () => {
		const counts: number[] = [];
		for (const stiffness of [30, 270]) {
			const world = await PhysicsWorld.create();
			world.spawnBox("anch", 0, -300, 10, 10, undefined, true);
			world.spawnBox("bob", 0, -235, 6, 6); // 5 below the rest length: a real initial displacement
			expect(
				spawnSpring(
					world,
					"jsp",
					"anch",
					"bob",
					0,
					-300,
					0,
					-235,
					stiffness,
					1,
					60,
				),
			).toBe(true);
			const samples: number[] = [];
			for (let i = 0; i < 600; i++) {
				world.step();
				if (i % 2 === 0) {
					const pa = world.bodyPosition("anch");
					const pb = world.bodyPosition("bob");
					if (pa && pb) samples.push(Math.hypot(pb.x - pa.x, pb.y - pa.y));
				}
			}
			counts.push(countTurningPoints(samples));
		}
		const soft = counts[0] as number;
		const stiff = counts[1] as number;
		// k=30 → T≈1.15 s over the 10 s window; k=270 → T≈0.38 s.
		expect(soft).toBeGreaterThanOrEqual(6);
		expect(stiff).toBeGreaterThan(soft * 1.5);
	}, 10_000);
});

describe("rope chain math", () => {
	test("resamplePolyline emits uniform spacing including both endpoints", () => {
		const out = resamplePolyline(
			[
				{ x: 0, y: 0 },
				{ x: 10, y: 0 },
			],
			2,
		);
		expect(out.length).toBe(6);
		expect(out[0]).toEqual({ x: 0, y: 0 });
		expect(out[3]).toEqual({ x: 6, y: 0 });
		expect(out[5]).toEqual({ x: 10, y: 0 });
	});

	test("buildRopeChain enforces the D17 caps and the minimum stroke", () => {
		const line = (len: number) => [
			{ x: 0, y: 0 },
			{ x: len, y: 0 },
		];
		// 300 units → 151 segments: over the 128-segment per-chain cap.
		expect(buildRopeChain(line(300))).toEqual({
			ok: false,
			reason: "per-chain",
		});
		// 11 new segments on top of a scene already at 384 − 9: over the total.
		expect(buildRopeChain(line(20), { existingTotal: 375 })).toEqual({
			ok: false,
			reason: "total",
		});
		expect(buildRopeChain([{ x: 0, y: 0 }])).toEqual({
			ok: false,
			reason: "too-short",
		});
		// Sub-link strokes are refused, not crammed (the cramped-joints bug).
		expect(buildRopeChain(line(1))).toEqual({
			ok: false,
			reason: "too-short",
		});
		// A 4-unit stroke: 3 beads 2 apart (the nominal spacing), not 2 cramped.
		const short = buildRopeChain(line(4));
		expect(short.ok).toBe(true);
		if (short.ok) {
			expect(short.segments).toEqual([
				{ x: 0, y: 0 },
				{ x: 2, y: 0 },
				{ x: 4, y: 0 },
			]);
			expect(short.linkLength).toBeCloseTo(2.4);
		}
		// A 3-unit stroke: 2 beads 3 apart — fewer beads, farther apart, never
		// cramped (Paul's very-short-rope report).
		const tiny = buildRopeChain(line(3));
		expect(tiny.ok).toBe(true);
		if (tiny.ok) {
			expect(tiny.segments).toEqual([
				{ x: 0, y: 0 },
				{ x: 3, y: 0 },
			]);
			expect(tiny.linkLength).toBeCloseTo(3.6);
		}
		const ok = buildRopeChain(line(120), { existingTotal: 100 });
		expect(ok.ok).toBe(true);
		if (ok.ok) expect(ok.segments.length).toBe(61);
	});

	test("rope segment ids use the counting prefix", () => {
		const id1 = freshRopeSegmentId();
		const id2 = freshRopeSegmentId();
		expect(id1.startsWith("rope-seg-")).toBe(true);
		expect(countRopeSegmentIds(["body-1", id1, id2, "joint-1"])).toBe(2);
	});
});

describe("rope chain in the sim", () => {
	test("world-captured chain hangs; links hold; rope contacts are off", async () => {
		const world = await PhysicsWorld.create();
		const spawned = placeRopeChain(world, {
			points: [
				{ x: -30, y: -200 },
				{ x: 30, y: -200 },
			],
		});
		if (!spawned) throw new Error("rope refused");
		expect(spawned.segments.length).toBe(31);
		// 30 links + a capture pin per end (both ends on empty space → world).
		expect(spawned.joints.length).toBe(32);
		const pinA = world.doc.get(spawned.joints[30] as string);
		if (!pinA || pinA.kind !== "joint" || pinA.params.kind !== "pin") {
			throw new Error("capture pin missing");
		}
		expect(pinA.bodyB).toBeNull();
		expect(pinA.anchorB).toEqual({ x: -30, y: -200 });
		// Rope links AND capture pins disable contacts: the captured bead sits
		// half inside its target (or would fight the pin — measured 2.5× link
		// stretch before the contactsOff rule covered capture pins).
		const linkJoint = world.joints.get(spawned.joints[0] as string);
		expect(linkJoint?.contactsEnabled()).toBe(false);
		const pinJoint = world.joints.get(spawned.joints[30] as string);
		expect(pinJoint?.contactsEnabled()).toBe(false);
		for (let i = 0; i < 240; i++) world.step();
		expectChainConnected(world, spawned.segments, ROPE_SEGMENT_SPACING * 1.6);
	}, 10_000);

	test("rope bridge sags under a dropped box and holds it", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("rb-l", -60, -200, 10, 10, undefined, true);
		world.spawnBox("rb-r", 60, -200, 10, 10, undefined, true);
		const spawned = placeRopeChain(world, {
			points: [
				{ x: -55, y: -200 },
				{ x: 55, y: -200 },
			],
			captureA: "rb-l",
			captureB: "rb-r",
		});
		if (!spawned) throw new Error("rope refused");
		// Capture pins: the end segments pin to the blocks (bodyB set).
		const pinA = world.doc.get(
			spawned.joints[spawned.joints.length - 2] as string,
		);
		const pinB = world.doc.get(
			spawned.joints[spawned.joints.length - 1] as string,
		);
		if (!pinA || pinA.kind !== "joint") throw new Error("pinA missing");
		if (!pinB || pinB.kind !== "joint") throw new Error("pinB missing");
		expect(pinA.bodyB).toBe("rb-l");
		expect(pinB.bodyB).toBe("rb-r");
		// Drop a box onto the middle of the bridge.
		world.spawnBox("rb-box", 0, -240, 8, 8);
		for (let i = 0; i < 300; i++) world.step();
		const box = world.bodyPosition("rb-box");
		if (!box) throw new Error("box missing");
		// Held well above the ground line (a broken rope lets it fall to ~0).
		expect(box.y).toBeLessThan(-40);
		// The rope sagged: the mid segment sits below the (static) end segments.
		const midIndex = Math.floor(spawned.segments.length / 2);
		const mid = world.bodyPosition(spawned.segments[midIndex] as string);
		const end = world.bodyPosition(spawned.segments[0] as string);
		if (!mid || !end) throw new Error("segment missing");
		expect(mid.y).toBeGreaterThan(end.y + 3);
		// Interior links are stiff springs (rest 2.4); under the 256-mass box
		// the steeply loaded end-region links stretch to ~1.5× rest (measured
		// across 6400–1600 per-mass stiffness — the residual is load geometry,
		// not the constant). The bound documents that elasticity without
		// passing a torn chain (the soft rope-joint variant tore to 3.5×).
		expectChainConnected(world, spawned.segments.slice(1, -1), 4.0);
		const endA = world.bodyPosition(spawned.segments[0] as string);
		const nextA = world.bodyPosition(spawned.segments[1] as string);
		const endB = world.bodyPosition(
			spawned.segments[spawned.segments.length - 1] as string,
		);
		const nextB = world.bodyPosition(
			spawned.segments[spawned.segments.length - 2] as string,
		);
		if (!endA || !nextA || !endB || !nextB) {
			throw new Error("segment missing");
		}
		expect(Math.hypot(nextA.x - endA.x, nextA.y - endA.y)).toBeLessThan(9.5);
		expect(Math.hypot(nextB.x - endB.x, nextB.y - endB.y)).toBeLessThan(9.5);
	}, 10_000);

	test("undo snapshot restore rebuilds the rope chain and the spring", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("anch", 0, -300, 10, 10, undefined, true);
		world.spawnBox("bob", 0, -235, 6, 6);
		expect(
			spawnSpring(world, "jsp", "anch", "bob", 0, -300, 0, -240, 30, 4),
		).toBe(true);
		const rope = placeRopeChain(world, {
			points: [
				{ x: 80, y: -260 },
				{ x: 140, y: -260 },
			],
		});
		if (!rope) throw new Error("rope refused");
		const undo = new UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => world.restoreSnapshot(entities),
		);
		undo.commit();
		// Destroy the chain as one action, then undo back to the snapshot:
		// every segment body, rope link, and capture pin rebuilds through
		// spawnJoint.
		undo.beginAction();
		for (const id of rope.segments) world.removeBody(id);
		undo.commit();
		expect(world.joints.size).toBe(1);
		expect(undo.undo()).toBe(true);
		expect(world.joints.get("jsp")).toBeDefined();
		expect(countRopeSegmentIds(world.doc.ids())).toBe(rope.segments.length);
		expect(world.joints.size).toBe(1 + rope.joints.length);
		for (let i = 0; i < 120; i++) world.step();
		expectChainConnected(world, rope.segments, 3.2);
	}, 10_000);
});
