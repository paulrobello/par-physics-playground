/**
 * The assemblies panel (the material-panel structure on the joint-panel's
 * append pattern): a right-context-panel section listing saved assemblies,
 * with a name input + "Save selection" button (captures the current selection
 * as a named assembly) and one row per assembly — the name stamps a copy on
 * the next canvas click, Del removes it.
 *
 * Stamping is a ONE-SHOT placement mode (the tool-arming precedent): clicking
 * a row arms placement, the next left-click on the canvas places the copy
 * centered there, Escape cancels. While armed, a window CAPTURE-phase
 * pointerdown handler swallows the event before the canvas's session/camera
 * listeners see it — at the target element, capture and bubble listeners run
 * in registration order, and the panel attaches AFTER the canvas wiring, so a
 * canvas-targeted listener could not preempt them.
 *
 * Undo semantics: a stamp is ONE undoable action (beginAction before the
 * spawns, commit after — the onSpawnFreehand precedent); refused stamps drop
 * the snapshot with cancelAction. Library operations (save, delete) are NOT
 * undoable, exactly like the material library.
 */
import { type Assembly, captureAssembly, stampAssembly } from "./assembly";
import type { AssemblyStore } from "./assembly-store";
import type { Camera } from "./camera";
import { CURSOR_DRAW } from "./interaction";
import { showNotice } from "./notice";
import type { ToolSession } from "./tools";
import type { UndoStack } from "./undo";
import type { PhysicsWorld } from "./world";

export interface AssemblyPanelDeps {
	/** The context panel host (a section is appended to it). */
	host: HTMLElement;
	world: PhysicsWorld;
	session: ToolSession;
	undo: UndoStack;
	store: AssemblyStore;
	canvas: HTMLCanvasElement;
	camera: Camera;
	/** Assemblies loaded from the store at boot (assemblies survive reload). */
	initial: readonly Assembly[];
}

export function attachAssemblyPanel(deps: AssemblyPanelDeps): void {
	const { world, session, undo, store, canvas, camera, initial } = deps;
	const section = document.createElement("section");
	section.className = "assembly-panel";
	deps.host.append(section);
	section.innerHTML = `
		<h2>Assemblies</h2>
		<div class="asm-save">
			<input data-asm-name type="text" maxlength="60" placeholder="Assembly name" aria-label="Assembly name" autocomplete="off" />
			<button type="button" class="mat-btn primary" data-asm-save>Save selection</button>
		</div>
		<p class="mat-error" data-asm-error hidden></p>
		<div class="mat-list" data-asm-list></div>
	`;

	const q = <T extends Element>(sel: string): T => {
		const el = section.querySelector(sel);
		if (!el) throw new Error(`assembly panel: missing ${sel}`);
		return el as T;
	};
	const list = q<HTMLDivElement>("[data-asm-list]");
	const nameInput = q<HTMLInputElement>("[data-asm-name]");
	const errorEl = q<HTMLElement>("[data-asm-error]");

	const assemblies: Assembly[] = [...initial];
	// Monotonic per-panel id counter seeded past the highest existing asm-N
	// (the material panel's seedCustomIdCounter precedent), so assemblies
	// persisted by earlier sessions never collide across reloads.
	let idCounter = 0;
	for (const { id } of assemblies) {
		const match = /^asm-(\d+)$/.exec(id);
		if (match) idCounter = Math.max(idCounter, Number(match[1]));
	}
	const freshAsmId = (): string => {
		idCounter += 1;
		return `asm-${idCounter}`;
	};

	/** Fire-and-forget persistence; a failed write degrades to session-only. */
	const persisting = (p: Promise<void>): void => {
		p.catch((err) =>
			console.warn("[par-physics] assembly persistence failed", err),
		);
	};

	const showError = (message: string): void => {
		errorEl.textContent = message;
		errorEl.hidden = false;
	};

	const render = (): void => {
		list.textContent = "";
		for (const assembly of assemblies) {
			const row = document.createElement("div");
			row.className = "mat-row";
			const main = document.createElement("button");
			main.type = "button";
			main.className = "mat-row-main";
			main.dataset.asmStamp = assembly.id;
			main.title = "Click, then click the canvas to place a copy";
			const name = document.createElement("span");
			name.className = "mat-name";
			name.textContent = assembly.name;
			main.append(name);
			const del = document.createElement("button");
			del.type = "button";
			del.className = "mat-row-btn";
			del.dataset.asmDelete = assembly.id;
			del.textContent = "Del";
			del.setAttribute("aria-label", `Delete ${assembly.name}`);
			del.addEventListener("click", () => void removeAssembly(assembly.id));
			row.append(main, del);
			list.append(row);
		}
	};

	// --- One-shot placement (the tool-arming precedent) ---
	let pending: Assembly | null = null;

	const disarm = (): void => {
		if (!pending) return;
		pending = null;
		canvas.style.cursor = session.tool === "select" ? "" : CURSOR_DRAW;
	};

	const arm = (assembly: Assembly): void => {
		pending = assembly;
		canvas.style.cursor = CURSOR_DRAW;
		showNotice(`Click the canvas to place "${assembly.name}" (Escape cancels)`);
	};

	const onWindowPointerDown = (event: PointerEvent): void => {
		if (!pending) return;
		if (event.button !== 0 || event.target !== canvas) return;
		// Preempt the canvas's session and camera listeners entirely: the
		// placement click must not select, draw, or pan.
		event.preventDefault();
		event.stopPropagation();
		const assembly = pending;
		disarm();
		const rect = canvas.getBoundingClientRect();
		const p = camera.screenToWorld(
			event.clientX - rect.left,
			event.clientY - rect.top,
		);
		undo.beginAction();
		const stamped = stampAssembly(world, assembly.file, p.x, p.y);
		if (stamped.length > 0) undo.commit();
		else undo.cancelAction();
	};

	const onWindowKeyDown = (event: KeyboardEvent): void => {
		if (event.key === "Escape" && pending) {
			disarm();
			showNotice("Placement canceled");
		}
	};

	// Capture phase on an ANCESTOR (window) is the only way to run before the
	// canvas target's already-registered listeners — see the header comment.
	window.addEventListener("pointerdown", onWindowPointerDown, true);
	window.addEventListener("keydown", onWindowKeyDown, true);

	const removeAssembly = async (id: string): Promise<void> => {
		const index = assemblies.findIndex((a) => a.id === id);
		if (index < 0) return;
		assemblies.splice(index, 1);
		if (pending?.id === id) disarm();
		persisting(store.delete(id));
		render();
	};

	const save = (): void => {
		errorEl.hidden = true;
		const name = nameInput.value.trim() || "Assembly";
		const result = captureAssembly(world.doc, session.selectedIds, name);
		if (!result.ok) {
			showError(result.error);
			return;
		}
		const assembly: Assembly = { ...result.assembly, id: freshAsmId() };
		assemblies.push(assembly);
		persisting(store.put(assembly));
		nameInput.value = "";
		render();
	};

	q<HTMLButtonElement>("[data-asm-save]").addEventListener("click", save);
	list.addEventListener("click", (event) => {
		const target = event.target as HTMLElement;
		const main = target.closest<HTMLElement>("[data-asm-stamp]");
		if (!main) return;
		const assembly = assemblies.find((a) => a.id === main.dataset.asmStamp);
		if (assembly) arm(assembly);
	});

	render();
}
