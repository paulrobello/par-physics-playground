/**
 * The material panel (P3-T2; PRD D6, D20, D15): the right context panel lists
 * the predefined palette plus user customs, creates/edits customs (name,
 * color, density/friction/restitution sliders with live value readouts),
 * deletes customs (bodies referencing them fall back to ink), sets the
 * active material new shapes take (D20), and applies the active material to
 * the selection.
 *
 * Undo semantics (deliberate, mirrored in the task report): material-library
 * operations — create, edit, delete custom — are NOT undoable. The registry
 * is a persisted library that lives OUTSIDE the undo snapshots (a snapshot
 * holds document entities only, so undo/redo never resurrects or removes a
 * material), and bodies referencing a deleted custom resolve to ink.
 * Applying to the selection IS scene state and IS undoable: exactly one
 * begin/commit undo action per invocation, never one per body.
 */
import type { SceneDocument } from "./document";
import {
	MATERIAL_DEFAULT_ID,
	MATERIAL_PREDEFINED,
	type Material,
	materialValuesError,
} from "./material";
import type { MaterialStore } from "./material-store";
import { paintRangeFill } from "./range-fill";
import type { ToolSession } from "./tools";
import type { UndoStack } from "./undo";
import type { PhysicsWorld } from "./world";

export interface MaterialPanelDeps {
	panel: HTMLElement;
	doc: SceneDocument;
	world: PhysicsWorld;
	session: ToolSession;
	undo: UndoStack;
	store: MaterialStore;
	/** Notified when the user picks a different active material. */
	onActiveChange: (id: string) => void;
}

/** Density slider ceiling: covers lead (~11.3) with headroom. */
export const DENSITY_SLIDER_MAX = 20;

/**
 * Seed value for the never-reusing custom-id counter: one past the highest
 * existing `custom-N` (0 when none). Monotonic and never reset — a reused id
 * would silently rewrite undo history (see the counter comment inside
 * attachMaterialPanel).
 */
export function seedCustomIdCounter(materialIds: readonly string[]): number {
	let max = 0;
	for (const id of materialIds) {
		const match = /^custom-(\d+)$/.exec(id);
		if (match) max = Math.max(max, Number(match[1]));
	}
	return max;
}

export function attachMaterialPanel(deps: MaterialPanelDeps): void {
	const { doc, world, session, undo, store, onActiveChange } = deps;
	const panel = deps.panel;
	let activeId = MATERIAL_DEFAULT_ID;
	let editingId: string | null = null;

	panel.classList.add("mat-panel");

	panel.innerHTML = `
		<h2>Materials</h2>
		<div class="mat-list" data-mat-list></div>
		<div class="mat-editor" data-mat-editor hidden>
			<div class="mat-field">
				<label for="mat-name">Name</label>
				<input id="mat-name" data-mat-name type="text" maxlength="24" placeholder="Custom" />
			</div>
			<div class="mat-field">
				<label for="mat-color">Color</label>
				<input id="mat-color" data-mat-color type="color" value="#888888" />
			</div>
			<div class="mat-field">
				<label for="mat-density">Density</label>
				<input id="mat-density" data-mat-density type="range" min="0.1" max="${DENSITY_SLIDER_MAX}" step="0.1" value="1" />
				<output data-mat-density-out>1.0</output>
			</div>
			<div class="mat-field">
				<label for="mat-friction">Friction</label>
				<input id="mat-friction" data-mat-friction type="range" min="0" max="1" step="0.01" value="0.5" />
				<output data-mat-friction-out>0.50</output>
			</div>
			<div class="mat-field">
				<label for="mat-restitution">Bounce</label>
				<input id="mat-restitution" data-mat-restitution type="range" min="0" max="1" step="0.01" value="0.1" />
				<output data-mat-restitution-out>0.10</output>
			</div>
			<div class="mat-field mat-field-brittle">
				<label for="mat-brittle">Brittle</label>
				<input id="mat-brittle" data-mat-brittle type="checkbox" />
			</div>
			<p class="mat-error" data-mat-error hidden></p>
			<div class="mat-editor-actions">
				<button type="button" class="mat-btn primary" data-mat-save>Create</button>
				<button type="button" class="mat-btn" data-mat-cancel>Cancel</button>
			</div>
		</div>
		<div class="mat-actions">
			<button type="button" class="mat-btn" data-mat-new>New</button>
			<button type="button" class="mat-btn primary" data-mat-apply>Apply to selection</button>
		</div>
	`;

	const q = <T extends Element>(sel: string): T => {
		const el = panel.querySelector(sel);
		if (!el) throw new Error(`material panel: missing ${sel}`);
		return el as T;
	};
	const list = q<HTMLDivElement>("[data-mat-list]");
	const editor = q<HTMLDivElement>("[data-mat-editor]");
	const nameInput = q<HTMLInputElement>("[data-mat-name]");
	const colorInput = q<HTMLInputElement>("[data-mat-color]");
	const densityInput = q<HTMLInputElement>("[data-mat-density]");
	const frictionInput = q<HTMLInputElement>("[data-mat-friction]");
	const restInput = q<HTMLInputElement>("[data-mat-restitution]");
	const brittleInput = q<HTMLInputElement>("[data-mat-brittle]");
	const errorEl = q<HTMLParagraphElement>("[data-mat-error]");
	const saveBtn = q<HTMLButtonElement>("[data-mat-save]");

	// Sliders: live value readouts while dragging.
	const bindSlider = (
		input: HTMLInputElement,
		out: HTMLElement,
		digits: 1 | 2,
	): void => {
		input.addEventListener("input", () => {
			out.textContent = Number(input.value).toFixed(digits);
			paintRangeFill(input);
		});
		paintRangeFill(input);
	};
	bindSlider(densityInput, q<HTMLElement>("[data-mat-density-out]"), 1);
	bindSlider(frictionInput, q<HTMLElement>("[data-mat-friction-out]"), 2);
	bindSlider(restInput, q<HTMLElement>("[data-mat-restitution-out]"), 2);

	/** Fire-and-forget persistence; a failed write degrades to session-only. */
	const persisting = (p: Promise<void>): void => {
		p.catch((err) =>
			console.warn("[par-physics] material persistence failed", err),
		);
	};

	const isCustom = (m: Material): boolean =>
		!MATERIAL_PREDEFINED.some((p) => p.id === m.id);

	/**
	 * Custom ids NEVER repeat (fix-wave F3): undo snapshots hold materialId
	 * strings, so a reused id would silently rewrite history — a pre-delete
	 * snapshot referencing `custom-1` would resolve to the NEW custom-1's
	 * values (wrong physics, wrong color). The counter is monotonic per panel
	 * and seeded past the highest existing `custom-N` at attach, so customs
	 * persisted from earlier sessions (loaded before the panel attaches) never
	 * collide across reloads either.
	 */
	let customIdCounter = seedCustomIdCounter(
		doc.allMaterials().map((m) => m.id),
	);
	const freshCustomId = (): string => {
		customIdCounter += 1;
		return `custom-${customIdCounter}`;
	};

	/** Rebuild every body whose colliders were materialized from `id`. */
	const rematerialize = (id: string): void => {
		for (const e of doc.all()) {
			if (e.kind === "body" && e.materialId === id)
				world.setBodyMaterial(e.id, id);
		}
	};

	const render = (): void => {
		list.textContent = "";
		for (const m of doc.allMaterials()) {
			const row = document.createElement("div");
			row.className = "mat-row";
			const main = document.createElement("button");
			main.type = "button";
			main.className = "mat-row-main";
			main.dataset.matId = m.id;
			main.setAttribute("aria-pressed", m.id === activeId ? "true" : "false");
			main.dataset.tip = `${m.name} — density ${m.density}, friction ${m.friction}, restitution ${m.restitution}`;
			const swatch = document.createElement("span");
			swatch.className = "mat-swatch";
			swatch.style.background = m.color;
			const name = document.createElement("span");
			name.className = "mat-name";
			name.textContent = m.name;
			main.append(swatch, name);
			main.addEventListener("click", () => setActive(m.id));
			row.append(main);
			if (isCustom(m)) {
				const edit = document.createElement("button");
				edit.type = "button";
				edit.className = "mat-row-btn";
				edit.dataset.matEdit = m.id;
				edit.textContent = "Edit";
				edit.setAttribute("aria-label", `Edit ${m.name}`);
				edit.addEventListener("click", () => openEditor(m.id));
				const del = document.createElement("button");
				del.type = "button";
				del.className = "mat-row-btn";
				del.dataset.matDelete = m.id;
				del.textContent = "Del";
				del.setAttribute("aria-label", `Delete ${m.name}`);
				del.addEventListener("click", () => void removeCustom(m.id));
				row.append(edit, del);
			}
			list.append(row);
		}
	};

	const setActive = (id: string): void => {
		if (activeId === id) return;
		activeId = id;
		onActiveChange(id);
		render();
	};

	const openEditor = (id: string | null): void => {
		editingId = id;
		const source = id ? doc.material(id) : null;
		nameInput.value = source?.name ?? "";
		colorInput.value = source?.color ?? "#888888";
		densityInput.value = String(source?.density ?? 1);
		frictionInput.value = String(source?.friction ?? 0.5);
		restInput.value = String(source?.restitution ?? 0.1);
		brittleInput.checked = source?.brittle ?? false;
		// Programmatic value sets don't fire input events; sync the readouts.
		for (const input of [densityInput, frictionInput, restInput])
			input.dispatchEvent(new Event("input"));
		errorEl.hidden = true;
		saveBtn.textContent = id ? "Save" : "Create";
		editor.hidden = false;
		nameInput.focus();
	};

	const closeEditor = (): void => {
		editingId = null;
		editor.hidden = true;
	};

	const save = (): void => {
		const name = nameInput.value.trim() || "Custom";
		const values = {
			name,
			density: Number(densityInput.value),
			friction: Number(frictionInput.value),
			restitution: Number(restInput.value),
		};
		const error = materialValuesError(values);
		if (error) {
			errorEl.textContent = error;
			errorEl.hidden = false;
			return;
		}
		const material: Material = {
			id: editingId ?? freshCustomId(),
			name: values.name,
			color: colorInput.value,
			density: values.density,
			friction: values.friction,
			restitution: values.restitution,
			...(brittleInput.checked ? { brittle: true } : {}),
		};
		if (editingId) {
			// Edit is a library op, not undoable (see header): the registry entry
			// changes in place and affected bodies re-materialize to the new
			// physics immediately.
			if (!doc.updateMaterial(material)) {
				// The material being edited was deleted underneath the editor
				// (fix-wave F2): refuse to resurrect it. Drop the stale id (the
				// next Save becomes a Create with a fresh id) and surface the
				// failure instead of persisting.
				editingId = null;
				errorEl.textContent = "Material no longer exists";
				errorEl.hidden = false;
				return;
			}
			rematerialize(material.id);
			persisting(store.put(material));
		} else {
			if (!doc.addMaterial(material)) {
				errorEl.textContent = "Material id already exists";
				errorEl.hidden = false;
				return;
			}
			persisting(store.put(material));
			// A fresh custom becomes the active material (D20 flow: create, then
			// draw with it).
			setActive(material.id);
		}
		closeEditor();
		render();
	};

	const removeCustom = (id: string): void => {
		if (!doc.removeMaterial(id)) return;
		// Deleting the material being edited invalidates the editor (fix-wave
		// F2): a stale Save would persist a removed id and resurrect the
		// material after reload.
		if (editingId === id) closeEditor();
		// Bodies referencing the deleted custom fall back to ink: re-materialize
		// them explicitly so the live colliders follow now, not at their next
		// respawn (the dangling id would also resolve to ink).
		for (const e of doc.all()) {
			if (e.kind === "body" && e.materialId === id)
				world.setBodyMaterial(e.id, MATERIAL_DEFAULT_ID);
		}
		if (activeId === id) {
			activeId = MATERIAL_DEFAULT_ID;
			onActiveChange(activeId);
		}
		persisting(store.delete(id));
		render();
	};

	q<HTMLButtonElement>("[data-mat-new]").addEventListener("click", () =>
		openEditor(null),
	);
	q<HTMLButtonElement>("[data-mat-cancel]").addEventListener(
		"click",
		closeEditor,
	);
	saveBtn.addEventListener("click", save);
	q<HTMLButtonElement>("[data-mat-apply]").addEventListener("click", () => {
		// Apply-to-selection: ONE undoable action per invocation, not per body.
		// No-op with an empty selection or when nothing would change.
		const ids = [...session.selectedIds].filter((id) => {
			const e = doc.get(id);
			return e?.kind === "body" && e.materialId !== activeId;
		});
		if (ids.length === 0) return;
		undo.beginAction();
		for (const id of ids) world.setBodyMaterial(id, activeId);
		undo.commit();
	});

	render();
}
