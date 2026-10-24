/**
 * Slider track fill (P3-T4 design pass): paints the CSS variable consumed by
 * the two-stop track gradient in style.css so a slider reads its value at a
 * glance (DESIGN.md — Sliders, "filled portion Accent Blue at 70%").
 */
export function paintRangeFill(input: HTMLInputElement): void {
	const min = Number(input.min);
	const max = Number(input.max);
	const value = Number(input.value);
	const span = max - min;
	const pct = span > 0 ? ((value - min) / span) * 100 : 0;
	input.style.setProperty("--range-fill", `${pct}%`);
}
