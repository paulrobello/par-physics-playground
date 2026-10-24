/**
 * Canvas2D frame loop: clears and draws a placeholder only. No simulation here —
 * physics (Rapier) arrives in a later task.
 */
export interface Renderer {
	resize(cssWidth: number, cssHeight: number): void;
	start(): void;
	stop(): void;
}

const CANVAS_BACKGROUND = "#111418";
const GRID_COLOR = "rgba(230, 233, 238, 0.05)";
const GRID_SPACING = 40;

export function createRenderer(canvas: HTMLCanvasElement): Renderer {
	const context = canvas.getContext("2d");
	if (!context) throw new Error("Canvas2D context unavailable");
	// tsgo does not carry const narrowing into closures; alias with an explicit type.
	const ctx: CanvasRenderingContext2D = context;

	let cssWidth = 0;
	let cssHeight = 0;
	let rafId = 0;

	function resize(cssWidthNew: number, cssHeightNew: number): void {
		cssWidth = cssWidthNew;
		cssHeight = cssHeightNew;
		const dpr = window.devicePixelRatio;
		canvas.width = Math.round(cssWidth * dpr);
		canvas.height = Math.round(cssHeight * dpr);
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	function drawPlaceholder(): void {
		ctx.fillStyle = CANVAS_BACKGROUND;
		ctx.fillRect(0, 0, cssWidth, cssHeight);
		ctx.strokeStyle = GRID_COLOR;
		ctx.lineWidth = 1;
		ctx.beginPath();
		for (let x = GRID_SPACING; x < cssWidth; x += GRID_SPACING) {
			ctx.moveTo(x + 0.5, 0);
			ctx.lineTo(x + 0.5, cssHeight);
		}
		for (let y = GRID_SPACING; y < cssHeight; y += GRID_SPACING) {
			ctx.moveTo(0, y + 0.5);
			ctx.lineTo(cssWidth, y + 0.5);
		}
		ctx.stroke();
	}

	function frame(): void {
		drawPlaceholder();
		rafId = requestAnimationFrame(frame);
	}

	return {
		resize,
		start() {
			if (rafId) return;
			rafId = requestAnimationFrame(frame);
		},
		stop() {
			if (rafId) {
				cancelAnimationFrame(rafId);
				rafId = 0;
			}
		},
	};
}
