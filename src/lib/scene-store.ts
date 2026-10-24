/**
 * IndexedDB scene store (P5-T1): named saved scenes plus the working
 * scene's autosave. localStorage is NOT used for scenes — 1000-object
 * documents blow its 5 MB synchronous budget (PRD D8). The store is
 * schema-versioned from day one (PRD R4): bump DB_VERSION and add a
 * migration case in `open()` when the record shape changes.
 */
import type { SceneFile } from "./scene-file";

const DB_NAME = "ppg-scenes";
const DB_VERSION = 1;
const SCENES_STORE = "scenes";
const META_STORE = "meta";
const AUTOSAVE_KEY = "autosave";

/** A stored scene's row: the file plus its bookkeeping. */
export interface StoredScene {
	name: string;
	updatedAt: number;
	file: SceneFile;
}

/** The IndexedDB surface the store needs (window.indexedDB satisfies it). */
interface IdbLike {
	open(name: string, version: number): IDBOpenDBRequest;
}

function requestAsPromise<T>(request: IDBRequest<T>): Promise<T> {
	return new Promise((resolve, reject) => {
		request.onsuccess = () => resolve(request.result);
		request.onerror = () => reject(request.error);
	});
}

export class SceneStore {
	private db: IDBDatabase | null = null;

	constructor(private readonly idb: IdbLike = globalThis.indexedDB) {}

	/**
	 * Open (and migrate) the database. v1 creates both stores; later
	 * versions add their migration steps here, keyed by oldVersion.
	 */
	async open(): Promise<void> {
		const request = this.idb.open(DB_NAME, DB_VERSION);
		request.onupgradeneeded = () => {
			const db = request.result;
			if (request.transaction && db.objectStoreNames.contains(SCENES_STORE)) {
				return; // migration path for future versions
			}
			db.createObjectStore(SCENES_STORE, { keyPath: "name" });
			db.createObjectStore(META_STORE, { keyPath: "key" });
		};
		this.db = await requestAsPromise(request);
	}

	private requireDb(): IDBDatabase {
		if (!this.db) throw new Error("SceneStore.open() must be awaited first");
		return this.db;
	}

	private async inStore<T>(
		storeName: string,
		mode: IDBTransactionMode,
		run: (store: IDBObjectStore) => IDBRequest<T> | void,
	): Promise<T | undefined> {
		const tx = this.requireDb().transaction(storeName, mode);
		const request = run(tx.objectStore(storeName));
		return request ? await requestAsPromise(request) : undefined;
	}

	/** Save (or overwrite) a named scene. */
	async save(name: string, file: SceneFile): Promise<void> {
		const row: StoredScene = { name, updatedAt: Date.now(), file };
		await this.inStore(SCENES_STORE, "readwrite", (s) => s.put(row));
	}

	/** Load a named scene; null when absent. */
	async load(name: string): Promise<SceneFile | null> {
		const row = await this.inStore<StoredScene | undefined>(
			SCENES_STORE,
			"readonly",
			(s) => s.get(name),
		);
		return row?.file ?? null;
	}

	/** All saved scenes, newest first (the menu order). */
	async list(): Promise<{ name: string; updatedAt: number }[]> {
		const rows =
			(await this.inStore<StoredScene[]>(SCENES_STORE, "readonly", (s) =>
				s.getAll(),
			)) ?? [];
		return rows
			.map(({ name, updatedAt }) => ({ name, updatedAt }))
			.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/** Rename; false when the old name is absent or the new one is taken. */
	async rename(oldName: string, newName: string): Promise<boolean> {
		if (oldName === newName) return true;
		const row = await this.inStore<StoredScene | undefined>(
			SCENES_STORE,
			"readonly",
			(s) => s.get(oldName),
		);
		if (!row) return false;
		const taken = await this.inStore<StoredScene | undefined>(
			SCENES_STORE,
			"readonly",
			(s) => s.get(newName),
		);
		if (taken) return false;
		await this.inStore(SCENES_STORE, "readwrite", (s) => {
			s.delete(oldName);
			return s.put({ ...row, name: newName, updatedAt: Date.now() });
		});
		return true;
	}

	/** Delete a named scene; false when absent. */
	async delete(name: string): Promise<boolean> {
		const row = await this.inStore<StoredScene | undefined>(
			SCENES_STORE,
			"readonly",
			(s) => s.get(name),
		);
		if (!row) return false;
		await this.inStore(SCENES_STORE, "readwrite", (s) => s.delete(name));
		return true;
	}

	/** Persist the working scene (debounced by the caller). */
	async autosave(file: SceneFile): Promise<void> {
		await this.inStore(META_STORE, "readwrite", (s) =>
			s.put({ key: AUTOSAVE_KEY, updatedAt: Date.now(), file }),
		);
	}

	/** The autosaved working scene; null on a fresh profile. */
	async loadAutosave(): Promise<SceneFile | null> {
		const row = await this.inStore<
			{ key: string; file: SceneFile } | undefined
		>(META_STORE, "readonly", (s) => s.get(AUTOSAVE_KEY));
		return row?.file ?? null;
	}
}
