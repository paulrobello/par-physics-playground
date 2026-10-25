/**
 * Rotation affordance for the selection (the visible-rotation card): a
 * degrees field appended to the context panel whenever a rotatable entity
 * (body or label) is selected. Editing applies through the SAME apply path
 * the R+drag gesture's onRotate uses — a base + delta map over the whole
 * selection via world.rotateBody / doc.setTransform inside ONE undo action —
 * so the field and the gesture can never drift apart.
 *
 * Two-way is live while the sim is paused: the per-frame refresh tracks the
 * body's rotation into the field, and a typed angle rotates the body at
 * once. While running the value churns with the physics, so the field shows
 * the live angle read-only (disabled) instead of fighting the refresh.
 */
import type { ToolSession } from "./tools";
import type { UndoStack } from "./undo";
import type { PhysicsWorld } from "./world";

export interface RotatePanelDeps {
	/** The context panel host (a section is appended to it). */
	host: HTMLElement;
	world: PhysicsWorld;
	session: ToolSession;
	undo: UndoStack;
	/** Whether the sim clock is paused (running sims show the field read-only). */
	isPaused: () => boolean;
}

/**
 * Attach the rotation section. Returns a per-frame `refresh()`
 * (compare-cheap, touch-DOM-on-change) — main.ts wires it into the rAF flow
 * alongside the joint and label panels'.
 */
export function attachRotatePanel(deps: RotatePanelDeps): () => void {
	const { world, session, undo } = deps;
	const section = document.createElement("section");
	section.className = "rotate-panel";
	section.hidden = true;
	deps.host.append(section);
	section.innerHTML = `
		<h2>Rotation</h2>
		<label class="joint-field" data-tip="Type an angle (paused) or hold R and drag the selection vertically — release mid-drag to fling it spinning.">
			Angle (°)
			<input type="number" step="1" data-rotate-angle />
		</label>
	`;
	const angleInput = section.querySelector<HTMLInputElement>(
		"[data-rotate-angle]",
	);
	if (!angleInput) throw new Error("rotate panel: missing controls");

	/** Ids the R-drag gesture can rotate: bodies plus doc-only labels. */
	const rotatableIds = (): string[] => {
		const ids: string[] = [];
		for (const id of session.selectedIds) {
			const e = world.doc.get(id);
			if (e && (e.kind === "body" || e.kind === "label")) ids.push(id);
		}
		return ids;
	};

	/**
	 * Live rotation of a rotatable id — the body pose first, the document
	 * fallback (the gesture's onRotateStart source order).
	 */
	const rotationOf = (id: string): number | undefined => {
		const live = world.bodyRotation(id);
		if (live !== undefined) return live;
		const e = world.doc.get(id);
		return e && (e.kind === "body" || e.kind === "label") ? e.rot : undefined;
	};

	/**
	 * True while the field holds focus — the per-frame refresh must never
	 * clobber a value the user is typing (the label panel's focus guard).
	 */
	const fieldFocused = (): boolean => document.activeElement === angleInput;

	// Same apply path as the gesture's onRotate: base + delta per selected id
	// (relative offsets preserved), ONE undo action per edit. Angle snap stays
	// a gesture-only affordance — a typed angle is already exact.
	section.addEventListener("change", () => {
		const ids = rotatableIds();
		const firstId = ids[0];
		const shown = firstId !== undefined ? rotationOf(firstId) : undefined;
		if (shown === undefined) return;
		const parsed = Number.parseFloat(angleInput.value);
		if (!Number.isFinite(parsed)) return;
		const delta = (parsed * Math.PI) / 180 - shown;
		undo.beginAction();
		for (const id of ids) {
			const base = rotationOf(id);
			if (base === undefined) continue;
			const target = base + delta;
			if (world.bodies.has(id)) world.rotateBody(id, target);
			else {
				const e = world.doc.get(id);
				if (e && (e.kind === "body" || e.kind === "label"))
					world.doc.setTransform(id, e.x, e.y, target);
			}
		}
		undo.commit();
	});

	/** Signature of the rotation the field currently displays. */
	let shownSig = "";
	const refresh = (): void => {
		const ids = rotatableIds();
		const firstId = ids[0];
		const rot = firstId !== undefined ? rotationOf(firstId) : undefined;
		if (rot === undefined) {
			if (shownSig !== "") {
				shownSig = "";
				section.hidden = true;
			}
			return;
		}
		const paused = deps.isPaused();
		const sig = `${firstId}:${rot.toFixed(4)}:${paused ? "paused" : "running"}`;
		if (sig === shownSig) return;
		// A change that lands mid-typing must NOT mark the sig displayed —
		// leaving it stale makes the first refresh after blur re-sync the
		// field to the body (the label panel's focus-guard semantics).
		if (fieldFocused()) return;
		shownSig = sig;
		section.hidden = false;
		// A running sim churns the angle every frame — the field shows the
		// live value but takes no edits until the sim pauses again.
		angleInput.disabled = !paused;
		if (fieldFocused()) return;
		let deg = (rot * 180) / Math.PI;
		deg = (((deg % 360) + 540) % 360) - 180;
		const rounded = Math.round(deg * 10) / 10;
		angleInput.value = rounded === 0 ? "0" : String(rounded);
	};
	return refresh;
}
