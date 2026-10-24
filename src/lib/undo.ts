/**
 * Snapshot undo/redo over the serializable scene document. The history holds
 * paired pre-action and post-action snapshots. beginAction() captures the
 * live scene at gesture/discrete-action start; commit() stores its result.
 * Restore is a full rebuild
 * from the document (destroy + recreate Rapier state) — acceptable for a
 * sandbox at this scale and measured in the e2e. The camera is NOT part of a
 * snapshot: the user's viewport is theirs, undo restores the scene, not the
 * view.
 *
 * Physics may evolve between actions without adding history entries. The app
 * commits once at boot to seed the initial scene.
 */
import { cloneDocEntities, type DocEntity } from "./document";

/** Max snapshots kept; committing past this drops the OLDEST state. */
export const UNDO_LIMIT = 50;

function same(a: readonly DocEntity[], b: readonly DocEntity[]): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Cursor-based undo/redo over document snapshots. `serialize` runs after the
 * mutation has been applied; `restore` replaces the whole scene. `commit`
 * skips no-ops (a click-drag that moved nothing) by comparing against the
 * current entry, so undo never appears to do nothing.
 */
export class UndoStack {
	/**
	 * Full state history; entries up to `cursor` are undoable-to states and
	 * `history[cursor]` mirrors the live document. Entries past the cursor
	 * are the redo tail; `commit` truncates them (redo clears on new action).
	 */
	private history: Snapshot[] = [];
	private cursor = -1;
	private before: Snapshot[] = [];
	private pending: Snapshot | null = null;

	/** Capture the live scene once, before a gesture or discrete mutation. */
	beginAction(): void {
		this.pending ??= cloneDocEntities(this.serialize());
	}

	cancelAction(): void {
		this.pending = null;
	}

	/** Reset is not undoable. Seed a new history from the cleared scene. */
	clear(): void {
		this.history = [];
		this.before = [];
		this.cursor = -1;
		this.pending = null;
		this.commit();
	}

	/**
	 * Invoked after commit/undo/redo — the UI hook for undo/redo button
	 * disabled states.
	 */
	onChange: (() => void) | null = null;

	constructor(
		private readonly serialize: () => readonly DocEntity[],
		private readonly restore: (entities: readonly DocEntity[]) => void,
		private readonly limit: number = UNDO_LIMIT,
	) {}

	/** Snapshot the (post-action) document; clears the redo tail. */
	commit(): void {
		const snapshot = cloneDocEntities(this.serialize());
		const current = this.history[this.cursor];
		const before = this.pending ?? current ?? snapshot;
		this.pending = null;
		if (this.cursor >= 0 && same(before, snapshot)) return;
		this.before.length = this.cursor + 1;
		this.before.push(cloneDocEntities(before));
		// Truncate the redo tail (redo clears on any new action), then append.
		// Capping drops the OLDEST state.
		this.history.length = this.cursor + 1;
		this.history.push(snapshot);
		this.cursor = this.history.length - 1;
		if (this.history.length > this.limit) {
			this.history.shift();
			this.before.shift();
			this.cursor = this.history.length - 1;
		}
		this.onChange?.();
	}

	/** Step back one state; false when already at the oldest known state. */
	undo(): boolean {
		if (this.cursor <= 0) return false;
		this.pending = null;
		const target = this.before[this.cursor];
		this.cursor -= 1;
		if (!target) return false;
		this.restore(target);
		this.onChange?.();
		return true;
	}

	/** Step forward one state; false when there is nothing to redo. */
	redo(): boolean {
		if (this.cursor >= this.history.length - 1) return false;
		this.cursor += 1;
		const target = this.history[this.cursor];
		if (!target) return false;
		this.restore(target);
		this.onChange?.();
		return true;
	}

	get canUndo(): boolean {
		return this.cursor > 0;
	}

	get canRedo(): boolean {
		return this.cursor < this.history.length - 1;
	}

	/** Stack depths, for debug probes and tests. */
	depths(): { undo: number; redo: number } {
		return {
			undo: this.cursor,
			redo: this.history.length - 1 - this.cursor,
		};
	}
}

/** One snapshot of the document (an alias-free deep copy). */
type Snapshot = DocEntity[];
