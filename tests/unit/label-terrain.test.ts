import { describe, expect, test } from "bun:test";
import { defaultBody, SceneDocument } from "../../src/lib/document";
import { createToolEvents } from "../../src/lib/interaction";
import {
	type BeamGeom,
	type DragRect,
	effectiveLabelFontSize,
	LABEL_CHAR_WIDTH,
	labelBounds,
	pickLabel,
	ToolSession,
	type ToolSessionEvents,
} from "../../src/lib/tools";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * P2-T4: label entities round-trip through the document, static spawn paths
 * reach the Rapier body, and the text tool's inline edit drives the session.
 */

describe("SceneDocument labels", () => {
	test("label round-trips: add, text, transform, remove, mixed ordering", () => {
		const doc = new SceneDocument();
		doc.add(
			defaultBody("b1", { kind: "box", halfWidth: 1, halfHeight: 1 }, 0, 0),
		);
		doc.add({ kind: "label", id: "l1", x: 3, y: -2, rot: 0, text: "" });
		doc.add(defaultBody("b2", { kind: "circle", radius: 1 }, 5, 5));
		// One namespace, insertion order preserved across kinds.
		expect(doc.ids()).toEqual(["b1", "l1", "b2"]);
		expect(doc.get("l1")?.kind).toBe("label");
		expect(doc.setLabelText("l1", "Ramp A")).toBe(true);
		expect(doc.get("l1")).toMatchObject({ kind: "label", text: "Ramp A" });
		// setTransform moves labels like any entity.
		expect(doc.setTransform("l1", 4, -3, 0.25)).toBe(true);
		const moved = doc.get("l1");
		expect(moved?.x).toBe(4);
		expect(moved?.rot).toBeCloseTo(0.25);
		// setLabelText rejects bodies (and unknown ids).
		expect(doc.setLabelText("b1", "nope")).toBe(false);
		expect(doc.setLabelText("missing", "nope")).toBe(false);
		expect(doc.remove("l1")).toBe(true);
		expect(doc.ids()).toEqual(["b1", "b2"]);
	});
});

describe("pickLabel", () => {
	const labels = [
		{ id: "a", x: 10, y: 10, text: "Hello" },
		{ id: "b", x: 40, y: 40, text: "B" },
	];

	test("hit inside the estimated bounds, anchored at the baseline start", () => {
		const size = effectiveLabelFontSize(1);
		const w = size * 0.6 * "Hello".length;
		// Anchor corner and far corner both hit.
		expect(pickLabel(labels, 10, 10)).toBe("a");
		expect(pickLabel(labels, 10 + w, 10 - size * 0.85)).toBe("a");
		// Just outside the right edge misses.
		expect(pickLabel(labels, 10 + w + 0.5, 10)).toBeUndefined();
	});

	test("topmost (later) label wins on overlap", () => {
		const stacked = [
			{ id: "under", x: 0, y: 0, text: "xxxxx" },
			{ id: "over", x: 0.2, y: 0, text: "x" },
		];
		expect(pickLabel(stacked, 0.5, -0.2)).toBe("over");
	});

	test("labelBounds geometry: baseline anchor, descender allowance", () => {
		const size = effectiveLabelFontSize(1);
		const b = labelBounds(0, 0, "ab", size);
		expect(b.x0).toBe(0);
		expect(b.y0).toBeCloseTo(-size * 0.85);
		expect(b.y1).toBeCloseTo(size * 0.3);
		expect(b.x1).toBeCloseTo(2 * size * 0.6);
		// Single glyph still gets a minimum width of one font size.
		expect(labelBounds(0, 0, "", size).x1).toBeCloseTo(size);
	});

	test("pick bounds match the rendered font size at every zoom", () => {
		// The one font-size computation: the picker's hit box and the
		// renderer's drawn glyphs share effectiveLabelFontSize, so the bounds
		// cover exactly the visible text at any zoom.
		const text = "Ramp A";
		const expectedWidth = (zoom: number): number =>
			text.length * LABEL_CHAR_WIDTH * effectiveLabelFontSize(zoom);
		for (const zoom of [1, 4]) {
			const size = effectiveLabelFontSize(zoom);
			const b = labelBounds(0, 0, text, size);
			// Bounds cover the effective rendered width (the same formula the
			// renderer's font size feeds through LABEL_CHAR_WIDTH).
			expect(b.x1).toBeCloseTo(expectedWidth(zoom), 9);
			expect(b.x1).toBeGreaterThanOrEqual(
				text.length * 0.5 * effectiveLabelFontSize(zoom),
			);
			// A click on the far end of the glyphs hits at that zoom...
			expect(
				pickLabel(
					[{ id: "l", x: 0, y: 0, text }],
					b.x1 - 0.1,
					-size * 0.4,
					zoom,
				),
			).toBe("l");
			// ...and a click just past the drawn text misses.
			expect(
				pickLabel([{ id: "l", x: 0, y: 0, text }], b.x1 + 0.5, 0, zoom),
			).toBeUndefined();
		}
		// The clamp actually changes size between these zooms.
		expect(effectiveLabelFontSize(4)).toBeLessThan(effectiveLabelFontSize(1));
	});
});

describe("label entities in the world", () => {
	test("addLabel / setLabelText / labels / duplicateLabel / removeBody", async () => {
		const world = await PhysicsWorld.create();
		expect(world.addLabel("l1", 5, -6)).toBe("l1");
		world.setLabelText("l1", "crate drop");
		expect(world.labels()).toHaveLength(1);
		const label = world.labelOf("l1");
		expect(label?.text).toBe("crate drop");
		expect(label?.x).toBe(5);
		// Labels have no Rapier body.
		expect(world.bodies.has("l1")).toBe(false);
		// Offset copy.
		expect(world.duplicateLabel("l1", "l2", 1, -1)).toBe("l2");
		const copy = world.labelOf("l2");
		expect(copy?.x).toBe(6);
		expect(copy?.text).toBe("crate drop");
		// Duplicate of an unknown/missing id returns undefined.
		expect(world.duplicateLabel("nope", "l3", 1, 1)).toBeUndefined();
		// removeBody removes the doc-only label.
		world.removeBody("l1");
		expect(world.labelOf("l1")).toBeUndefined();
		expect(world.labelOf("l2")).toBeDefined();
	}, 10_000);
});

describe("static spawn paths (terrain)", () => {
	test("spawnEntity with isStatic creates a fixed Rapier body that never falls", async () => {
		const world = await PhysicsWorld.create();
		world.spawnEntity({
			...defaultBody(
				"plat",
				{ kind: "box", halfWidth: 10, halfHeight: 1 },
				0,
				-50,
			),
			isStatic: true,
		});
		expect(world.bodies.get("plat")?.isFixed()).toBe(true);
		const entity = world.doc.get("plat");
		expect(entity?.kind === "body" && entity.isStatic).toBe(true);
		for (let i = 0; i < 60; i++) world.step();
		const p = world.bodyPosition("plat");
		expect(p?.y).toBeCloseTo(-50, 6);
	}, 10_000);

	test("spawnPolygon and spawnCircle take the static flag", async () => {
		const world = await PhysicsWorld.create();
		const tri = [
			{ x: -2, y: -2 },
			{ x: 2, y: -2 },
			{ x: 0, y: 2 },
		];
		world.spawnPolygon("ramp", tri, true);
		expect(world.bodies.get("ramp")?.isFixed()).toBe(true);
		world.spawnCircle("ball", 0, 0, 1, true);
		expect(world.bodies.get("ball")?.isFixed()).toBe(true);
	}, 10_000);

	test("createToolEvents static mode reaches every draw-tool spawn", async () => {
		const world = await PhysicsWorld.create();
		let staticSpawn = false;
		const events = createToolEvents(world, {
			isStaticSpawn: () => staticSpawn,
		});
		const beam: BeamGeom = {
			cx: 0,
			cy: 0,
			rot: 0.3,
			halfLength: 8,
			halfWidth: 0.25,
		};
		// Ids come from the module-global freshBodyId counter, which other
		// test files consume too — never hardcode body-N here (CI's file
		// order broke on exactly that; linux readdir ≠ APFS readdir).
		const lastSpawnedId = (): string => {
			const ids = [...world.bodies.keys()];
			const id = ids.at(-1);
			if (!id) throw new Error("no body spawned");
			return id;
		};
		events.onSpawnLine(beam);
		const beamId = lastSpawnedId();
		const beamEntity = world.doc.get(beamId);
		expect(beamEntity?.kind === "body" && beamEntity.isStatic).toBe(false);
		staticSpawn = true;
		const rect: DragRect = { cx: 5, cy: -5, halfWidth: 3, halfHeight: 1 };
		events.onSpawnBox(rect);
		const boxId = lastSpawnedId();
		events.onSpawnCircle({ cx: -5, cy: -5, radius: 2 });
		const circleId = lastSpawnedId();
		events.onSpawnPolygon([
			{ x: 0, y: 0 },
			{ x: 4, y: 0 },
			{ x: 2, y: 2 },
		]);
		const polygonId = lastSpawnedId();
		for (const id of [boxId, circleId, polygonId]) {
			const entity = world.doc.get(id);
			expect(entity?.kind === "body" && entity.isStatic).toBe(true);
			expect(world.bodies.get(id)?.isFixed()).toBe(true);
		}
	}, 10_000);
});

describe("text tool session flow", () => {
	type Row = [string, unknown];

	function makeSession() {
		const log: Row[] = [];
		const events: ToolSessionEvents = {
			onSpawnBox() {},
			onSpawnCircle() {},
			onSpawnPolygon() {},
			onSpawnLine() {},
			onSpawnFreehand() {},
			onCreateLabel(pos) {
				log.push(["create", pos]);
				return "label-1";
			},
			onCommitLabel(id, text) {
				log.push(["commit", { id, text }]);
			},
			onDragStart() {},
			onDragMove() {},
			onDragEnd() {},
			onRotateStart() {},
			onRotate() {},
			onRotateEnd() {},
			onDelete(ids) {
				log.push(["delete", ids]);
			},
			onDuplicate() {
				return [];
			},
		};
		return { session: new ToolSession(events, () => undefined), log };
	}

	test("click places, typing edits, Enter commits", () => {
		const { session, log } = makeSession();
		session.setTool("text");
		session.pointerDown(10, -20);
		expect(log[0]).toEqual(["create", { x: 10, y: -20 }]);
		expect(session.isEditingText()).toBe(true);
		expect(session.preview()).toEqual({
			kind: "text",
			x: 10,
			y: -20,
			text: "",
		});
		for (const ch of "Hi!") session.editTextKey(ch);
		session.editTextBackspace();
		expect(session.preview()).toEqual({
			kind: "text",
			x: 10,
			y: -20,
			text: "Hi",
		});
		expect(session.commitText()).toBe(true);
		expect(log[1]).toEqual(["commit", { id: "label-1", text: "Hi" }]);
		expect(session.isEditingText()).toBe(false);
	});

	test("all-whitespace text discards the label", () => {
		const { session, log } = makeSession();
		session.setTool("text");
		session.pointerDown(0, 0);
		session.editTextKey(" ");
		expect(session.commitText()).toBe(true);
		expect(log).toEqual([
			["create", { x: 0, y: 0 }],
			["delete", ["label-1"]],
		]);
	});

	test("Escape cancels via commit (cancel path), and a tool switch commits too", () => {
		const { session, log } = makeSession();
		session.setTool("text");
		session.pointerDown(1, 2);
		session.editTextKey("a");
		session.cancel(); // the Escape path
		expect(log[1]).toEqual(["commit", { id: "label-1", text: "a" }]);
		session.editTextKey("b"); // no-op: not editing anymore
		expect(session.isEditingText()).toBe(false);
		// Second label commits on tool change.
		session.pointerDown(3, 4);
		session.editTextKey("z");
		session.setTool("select");
		expect(log).toContainEqual(["commit", { id: "label-1", text: "z" }]);
	});

	test("a click during editing commits the current label first", () => {
		const { session, log } = makeSession();
		session.setTool("text");
		session.pointerDown(1, 2);
		session.editTextKey("x");
		session.pointerDown(5, 6); // commits, then starts the next label
		expect(log[1]).toEqual(["commit", { id: "label-1", text: "x" }]);
		expect(log[2]).toEqual(["create", { x: 5, y: 6 }]);
	});

	test("staticMode is a session flag the interaction layer can read", () => {
		const { session } = makeSession();
		expect(session.staticMode).toBe(false);
		session.staticMode = true;
		expect(session.staticMode).toBe(true);
	});
});

describe("label editing through the document drag path", () => {
	test("paused-teleport drag moves doc-only entities (labels)", async () => {
		const world = await PhysicsWorld.create();
		const paused = true;
		const selected = new Set<string>();
		const events = createToolEvents(world, {
			isPaused: () => paused,
			selectedIds: () => selected,
		});
		world.addLabel("l1", 10, -10);
		world.setLabelText("l1", "drag me");
		selected.add("l1");
		events.onDragStart("l1", { x: 10, y: -10 });
		events.onDragMove({ x: 13, y: -12 });
		events.onDragEnd();
		const label = world.labelOf("l1");
		expect(label?.x).toBe(13);
		expect(label?.y).toBe(-12);
	}, 10_000);

	test("duplicate moves a label via the action path (Ctrl+D)", async () => {
		const world = await PhysicsWorld.create();
		const events = createToolEvents(world);
		world.addLabel("l1", 0, 0);
		world.setLabelText("l1", "tag");
		const newIds = events.onDuplicate(["l1"]);
		const copyId = newIds[0];
		expect(newIds).toHaveLength(1);
		expect(copyId).toBeDefined();
		const copy = world.labelOf(copyId as string);
		expect(copy?.text).toBe("tag");
		expect(copy?.x).toBe(1);
		expect(copy?.y).toBe(-1);
	}, 10_000);
});
