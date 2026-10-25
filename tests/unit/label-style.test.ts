import { describe, expect, test } from "bun:test";
import { type LabelEntity, SceneDocument } from "../../src/lib/document";
import { buildSceneFile, validateSceneFile } from "../../src/lib/scene-file";
import { labelBounds, pickLabel } from "../../src/lib/tools";

/** A label entity factory (defaults + patches). */
const makeLabel = (patch: Partial<LabelEntity> = {}): LabelEntity => ({
	kind: "label",
	id: "l1",
	x: 0,
	y: 0,
	rot: 0,
	text: "hello",
	...patch,
});

describe("label style fields", () => {
	test("setLabelStyle patches size/font/align; non-label ids refuse", () => {
		const doc = new SceneDocument();
		doc.add(makeLabel());
		expect(
			doc.setLabelStyle("l1", { size: 4, font: "mono", align: "center" }),
		).toBe(true);
		const e = doc.get("l1");
		expect(
			e?.kind === "label" &&
				e.size === 4 &&
				e.font === "mono" &&
				e.align === "center",
		).toBe(true);
		// Clearing size back to auto.
		expect(doc.setLabelStyle("l1", { size: undefined })).toBe(true);
		const cleared = doc.get("l1");
		expect(cleared?.kind === "label" && cleared.size === undefined).toBe(true);
		// Unknown / non-label ids refuse.
		expect(doc.setLabelStyle("nope", { size: 4 })).toBe(false);
	});

	test("labelBounds shifts the hit box by alignment", () => {
		const at = (align: "left" | "center" | "right") =>
			labelBounds(10, 20, "hello", 2, align);
		expect(at("left").x0).toBe(10);
		// Width = 5 chars × 0.6 × 2 = 6 → center starts 3 left of the anchor.
		const center = at("center");
		expect(center.x0).toBeCloseTo(7, 10);
		const right = at("right");
		expect(right.x1).toBeCloseTo(10, 10);
	});

	test("pickLabel honors a custom size and alignment", () => {
		const labels = [
			{
				id: "l1",
				x: 0,
				y: 0,
				text: "hi",
				rot: 0,
				size: 10,
				align: "center" as const,
			},
		];
		// Center-aligned: the box straddles x=0; a point left of the anchor hits.
		expect(pickLabel(labels, -3, -3, 1)).toBe("l1");
		// Far outside the estimated box (width ≈ 2 chars × 0.6 × 10 = 12 → ±6).
		expect(pickLabel(labels, -20, 30, 1)).toBeUndefined();
	});

	test("scene files round-trip the label style fields", () => {
		const doc = new SceneDocument();
		doc.add(
			makeLabel({ text: "styled", size: 6, font: "serif", align: "right" }),
		);
		const file = buildSceneFile(doc);
		const json = JSON.parse(JSON.stringify(file)) as {
			entities: Array<Record<string, unknown>>;
		};
		const entity = json.entities.find((e) => e.kind === "label");
		expect(entity?.size).toBe(6);
		expect(entity?.font).toBe("serif");
		expect(entity?.align).toBe("right");
		expect(validateSceneFile(json).ok).toBe(true);

		// Bad values are rejected.
		const bad = JSON.parse(JSON.stringify(file)) as {
			entities: Array<Record<string, unknown>>;
		};
		const target = bad.entities.find((e) => e.kind === "label");
		if (target) target.size = -2;
		expect(validateSceneFile(bad).ok).toBe(false);
	});
});
