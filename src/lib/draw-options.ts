/**
 * Header draw options (grid size + snap, circle-from-center, square boxes,
 * angle snap): a small always-visible control cluster wired straight onto the
 * ToolSession's option fields and the renderer's grid spacing. Options are
 * session state; settings persistence (settings-store.ts) restores them at
 * boot through the returned handle and saves every change via onChange.
 */
import type { Renderer } from "../renderer";
import type { ToolSession } from "./tools";

/** The option values, as the controls and the settings store express them. */
export interface DrawOptionValues {
	gridSize: number;
	gridSnap: boolean;
	circleFromCenter: boolean;
	constrainBox: boolean;
	angleSnap: boolean;
}

export interface DrawOptionsDeps {
	/** The header hosting the controls (#top-bar). */
	host: HTMLElement;
	session: ToolSession;
	renderer: Renderer;
	/**
	 * Fired after a user change commits (grid size or a toggle) with the full
	 * current values — the settings-persistence save hook. A boot restore via
	 * the returned handle does NOT fire it.
	 */
	onChange?: ((values: DrawOptionValues) => void) | undefined;
}

/** Returned handle: pushes stored values into session + renderer + DOM. */
export interface DrawOptionsHandle {
	apply(values: Partial<DrawOptionValues>): void;
}

/** Grid-size clamp shared by the input handler and the restore path. */
export function clampGridSizeValue(raw: number, fallback: number): number {
	return Number.isFinite(raw) && raw >= 2
		? Math.min(Math.round(raw), 512)
		: fallback;
}

export function attachDrawOptions(deps: DrawOptionsDeps): DrawOptionsHandle {
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

	/** Push values into session + renderer + DOM (the restore path). */
	const apply = (values: Partial<DrawOptionValues>): void => {
		if (values.gridSize !== undefined) {
			const size = clampGridSizeValue(values.gridSize, deps.session.gridSize);
			deps.session.gridSize = size;
			deps.renderer.gridSize = size;
			gridSize.value = String(size);
			gridSizeOut.value = `${size}u`;
		}
		if (values.gridSnap !== undefined) {
			deps.session.gridSnap = values.gridSnap;
			gridSnap.checked = values.gridSnap;
		}
		if (values.circleFromCenter !== undefined) {
			deps.session.circleFromCenter = values.circleFromCenter;
			circleCenter.checked = values.circleFromCenter;
		}
		if (values.constrainBox !== undefined) {
			deps.session.constrainBox = values.constrainBox;
			boxSquare.checked = values.constrainBox;
		}
		if (values.angleSnap !== undefined) {
			deps.session.angleSnap = values.angleSnap;
			angleSnap.checked = values.angleSnap;
		}
	};

	/** A user change: apply, then hand the full values to persistence. */
	const commit = (values: Partial<DrawOptionValues>): void => {
		apply(values);
		deps.onChange?.({
			gridSize: deps.session.gridSize,
			gridSnap: deps.session.gridSnap,
			circleFromCenter: deps.session.circleFromCenter,
			constrainBox: deps.session.constrainBox,
			angleSnap: deps.session.angleSnap,
		});
	};

	// Grid size commits on "change" (blur/Enter/arrows), not per keystroke —
	// clamping mid-typing would fight the user; the output reflects the
	// applied value.
	gridSize.addEventListener("change", () => {
		commit({ gridSize: Number(gridSize.value) });
	});

	gridSnap.addEventListener("change", () => {
		commit({ gridSnap: gridSnap.checked });
	});
	circleCenter.addEventListener("change", () => {
		commit({ circleFromCenter: circleCenter.checked });
	});
	boxSquare.addEventListener("change", () => {
		commit({ constrainBox: boxSquare.checked });
	});
	angleSnap.addEventListener("change", () => {
		commit({ angleSnap: angleSnap.checked });
	});

	return { apply };
}
