/**
 * P5 per-frame allocation card: the each* iteration methods must visit
 * exactly their kind in insertion order and agree with the array forms —
 * the render path's per-frame walk runs these instead of materializing
 * arrays every frame.
 */
import { describe, expect, test } from "bun:test";
import { SceneDocument } from "../../src/lib/document";

describe("SceneDocument each* iteration", () => {
	test("eachJoint/eachThruster/eachLabel visit exactly their kind, in order", () => {
		const doc = new SceneDocument();
		doc.add({
			kind: "body",
			id: "b1",
			x: 0,
			y: 0,
			rot: 0,
			isStatic: false,
			materialId: "ink",
			shape: { kind: "box", halfWidth: 1, halfHeight: 1 },
		});
		doc.add({ kind: "label", id: "l1", x: 0, y: 0, rot: 0, text: "a" });
		doc.add({
			kind: "joint",
			id: "j1",
			jointType: "pin",
			params: { kind: "pin" },
			bodyA: "b1",
			bodyB: null,
			anchorA: { x: 0, y: 0 },
			anchorB: { x: 0, y: 0 },
		});
		doc.add({ kind: "label", id: "l2", x: 1, y: 0, rot: 0, text: "b" });
		doc.add({
			kind: "thruster",
			id: "t1",
			bodyId: "b1",
			anchorX: 0,
			anchorY: 0,
			angle: 0,
			strength: 1,
			on: true,
		});

		const jointIds: string[] = [];
		doc.eachJoint((j) => jointIds.push(j.id));
		expect(jointIds).toEqual(["j1"]);

		const thrusterIds: string[] = [];
		doc.eachThruster((t) => thrusterIds.push(t.id));
		expect(thrusterIds).toEqual(["t1"]);

		const labelIds: string[] = [];
		doc.eachLabel((l) => labelIds.push(l.id));
		expect(labelIds).toEqual(["l1", "l2"]);

		// The array forms still agree (the iteration is exactly equivalent).
		expect(doc.joints().map((j) => j.id)).toEqual(jointIds);
		expect(doc.thrusters().map((t) => t.id)).toEqual(thrusterIds);
		const labelEntities = doc.all().filter((e) => e.kind === "label");
		expect(labelEntities.map((e) => e.id)).toEqual(labelIds);
	});
});
