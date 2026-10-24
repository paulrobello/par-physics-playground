/**
 * P4 freehand-chain geometry card: wedge gaps at bends (static chains get
 * square-cap extensions so the rendered surface is continuous) and
 * short-segment overlaps (dynamic chains merge sub-minimal segments instead
 * of clamping halfLengths into their neighbors).
 */
import { describe, expect, test } from "bun:test";
import { createToolEvents } from "../../src/lib/interaction";
import { BEAM_HALF_WIDTH } from "../../src/lib/tools";
import { PhysicsWorld } from "../../src/lib/world";

const ZIGZAG = [
	{ x: 0, y: 0 },
	{ x: 30, y: -20 },
	{ x: 60, y: 0 },
	{ x: 90, y: -20 },
];

interface ChainBox {
	cx: number;
	halfWidth: number;
}

function chainBoxes(world: PhysicsWorld): ChainBox[] {
	const out: ChainBox[] = [];
	for (const id of world.doc.ids()) {
		const e = world.doc.get(id);
		if (e?.kind === "body" && e.shape.kind === "box") {
			out.push({ cx: e.x, halfWidth: e.shape.halfWidth });
		}
	}
	return out.sort((a, b) => a.cx - b.cx);
}

describe("freehand chain spawn geometry", () => {
	async function fixture(isStatic: boolean) {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world, {
			isStaticSpawn: () => isStatic,
			activeMaterialId: () => "ink",
		});
		return { world, events };
	}

	test("static chains extend half a beam width past each joint (no wedge notch)", async () => {
		const { world, events } = await fixture(true);
		events.onSpawnFreehand({ kind: "chain", points: ZIGZAG });
		const boxes = chainBoxes(world);
		expect(boxes.length).toBe(ZIGZAG.length - 1);
		for (const box of boxes) {
			// Segment length is 30 here (ignoring the y-component for the
			// diagonal — the first segment is 30/−20, length ≈ 36; assert the
			// cap extension on the axis-aligned simplification instead: the
			// horizontal span per box is at least half the true length plus
			// the cap. Exact: hypot(30,20)/2 = 18.03 + 0.25.
			expect(box.halfWidth).toBeGreaterThan(15);
		}
		// Each box extends past the shared vertex by exactly BEAM_HALF_WIDTH:
		// box i's right reach (cx + halfWidth projected) covers the vertex.
		// The document stores centers/rotations, so assert via the raw
		// half-length difference between extended and a plain 36.06/2.
		expect(boxes[0]!.halfWidth - Math.hypot(30, 20) / 2).toBeCloseTo(
			BEAM_HALF_WIDTH,
			5,
		);
	});

	test("dynamic chains merge short segments instead of clamping into overlap", async () => {
		const { world, events } = await fixture(false);
		// Four 0.6-unit segments: an unclamped half is 0.3 < the 0.5 minimum,
		// so the old clamp produced half=0.5 boxes on 0.6 centers — pairwise
		// overlaps of 0.4. Merged instead: one body spanning the small run.
		events.onSpawnFreehand({
			kind: "chain",
			points: [
				{ x: 0, y: 0 },
				{ x: 0.6, y: 0 },
				{ x: 1.2, y: 0 },
				{ x: 1.8, y: 0 },
				{ x: 2.4, y: 0 },
				{ x: 40, y: 0 },
			],
		});
		const boxes = chainBoxes(world);
		// The five 0.6-unit segments accumulate into two ≥1-unit merged runs
		// ([0→1.2], [1.2→2.4]) plus the long tail — three bodies, none of
		// them clamped into their neighbor.
		expect(boxes.length).toBe(3);
		// No pair of distinct dynamic chain bodies overlaps: sorted by center,
		// each box's reach ends before the next begins.
		for (let i = 1; i < boxes.length; i++) {
			const prev = boxes[i - 1]!;
			const cur = boxes[i]!;
			expect(prev.cx + prev.halfWidth).toBeLessThanOrEqual(
				cur.cx - cur.halfWidth + 1e-6,
			);
		}
	});
});
