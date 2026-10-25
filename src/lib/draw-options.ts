/**
 * Header draw options (grid size + snap, circle-from-center, square boxes,
 * angle snap): a small always-visible control cluster wired straight onto the
 * ToolSession's option fields and the renderer's grid spacing. Options are
 * session state, not document state — they do not persist across reloads,
 * matching gravity/speed.
 */
import type { Renderer } from "../renderer";
import { type ToolSession } from "./tools";

export interface DrawOptionsDeps {
	/** The header hosting the controls (#top-bar). */
	host: HTMLElement;
	session: ToolSession;
	renderer: Renderer;
}

export function attachDrawOptions(deps: DrawOptionsDeps): void {
	const gridSize = deps.host.querySelector<HTMLInputElement>(
		'[data-draw="grid-size"]',
	);
	const gridSizeOut = deps.host.querySelector<HTMLOutputElement>(
		'[data-draw="grid-size-out"]',
	);
	const gridSnap = deps.host.querySelector<HTMLInputElement>(
		'[data-draw="grid-snap"]',
	);
	const circleCenter = deps.host.querySelector<HTMLInputElement>(
		'[data-draw="circle-center"]',
	);
	const boxSquare = deps.host.querySelector<HTMLInputElement>(
		'[data-draw="box-square"]',
	);
	const angleSnap = deps.host.querySelector<HTMLInputElement>(
		'[data-draw="angle-snap"]',
	);
	if (
		!gridSize ||
		!gridSizeOut ||
		!gridSnap ||
		!circleCenter ||
		!boxSquare ||
		!angleSnap
	)
		throw new Error("draw-option controls missing from the top bar");

	// Grid size commits on "change" (blur/Enter/arrows), not per keystroke —
	// clamping mid-typing would fight the user; the output reflects the
	// applied value.
	const applyGridSize = (): void => {
		const raw = Number(gridSize.value);
		const size =
			Number.isFinite(raw) && raw >= 2
				? Math.min(Math.round(raw), 512)
				: deps.session.gridSize;
		deps.session.gridSize = size;
		deps.renderer.gridSize = size;
		gridSize.value = String(size);
		gridSizeOut.value = `${size}u`;
	};
	gridSize.addEventListener("change", applyGridSize);

	gridSnap.addEventListener("change", () => {
		deps.session.gridSnap = gridSnap.checked;
	});
	circleCenter.addEventListener("change", () => {
		deps.session.circleFromCenter = circleCenter.checked;
	});
	boxSquare.addEventListener("change", () => {
		deps.session.constrainBox = boxSquare.checked;
	});
	angleSnap.addEventListener("change", () => {
		deps.session.angleSnap = angleSnap.checked;
	});
}
