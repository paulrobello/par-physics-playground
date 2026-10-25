/**
 * IndexedDB persistence for user-defined custom materials (PRD P3 / D6, R4).
 * The store is schema-versioned from day one: database
 * "par-physics-playground" at version 1 with one object store
 * "custom-materials" holding flat records
 * `{ schema: 1, id, name, color, density, friction, restitution }` keyed by
 * `id`. Future schema changes bump MATERIAL_DB_VERSION and migrate inside the
 * open upgrade callback — the pattern P5's scene persistence follows.
 *
 * The IDB factory is injectable so unit tests drive the real adapter against
 * a hand-rolled in-memory fake (no extra dependency); without IndexedDB the
 * store degrades to a no-op (the library is session-only).
 */
import {
	MATERIAL_PREDEFINED,
	type Material,
	materialValuesError,
} from "./material";

export const MATERIAL_DB_NAME = "par-physics-playground";
export const MATERIAL_DB_VERSION = 1;
export const MATERIAL_STORE_NAME = "custom-materials";

/** Flat V1 record; `schema` pins the record shape for future migrations. */
export interface MaterialRecordV1 {
	schema: 1;
	id: string;
	name: string;
	color: string;
	density: number;
	friction: number;
	restitution: number;
	/** Brittle flag (optional; absent = false) preserved across sessions. */
	brittle?: boolean;
	/** Flammable flag (optional; absent = false) preserved across sessions. */
	flammable?: boolean;
	/** Melting flag (optional; absent = false) preserved across sessions. */
	melting?: boolean;
}

export interface MaterialStore {
	/** Valid persisted customs; store order is not guaranteed. */
	load(): Promise<Material[]>;
	put(material: Material): Promise<void>;
	delete(id: string): Promise<void>;
}

/** Accept only well-formed, valid-valued V1 records; everything else drops. */
function parseRecord(value: unknown): Material | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as {
		schema?: unknown;
		id?: unknown;
		name?: unknown;
		color?: unknown;
		density?: unknown;
		friction?: unknown;
		restitution?: unknown;
		brittle?: unknown;
		flammable?: unknown;
		melting?: unknown;
	};
	if (r.schema !== 1) return null;
	if (
		typeof r.id !== "string" ||
		typeof r.name !== "string" ||
		typeof r.color !== "string" ||
		typeof r.density !== "number" ||
		typeof r.friction !== "number" ||
		typeof r.restitution !== "number"
	)
		return null;
	if (!/^#[0-9a-fA-F]{6}$/.test(r.color)) return null;
	if (r.brittle !== undefined && typeof r.brittle !== "boolean") return null;
	if (r.flammable !== undefined && typeof r.flammable !== "boolean")
		return null;
	if (r.melting !== undefined && typeof r.melting !== "boolean") return null;
	if (MATERIAL_PREDEFINED.some((m) => m.id === r.id)) return null;
	const material: Material = {
		id: r.id,
		name: r.name,
		color: r.color,
		density: r.density,
		friction: r.friction,
		restitution: r.restitution,
		...(r.brittle ? { brittle: true } : {}),
		...(r.flammable ? { flammable: true } : {}),
		...(r.melting ? { melting: true } : {}),
	};
	return materialValuesError({
		name: material.name,
		density: material.density,
		friction: material.friction,
		restitution: material.restitution,
	})
		? null
		: material;
}

export function createMaterialStore(
	factory: IDBFactory | undefined = globalThis.indexedDB,
): MaterialStore {
	if (!factory) {
		// No IndexedDB (bun tests without the fake, some private modes): the
		// library degrades to session-only; the app works, persistence is off.
		return {
			load: async () => [],
			put: async () => {},
			delete: async () => {},
		};
	}
	const openDb = (): Promise<IDBDatabase> =>
		new Promise((resolve, reject) => {
			const req = factory.open(MATERIAL_DB_NAME, MATERIAL_DB_VERSION);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(MATERIAL_STORE_NAME)) {
					req.result.createObjectStore(MATERIAL_STORE_NAME, { keyPath: "id" });
				}
			};
			req.onsuccess = () => resolve(req.result);
			req.onerror = () =>
				reject(req.error ?? new Error("indexedDB open failed"));
		});
	/** Run one operation in its own transaction; resolves at transaction end. */
	const run = <T>(
		mode: IDBTransactionMode,
		fn: (store: IDBObjectStore) => IDBRequest,
	): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			void openDb().then(
				(db) => {
					let result!: T;
					const tx = db.transaction(MATERIAL_STORE_NAME, mode);
					tx.oncomplete = () => {
						db.close();
						resolve(result);
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error ?? new Error("indexedDB transaction aborted"));
					};
					tx.onerror = () => {}; // onabort fires too; avoid double-reject
					const req = fn(tx.objectStore(MATERIAL_STORE_NAME));
					req.onsuccess = () => {
						result = req.result as T;
					};
					req.onerror = () => {}; // onabort handles
				},
				(err: unknown) => reject(err),
			);
		});
	return {
		async load() {
			const rows = await run<unknown[]>("readonly", (store) => store.getAll());
			const materials: Material[] = [];
			for (const row of rows) {
				const material = parseRecord(row);
				if (material) materials.push(material);
			}
			return materials;
		},
		async put(material: Material) {
			const record: MaterialRecordV1 = { schema: 1, ...material };
			await run<void>("readwrite", (store) => store.put(record));
		},
		async delete(id: string) {
			await run<void>("readwrite", (store) => store.delete(id));
		},
	};
}
