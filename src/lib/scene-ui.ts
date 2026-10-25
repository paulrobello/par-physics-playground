/**
 * Scenes menu wiring (P5-T1/T2, D15 top bar): save/load/rename/delete named
 * scenes in the IndexedDB store, JSON export (download) and import
 * (validated upload). All world mutations route through the ordinary
 * restoreSnapshot path and reseed undo; every refusal is a visible notice.
 */
import { showNotice } from "./notice";
import {
	applySceneFile,
	buildSceneFile,
	validateSceneFile,
} from "./scene-file";
import type { SceneStore } from "./scene-store";
import type { UndoStack } from "./undo";
import type { PhysicsWorld } from "./world";

export interface SceneUIOptions {
	readonly topBar: HTMLElement;
	readonly world: PhysicsWorld;
	readonly undo: UndoStack;
	readonly store: SceneStore;
}

/** Replace the world with a validated scene file; false when refused. */
function restoreValidated(
	world: PhysicsWorld,
	undo: UndoStack,
	raw: unknown,
): boolean {
	const result = validateSceneFile(raw);
	if (!result.ok) {
		showNotice(`Import refused: ${result.error}`, "error");
		return false;
	}
	try {
		applySceneFile(world, result.file);
	} catch (err) {
		// applySceneFile is atomic (entities rolled back) — surface the
		// refusal instead of letting it die as an unhandled rejection.
		console.warn("[par-physics] scene restore failed", err);
		showNotice(
			"Import refused: the scene contains an entity that cannot be built",
			"error",
		);
		return false;
	}
	undo.clear();
	return true;
}

export function attachSceneUI(options: SceneUIOptions): void {
	const { topBar, world, undo, store } = options;
	const openButton = topBar.querySelector<HTMLButtonElement>(
		'[data-scenes="open"]',
	);
	const panel = topBar.querySelector<HTMLElement>("[data-scenes-menu]");
	const saveForm = topBar.querySelector<HTMLFormElement>(
		'[data-scenes="save-form"]',
	);
	const saveName = topBar.querySelector<HTMLInputElement>(
		'[data-scenes="save-name"]',
	);
	const list = topBar.querySelector<HTMLElement>('[data-scenes="list"]');
	const exportButton = topBar.querySelector<HTMLButtonElement>(
		'[data-scenes="export"]',
	);
	const importInput = topBar.querySelector<HTMLInputElement>(
		'[data-scenes="import"]',
	);
	const importOpen = topBar.querySelector<HTMLButtonElement>(
		'[data-scenes="import-open"]',
	);
	if (
		!openButton ||
		!panel ||
		!saveForm ||
		!saveName ||
		!list ||
		!exportButton ||
		!importInput ||
		!importOpen
	) {
		throw new Error("scenes menu elements missing from the top bar");
	}

	const refreshList = (): void => {
		store
			.list()
			.then((scenes) => {
				list.textContent = "";
				if (scenes.length === 0) {
					const hint = document.createElement("li");
					hint.className = "scenes-empty";
					hint.textContent = "No saved scenes yet";
					list.append(hint);
					return;
				}
				for (const { name } of scenes) {
					const li = document.createElement("li");
					li.dataset.sceneRow = name;
					const load = document.createElement("button");
					load.type = "button";
					load.dataset.sceneLoad = name;
					load.textContent = name;
					load.dataset.tip = `Load "${name}"`;
					const rename = document.createElement("button");
					rename.type = "button";
					rename.dataset.sceneRen = name;
					rename.textContent = "Rename";
					rename.dataset.tip = `Rename "${name}"`;
					const del = document.createElement("button");
					del.type = "button";
					del.dataset.sceneDel = name;
					del.textContent = "Delete";
					del.dataset.tip = `Delete "${name}"`;
					li.append(load, rename, del);
					list.append(li);
				}
			})
			.catch((err) => console.warn("[par-physics] scene list failed", err));
	};

	const setMenuOpen = (visible: boolean): void => {
		panel.hidden = !visible;
		openButton.setAttribute("aria-expanded", String(visible));
		if (visible) refreshList();
	};
	openButton.addEventListener("click", () =>
		setMenuOpen(panel.hidden === true),
	);
	// The button's own pointerdown must not reach the document-level closer
	// first (it would hide the panel before the click re-toggles it open —
	// review M1: the Scenes button could never close its own menu).
	openButton.addEventListener("pointerdown", (e) => e.stopPropagation());
	// Outside press closes (the panel's own clicks stop propagation).
	panel.addEventListener("pointerdown", (e) => e.stopPropagation());
	document.addEventListener("pointerdown", () => {
		if (!panel.hidden) setMenuOpen(false);
	});
	document.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && !panel.hidden) setMenuOpen(false);
	});

	const loadScene = (name: string): void => {
		store
			.load(name)
			.then((file) => {
				if (!file) {
					showNotice(`Scene "${name}" not found`, "error");
					return;
				}
				if (restoreValidated(world, undo, file)) {
					showNotice(`Loaded "${name}"`);
					setMenuOpen(false);
				}
			})
			.catch((err) => {
				console.warn("[par-physics] scene load failed", err);
				showNotice(`Scene "${name}" could not be read`, "error");
			});
	};

	saveForm.addEventListener("submit", (e) => {
		e.preventDefault();
		const name = saveName.value.trim();
		if (!name) {
			showNotice("Scene name is empty", "error");
			return;
		}
		store
			.save(name, buildSceneFile(world.doc))
			.then(() => {
				showNotice(`Saved "${name}"`);
				saveName.value = "";
				refreshList();
			})
			.catch((err) => {
				console.warn("[par-physics] scene save failed", err);
				showNotice(`Saving "${name}" failed`, "error");
			});
	});

	list.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		const load = target.closest<HTMLButtonElement>("[data-scene-load]");
		if (load) {
			loadScene(load.dataset.sceneLoad ?? "");
			return;
		}
		const del = target.closest<HTMLButtonElement>("[data-scene-del]");
		if (del) {
			const name = del.dataset.sceneDel ?? "";
			store
				.delete(name)
				.then((gone) => {
					showNotice(
						gone ? `Deleted "${name}"` : `Scene "${name}" not found`,
						gone ? "info" : "error",
					);
					refreshList();
				})
				.catch(() => showNotice(`Deleting "${name}" failed`, "error"));
			return;
		}
		const ren = target.closest<HTMLButtonElement>("[data-scene-ren]");
		if (ren) {
			const oldName = ren.dataset.sceneRen ?? "";
			const li = ren.closest("li");
			if (!li) return;
			// Inline rename row: input + confirm/cancel replace the row's buttons.
			const input = document.createElement("input");
			input.type = "text";
			input.value = oldName;
			input.maxLength = 60;
			input.dataset.sceneRenameInput = oldName;
			const confirm = document.createElement("button");
			confirm.type = "button";
			confirm.className = "mat-btn scenes-mini-btn";
			confirm.textContent = "OK";
			confirm.dataset.sceneRenameOk = oldName;
			const cancel = document.createElement("button");
			cancel.type = "button";
			cancel.className = "mat-btn scenes-mini-btn";
			cancel.textContent = "Cancel";
			cancel.dataset.sceneRenameCancel = "1";
			li.textContent = "";
			li.append(input, confirm, cancel);
			input.focus();
			input.select();
		}
	});

	list.addEventListener("click", (e) => {
		const target = e.target as HTMLElement;
		const ok = target.closest<HTMLButtonElement>("[data-scene-rename-ok]");
		if (ok) {
			const oldName = ok.dataset.sceneRenameOk ?? "";
			const li = ok.closest("li");
			const input = li?.querySelector<HTMLInputElement>(
				"[data-scene-rename-input]",
			);
			const newName = input?.value.trim() ?? "";
			if (!newName || newName === oldName) {
				refreshList();
				return;
			}
			store
				.rename(oldName, newName)
				.then((renamed) => {
					showNotice(
						renamed ? `Renamed to "${newName}"` : `"${newName}" is taken`,
						renamed ? "info" : "error",
					);
					refreshList();
				})
				.catch(() => showNotice(`Renaming "${oldName}" failed`, "error"));
			return;
		}
		if (target.closest("[data-scene-rename-cancel]")) refreshList();
	});

	// A real button (keyboard-focusable, focus ring) opens the hidden file
	// input — the label-for-hidden-input pattern left Import unreachable by
	// keyboard (P5-T4 review fix 5).
	importOpen.addEventListener("click", () => importInput.click());

	exportButton.addEventListener("click", () => {
		const file = buildSceneFile(world.doc);
		const blob = new Blob([JSON.stringify(file, null, "\t")], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const anchor = document.createElement("a");
		anchor.href = url;
		anchor.download = `par-physics-scene-${new Date(file.savedAt).toISOString().slice(0, 10)}.json`;
		anchor.click();
		URL.revokeObjectURL(url);
		setMenuOpen(false);
	});

	importInput.addEventListener("change", () => {
		const file = importInput.files?.[0];
		importInput.value = ""; // allow re-selecting the same file
		if (!file) return;
		file
			.text()
			.then((text) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(text);
				} catch {
					showNotice("Import refused: the file is not valid JSON", "error");
					return;
				}
				if (restoreValidated(world, undo, parsed)) {
					showNotice(`Imported ${file.name}`);
					setMenuOpen(false);
				}
			})
			.catch(() => showNotice(`Reading ${file.name} failed`, "error"));
	});
}
