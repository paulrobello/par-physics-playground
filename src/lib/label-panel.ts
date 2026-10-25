/**
 * Label properties (the text-tool request): size, font family, and alignment
 * controls for the selected label, appended to the context panel like the
 * joint panel's section. Edits apply inside ONE undo boundary via
 * world.setLabelStyle. Empty size = the zoom-adaptive default.
 */
import type { LabelFont, LabelTextAlign } from "./document";
import type { ToolSession } from "./tools";
import type { UndoStack } from "./undo";
import type { PhysicsWorld } from "./world";

export interface LabelPanelDeps {
	/** The context panel host (a section is appended to it). */
	host: HTMLElement;
	world: PhysicsWorld;
	session: ToolSession;
	undo: UndoStack;
}

/**
 * Attach the label panel section. Returns a per-frame `refresh()`
 * (compare-cheap, touch-DOM-on-change) — main.ts wires it into the rAF flow
 * alongside the joint panel's.
 */
export function attachLabelPanel(deps: LabelPanelDeps): () => void {
	const { world, session, undo } = deps;
	const section = document.createElement("section");
	section.className = "label-panel";
	section.hidden = true;
	deps.host.append(section);
	section.innerHTML = `
		<h2>Text</h2>
		<label class="joint-field">Size (world units)
			<input type="number" step="1" min="1" data-label-size placeholder="auto" />
		</label>
		<label class="joint-field">Font/Align
			<select data-label-font>
				<option value="">Auto</option>
				<option value="sans">Sans</option>
				<option value="serif">Serif</option>
				<option value="mono">Mono</option>
			</select>
			<select data-label-align>
				<option value="left">Left</option>
				<option value="center">Center</option>
				<option value="right">Right</option>
			</select>
		</label>
	`;
	const sizeInput =
		section.querySelector<HTMLInputElement>("[data-label-size]");
	const fontSelect =
		section.querySelector<HTMLSelectElement>("[data-label-font]");
	const alignSelect =
		section.querySelector<HTMLSelectElement>("[data-label-align]");
	if (!sizeInput || !fontSelect || !alignSelect)
		throw new Error("label panel: missing controls");

	/** The first selected label, else undefined. */
	const shownLabelId = (): string | undefined => {
		for (const id of session.selectedIds) {
			const e = world.doc.get(id);
			if (e?.kind === "label") return id;
		}
		return undefined;
	};

	/** Apply a style edit inside ONE undo boundary. */
	const apply = (
		id: string,
		patch: {
			size?: number | undefined;
			font?: LabelFont | undefined;
			align?: LabelTextAlign | undefined;
		},
	): void => {
		undo.beginAction();
		world.setLabelStyle(id, patch);
		undo.commit();
	};

	/**
	 * True while any panel control holds focus — the per-frame refresh must
	 * never clobber a value the user is typing (the joint panel's rebuild
	 * guard, checked against the whole section).
	 */
	const panelFocusWithin = (): boolean =>
		section.contains(document.activeElement) &&
		(document.activeElement instanceof HTMLInputElement ||
			document.activeElement instanceof HTMLSelectElement);

	section.addEventListener("change", () => {
		const id = shownLabelId();
		if (!id) return;
		let size: number | undefined;
		const rawSize = sizeInput.value.trim();
		if (rawSize !== "") {
			const parsed = Number.parseFloat(sizeInput.value);
			if (!Number.isFinite(parsed) || parsed <= 0) return;
			size = parsed;
		}
		const font = (fontSelect.value || undefined) as LabelFont | undefined;
		const align = alignSelect.value as LabelTextAlign;
		apply(id, { size, font, align });
	});

	/** Signature of the label the section currently displays. */
	let shownSig = "";
	const refresh = (): void => {
		const id = shownLabelId();
		if (id === undefined) {
			if (shownSig !== "") {
				shownSig = "";
				section.hidden = true;
			}
			return;
		}
		const e = world.doc.get(id);
		if (!e || e.kind !== "label") {
			if (shownSig !== "") {
				shownSig = "";
				section.hidden = true;
			}
			return;
		}
		// Signature covers the displayed values too, so an undo (or any
		// external style change) refreshes the controls.
		const sig = `${id}:${e.size ?? ""}:${e.font ?? ""}:${e.align ?? ""}`;
		if (sig === shownSig) return;
		shownSig = sig;
		section.hidden = false;
		if (panelFocusWithin()) return;
		sizeInput.value = e.size !== undefined ? String(e.size) : "";
		fontSelect.value = e.font ?? "";
		alignSelect.value = e.align ?? "left";
	};
	return refresh;
}
