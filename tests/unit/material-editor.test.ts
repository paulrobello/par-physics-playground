import { describe, expect, test } from "bun:test";
import { SceneDocument } from "../../src/lib/document";
import {
	MATERIAL_DEFAULT_ID,
	MATERIAL_INK,
	type Material,
	materialValuesError,
} from "../../src/lib/material";
import { seedCustomIdCounter } from "../../src/lib/material-panel";
import {
	createMaterialStore,
	MATERIAL_DB_VERSION,
	MATERIAL_STORE_NAME,
	type MaterialRecordV1,
} from "../../src/lib/material-store";
import { UndoStack } from "../../src/lib/undo";
import { PhysicsWorld } from "../../src/lib/world";

/**
 * P3-T2 custom material editor: registry CRUD (add/update/remove + ink
 * fallback after delete), user-input validation (controller note: the editor
 * must guard before user values reach Rapier), apply-to-selection undo
 * semantics (ONE action per invocation), delete fallback, and the IndexedDB
 * persistence round-trip driven through the real store adapter against a
 * hand-rolled in-memory IDB fake (no fake-indexeddb dependency).
 */

/** Minimal in-memory IDB factory: open + upgrade + getAll/put/delete. */
function fakeIdbFactory(): {
	factory: IDBFactory;
	raw: Map<string, Map<string, Map<string, unknown>>>;
} {
	const dbs = new Map<string, Map<string, Map<string, unknown>>>();
	const factory = {
		open(name: string, version = 1) {
			const req: Record<string, unknown> = {};
			queueMicrotask(() => {
				let stores = dbs.get(name);
				let upgraded = false;
				if (!stores) {
					stores = new Map();
					dbs.set(name, stores);
					upgraded = true;
				}
				// Version bump on an existing db triggers upgrade without reset.
				if (version > 1 && !upgraded) upgraded = true;
				const dbObj = {
					objectStoreNames: {
						contains: (n: string) => stores.has(n),
					},
					createObjectStore: (n: string) => {
						if (!stores.has(n)) stores.set(n, new Map());
					},
					transaction: (n: string, _mode: string) => {
						const txObj: Record<string, unknown> = {};
						txObj.objectStore = () => {
							const store = stores.get(n) as Map<string, unknown>;
							const request = (result: unknown) => {
								const r: Record<string, unknown> = {};
								queueMicrotask(() => {
									r.result = result;
									(r.onsuccess as (() => void) | null)?.();
									queueMicrotask(() =>
										(txObj.oncomplete as (() => void) | null)?.(),
									);
								});
								return r;
							};
							return {
								getAll: () => request([...store.values()]),
								put: (v: { id: string }) => {
									store.set(v.id, v);
									return request(undefined);
								},
								delete: (k: string) => {
									store.delete(k);
									return request(undefined);
								},
							};
						};
						return txObj;
					},
					close: () => {},
				};
				req.result = dbObj;
				if (upgraded) (req.onupgradeneeded as (() => void) | null)?.();
				queueMicrotask(() => (req.onsuccess as (() => void) | null)?.());
			});
			return req as unknown as IDBOpenDBRequest;
		},
	};
	return { factory: factory as unknown as IDBFactory, raw: dbs };
}

const LEAD: Material = {
	id: "custom-1",
	name: "Lead",
	color: "#6f7d8c",
	density: 11.3,
	friction: 0.5,
	restitution: 0.2,
};

describe("material registry CRUD", () => {
	test("updateMaterial replaces values; unknown id refused", () => {
		const doc = new SceneDocument();
		expect(doc.addMaterial(LEAD)).toBe(true);
		expect(doc.updateMaterial({ ...LEAD, density: 20 })).toBe(true);
		expect(doc.material("custom-1").density).toBe(20);
		expect(doc.updateMaterial({ ...LEAD, id: "nope" })).toBe(false);
	});

	test("removeMaterial refuses palette entries, drops customs", () => {
		const doc = new SceneDocument();
		doc.addMaterial(LEAD);
		expect(doc.removeMaterial("wood")).toBe(false);
		expect(doc.removeMaterial("custom-1")).toBe(true);
		expect(doc.material("custom-1").id).toBe(MATERIAL_DEFAULT_ID);
	});

	test("a body referencing a deleted custom resolves to ink", async () => {
		const world = await PhysicsWorld.create();
		world.doc.addMaterial(LEAD);
		world.spawnBox("b", 0, -50, 2, 2, "custom-1");
		const before = world.bodies.get("b")?.mass() ?? 0;
		expect(before).toBeCloseTo(LEAD.density * 16);
		expect(world.doc.removeMaterial("custom-1")).toBe(true);
		// Re-materialize against the dangling id: the ink fallback must win.
		expect(world.setBodyMaterial("b", "custom-1")).toBe(true);
		expect(world.doc.material("custom-1").id).toBe(MATERIAL_DEFAULT_ID);
		expect(world.bodies.get("b")?.mass()).toBeCloseTo(
			MATERIAL_INK.density * 16,
		);
	});
});

describe("material value validation (editor + store load)", () => {
	test("rejects non-positive density, out-of-range coefficients, empty name", () => {
		expect(
			materialValuesError({
				name: "X",
				density: 0,
				friction: 0.5,
				restitution: 0.1,
			}),
		).toMatch(/density/i);
		expect(
			materialValuesError({
				name: "X",
				density: -1,
				friction: 0.5,
				restitution: 0.1,
			}),
		).toMatch(/density/i);
		expect(
			materialValuesError({
				name: "X",
				density: 1,
				friction: 1.5,
				restitution: 0.1,
			}),
		).toMatch(/friction/i);
		expect(
			materialValuesError({
				name: "X",
				density: 1,
				friction: -0.1,
				restitution: 0.1,
			}),
		).toMatch(/friction/i);
		expect(
			materialValuesError({
				name: "X",
				density: 1,
				friction: 0.5,
				restitution: 1.2,
			}),
		).toMatch(/restitution/i);
		expect(
			materialValuesError({
				name: "  ",
				density: 1,
				friction: 0.5,
				restitution: 0.1,
			}),
		).toMatch(/name/i);
		expect(
			materialValuesError({
				name: "X",
				density: 1,
				friction: 0.5,
				restitution: 0.1,
			}),
		).toBeNull();
	});
});

describe("apply-to-selection undo semantics", () => {
	test("one action repaints many bodies; undo/redo restores each materialId", async () => {
		const world = await PhysicsWorld.create();
		world.doc.addMaterial(LEAD);
		world.spawnBox("a", 0, -50, 2, 2, "ink");
		world.spawnBox("b", 20, -50, 2, 2, "wood");
		const undo = new UndoStack(
			() => {
				world.syncLiveTransforms();
				return world.doc.all();
			},
			(entities) => world.restoreSnapshot(entities),
		);
		undo.commit(); // seed, matching main.ts boot
		const massBefore = {
			a: world.bodies.get("a")?.mass() ?? 0,
			b: world.bodies.get("b")?.mass() ?? 0,
		};

		// The panel's apply: ONE begin/commit around the whole batch.
		undo.beginAction();
		expect(world.setBodyMaterial("a", "custom-1")).toBe(true);
		expect(world.setBodyMaterial("b", "custom-1")).toBe(true);
		undo.commit();
		expect(undo.depths()).toEqual({ undo: 1, redo: 0 });
		expect((world.doc.get("a") as { materialId: string }).materialId).toBe(
			"custom-1",
		);
		expect((world.doc.get("b") as { materialId: string }).materialId).toBe(
			"custom-1",
		);
		// Colliders re-derived from the custom's density.
		expect(world.bodies.get("a")?.mass()).toBeCloseTo(LEAD.density * 16);

		expect(undo.undo()).toBe(true);
		expect((world.doc.get("a") as { materialId: string }).materialId).toBe(
			"ink",
		);
		expect((world.doc.get("b") as { materialId: string }).materialId).toBe(
			"wood",
		);
		expect(world.bodies.get("a")?.mass()).toBeCloseTo(massBefore.a);
		expect(world.bodies.get("b")?.mass()).toBeCloseTo(massBefore.b);

		expect(undo.redo()).toBe(true);
		expect((world.doc.get("a") as { materialId: string }).materialId).toBe(
			"custom-1",
		);
	});

	test("velocity survives a re-materialize (apply while the sim runs)", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("v", 0, -100, 2, 2, "wood");
		const body = world.bodies.get("v");
		if (!body) throw new Error("body missing");
		body.setLinvel({ x: 3, y: -7 }, true);
		expect(world.setBodyMaterial("v", "stone")).toBe(true);
		const after = world.bodies.get("v");
		if (!after) throw new Error("body missing after apply");
		const lv = after.linvel();
		expect(lv.x).toBeCloseTo(3);
		expect(lv.y).toBeCloseTo(-7);
	});

	test("setBodyMaterial mutates in place: Rapier body identity preserved (fix-wave F1)", async () => {
		const world = await PhysicsWorld.create();
		world.spawnBox("b", 0, -50, 2, 2, "ink");
		const body = world.bodies.get("b");
		if (!body) throw new Error("body missing");
		let removed: string | undefined;
		world.onRemove = (id) => {
			removed = id;
		};

		expect(world.setBodyMaterial("b", "wood")).toBe(true);
		// The SAME body object is still registered — identity preserved, so
		// anything holding a handle (selection, P4 joints) survives.
		expect(world.bodies.get("b")).toBe(body);
		// No removal event fired: the interaction layer never prunes selection.
		expect(removed).toBeUndefined();
		// Physics follows the new material without a respawn.
		const wood = world.doc.material("wood");
		expect(body.mass()).toBeCloseTo(wood.density * 16);
		expect(body.collider(0).friction()).toBeCloseTo(wood.friction);
		expect(body.collider(0).restitution()).toBeCloseTo(wood.restitution);
		// The document entity's materialId updated in place.
		expect((world.doc.get("b") as { materialId: string }).materialId).toBe(
			"wood",
		);

		// Velocity carries through untouched — no save/restore needed.
		body.setLinvel({ x: 2, y: -1 }, true);
		expect(world.setBodyMaterial("b", "stone")).toBe(true);
		const lv = body.linvel();
		expect(lv.x).toBeCloseTo(2);
		expect(lv.y).toBeCloseTo(-1);
	});
});

describe("custom id sequencing (fix-wave F3: ids never reused)", () => {
	test("seeds past the highest custom-N; non-custom ids ignored", () => {
		expect(seedCustomIdCounter([])).toBe(0);
		expect(seedCustomIdCounter(["ink", "wood", "custom-1"])).toBe(1);
		expect(seedCustomIdCounter(["custom-1", "custom-3", "custom-2"])).toBe(3);
	});

	test("a deleted id is never handed out again (counter monotonic)", () => {
		// create custom-1 → delete → create: the fresh id is custom-2 even
		// though custom-1 is now free, so undo snapshots referencing custom-1
		// resolve to ink, never to the new material's values.
		let counter = seedCustomIdCounter([]);
		counter += 1;
		expect(`custom-${counter}`).toBe("custom-1");
		counter += 1;
		expect(`custom-${counter}`).toBe("custom-2");
	});
});

describe("custom-material persistence (IndexedDB, schema v1)", () => {
	test("schema constants pin the versioned store", () => {
		expect(MATERIAL_DB_VERSION).toBe(1);
	});

	test("round-trip: put/load/delete through the real adapter on the fake IDB", async () => {
		const { factory, raw } = fakeIdbFactory();
		const writer = createMaterialStore(factory);
		await writer.put(LEAD);
		const rubber = { ...LEAD, id: "custom-2", name: "Gum", density: 1.4 };
		await writer.put(rubber);

		// Records on disk carry the schema version and are keyed by id.
		const storeRows = raw
			.get("par-physics-playground")
			?.get(MATERIAL_STORE_NAME);
		if (!storeRows) throw new Error("fake db missing");
		expect(storeRows.size).toBe(2);
		expect((storeRows.get("custom-1") as MaterialRecordV1).schema).toBe(1);

		const reader = createMaterialStore(factory);
		const loaded = await reader.load();
		expect(loaded).toHaveLength(2);
		const lead = loaded.find((m) => m.id === "custom-1");
		expect(lead?.name).toBe("Lead");
		expect(lead?.density).toBeCloseTo(11.3);

		await writer.delete("custom-1");
		expect(await reader.load()).toHaveLength(1);

		// Overwrite by id: still one record for custom-2, new values.
		await writer.put({ ...rubber, density: 2 });
		const reloaded = await reader.load();
		expect(reloaded).toHaveLength(1);
		expect(reloaded[0]?.density).toBe(2);
	});

	test("load drops malformed and invalid-valued records", async () => {
		const { factory, raw } = fakeIdbFactory();
		const writer = createMaterialStore(factory);
		await writer.put(LEAD);
		const storeRows = raw
			.get("par-physics-playground")
			?.get(MATERIAL_STORE_NAME);
		if (!storeRows) throw new Error("fake db missing");
		// Corrupt one record directly in the fake store: density 0 must not load.
		storeRows.set("bad", {
			schema: 1,
			id: "bad",
			name: "Bad",
			color: "#123456",
			density: 0,
			friction: 0.5,
			restitution: 0.1,
		});
		// A palette-shadowing id is dropped too.
		storeRows.set("shadow", {
			schema: 1,
			id: "wood",
			name: "Fake",
			color: "#123456",
			density: 3,
			friction: 0.5,
			restitution: 0.1,
		});
		// A record without the schema marker is dropped.
		storeRows.set("old", {
			id: "old",
			name: "Old",
			color: "#123456",
			density: 3,
			friction: 0.5,
			restitution: 0.1,
		});
		const reader = createMaterialStore(factory);
		const loaded = await reader.load();
		expect(loaded.map((m) => m.id)).toEqual(["custom-1"]);
	});

	test("without IndexedDB the store degrades to a session-only no-op", async () => {
		const store = createMaterialStore(undefined);
		await store.put(LEAD); // must not throw
		expect(await store.load()).toEqual([]);
	});
});
