/**
 * Widget tooltips (the data-tip attributes): a single body-level element
 * replaces the per-button CSS pseudo-element approach — pseudo-elements
 * render INSIDE the button's box and are clipped invisible by any
 * `overflow: hidden` ancestor (#stage-area neighbors, panel wrappers), which
 * is exactly what shipped the first time (computed opacity read 1 while the
 * screen showed nothing). A fixed-position body child cannot be clipped.
 *
 * Delegated listeners mean dynamically-created controls (material swatches,
 * scene rows, assembly rows — the six JS-assigned dataset.tip sites) get
 * tooltips for free. Shows on hover AND keyboard focus after a 400ms delay;
 * placement follows the chrome: right of tool-rail buttons, below the top
 * bar, flipped/clamped at the viewport edges.
 */

const DELAY_MS = 400;

export function attachTooltips(): () => void {
	const tip = document.createElement("div");
	tip.className = "ppg-tooltip";
	tip.setAttribute("role", "tooltip");
	document.body.append(tip);

	let timer: ReturnType<typeof setTimeout> | undefined;
	let anchor: Element | null = null;

	const place = (): void => {
		if (!anchor) return;
		const rect = anchor.getBoundingClientRect();
		// Measure the (hidden) tip after content is set.
		tip.style.visibility = "hidden";
		tip.classList.add("visible");
		const tw = tip.offsetWidth;
		const th = tip.offsetHeight;
		const right = anchor.classList.contains("tool-btn");
		let x: number;
		let y: number;
		if (right) {
			x = rect.right + 9;
			y = rect.top + rect.height / 2 - th / 2;
		} else {
			x = rect.left + rect.width / 2 - tw / 2;
			y = rect.bottom + 9;
		}
		// Clamp inside the viewport (8px margin).
		x = Math.min(Math.max(x, 8), window.innerWidth - tw - 8);
		y = Math.min(Math.max(y, 8), window.innerHeight - th - 8);
		tip.style.left = `${x}px`;
		tip.style.top = `${y}px`;
		tip.style.visibility = "";
	};

	const hide = (): void => {
		clearTimeout(timer);
		timer = undefined;
		anchor = null;
		tip.classList.remove("visible");
	};

	const schedule = (target: Element): void => {
		if (anchor === target) return;
		hide();
		const text = target.getAttribute("data-tip");
		if (!text) return;
		timer = setTimeout(() => {
			anchor = target;
			tip.textContent = text;
			place();
		}, DELAY_MS);
	};

	const onPointerOver = (event: Event): void => {
		const target = (event.target as Element).closest?.("[data-tip]");
		if (target) schedule(target);
	};
	const related = (event: Event): Element | null => {
		const related = (event as PointerEvent).relatedTarget;
		return related instanceof Element
			? ((related as Element).closest?.("[data-tip]") ?? null)
			: null;
	};
	const onPointerOut = (event: Event): void => {
		const from = (event.target as Element).closest?.("[data-tip]");
		if (from && from !== related(event)) hide();
	};
	const onFocusIn = (event: Event): void => {
		const target = (event.target as Element).closest?.("[data-tip]");
		if (target) schedule(target);
	};
	const onFocusOut = (event: Event): void => {
		const from = (event.target as Element).closest?.("[data-tip]");
		if (from && from !== related(event)) hide();
	};
	const onScrollOrResize = (): void => {
		if (anchor) place();
	};

	document.addEventListener("pointerover", onPointerOver, true);
	document.addEventListener("pointerout", onPointerOut, true);
	document.addEventListener("focusin", onFocusIn, true);
	document.addEventListener("focusout", onFocusOut, true);
	window.addEventListener("scroll", onScrollOrResize, true);
	window.addEventListener("resize", onScrollOrResize);

	return () => {
		hide();
		document.removeEventListener("pointerover", onPointerOver, true);
		document.removeEventListener("pointerout", onPointerOut, true);
		document.removeEventListener("focusin", onFocusIn, true);
		document.removeEventListener("focusout", onFocusOut, true);
		window.removeEventListener("scroll", onScrollOrResize, true);
		window.removeEventListener("resize", onScrollOrResize);
		tip.remove();
	};
}
