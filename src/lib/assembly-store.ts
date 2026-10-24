/**
 * IndexedDB persistence for reusable assemblies (the material-store pattern:
 * schema-versioned records, an injectable IDB factory so unit tests drive the
 * real adapter against a hand-rolled in-memory fake, and a no-op degradation
 * when IndexedDB is unavailable). Assemblies live in their OWN database —
 * "par-physics-playground-assemblies" v1 — so the store's schema never
 * negotiates a version bump against the material store's shared
 * "par-physics-playground" database.
 *
 * A record carries the whole validated subset document; on load, every
 * record's file re-runs validateSceneFile (the import path's UNTRUSTED-data
 * gate) and malformed records drop instead of poisoning the library.
 */
import type { Assembly } from "./assembly";
import { type SceneFile, validateSceneFile } from "./scene-file";

export const ASSEMBLY_DB_NAME = "par-physics-playground-assemblies";
export const ASSEMBLY_DB_VERSION = 1;
export const ASSEMBLY_STORE_NAME = "assemblies";

/** Flat V1 record; `schema` pins the record shape for future migrations. */
export interface AssemblyRecordV1 {
	schema: 1;
	id: string;
	name: string;
	savedAt: number;
	file: SceneFile;
}

export interface AssemblyStore {
	/** Valid persisted assemblies; store order is not guaranteed. */
	load(): Promise<Assembly[]>;
	put(assembly: Assembly): Promise<void>;
	delete(id: string): Promise<void>;
}

/** Accept only well-formed V1 records whose file passes validation. */
function parseRecord(value: unknown): Assembly | null {
	if (typeof value !== "object" || value === null) return null;
	const r = value as {
		schema?: unknown;
		id?: unknown;
		name?: unknown;
		savedAt?: unknown;
		file?: unknown;
	};
	if (r.schema !== 1) return null;
	if (
		typeof r.id !== "string" ||
		r.id.length === 0 ||
		typeof r.name !== "string" ||
		r.name.length === 0 ||
		typeof r.savedAt !== "number"
	)
		return null;
	if (typeof r.file !== "object" || r.file === null) return null;
	const check = validateSceneFile(r.file);
	if (!check.ok) return null;
	return { id: r.id, name: r.name, file: check.file };
}

export function createAssemblyStore(
	factory: IDBFactory | undefined = globalThis.indexedDB,
): AssemblyStore {
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
			const req = factory.open(ASSEMBLY_DB_NAME, ASSEMBLY_DB_VERSION);
			req.onupgradeneeded = () => {
				if (!req.result.objectStoreNames.contains(ASSEMBLY_STORE_NAME)) {
					req.result.createObjectStore(ASSEMBLY_STORE_NAME, {
						keyPath: "id",
					});
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
					const tx = db.transaction(ASSEMBLY_STORE_NAME, mode);
					tx.oncomplete = () => {
						db.close();
						resolve(result);
					};
					tx.onabort = () => {
						db.close();
						reject(tx.error ?? new Error("indexedDB transaction aborted"));
					};
					tx.onerror = () => {}; // onabort fires too; avoid double-reject
					const req = fn(tx.objectStore(ASSEMBLY_STORE_NAME));
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
			const assemblies: Assembly[] = [];
			for (const row of rows) {
				const assembly = parseRecord(row);
				if (assembly) assemblies.push(assembly);
			}
			return assemblies;
		},
		async put(assembly: Assembly) {
			const record: AssemblyRecordV1 = {
				schema: 1,
				id: assembly.id,
				name: assembly.name,
				savedAt: assembly.file.savedAt,
				file: assembly.file,
			};
			await run<void>("readwrite", (store) => store.put(record));
		},
		async delete(id: string) {
			await run<void>("readwrite", (store) => store.delete(id));
		},
	};
}
