/**
 * Canvas2D frame loop: background fill plus a camera-transformed world layer
 * (soft zoom-faded grid and a distinct ground line). The sim clock is fed from
 * the frame flow via the `onFrame` option. Bodies draw from the live scene
 * view each frame (material fill, soft shadow, hover/selection accents, draw
 * preview). Hot path note: the per-body draw closure and snapshot reads
 * allocate per frame; the loop stays comfortably at 60 fps in practice, but
 * "allocation-free" is not a property this file guarantees.
 */

import type { Camera } from "./lib/camera";
import { MATERIAL_DEFAULT } from "./lib/material";
import type { BodyShape } from "./lib/world";

/** Read-only view the renderer draws from, wired up in main.ts. */
export interface SceneView {
	forEachBody(
		fn: (
			id: string,
			shape: BodyShape,
			x: number,
			y: number,
			rot: number,
		) => void,
	): void;
	/** In-progress drawing preview geometry, or null. */
	preview():
		| { cx: number; cy: number; halfWidth: number; halfHeight: number }
		| { cx: number; cy: number; radius: number }
		| null;
	hoverId(): string | undefined;
	selectedId(): string | undefined;
}

export interface Renderer {
	resize(cssWidth: number, cssHeight: number): void;
	start(): void;
	stop(): void;
}

export interface RendererOptions {
	/** Camera whose pan/zoom transform maps world space onto the canvas. */
	camera: Camera;
	/** Called once per rAF frame with the measured wall-clock delta, before drawing. */
	onFrame?: (dtSeconds: number) => void;
	/** Live scene (bodies, preview, hover/selection) to draw above the grid. */
	scene?: SceneView;
}

const CANVAS_BACKGROUND = "#111418";
const GRID_COLOR = "rgba(230, 233, 238, 0.05)";
const GROUND_COLOR = "rgba(152, 162, 179, 0.6)";
/** A grid spacing is only drawn once it spans at least this many CSS pixels. */
const MIN_GRID_PX = 32;
/** World-unit spacing the grid coarsening search starts from. */
const GRID_BASE_SPACING = 1;
/** Ground line thickness, in CSS pixels. */
const GROUND_WIDTH_PX = 2;

/** Accent for selection/hover glow and the draw preview (phase-0 token). */
const ACCENT_COLOR = "#4aa3ff";
/** Soft contact shadow under bodies, in device pixels (unaffected by transform). */
const BODY_SHADOW = "rgba(0, 0, 0, 0.4)";
const BODY_SHADOW_BLUR_PX = 6;
const BODY_SHADOW_OFFSET_Y_PX = 3;
/** Hover glow strength and the on-screen lift amount (CSS px). */
const HOVER_GLOW = "rgba(74, 163, 255, 0.35)";
const HOVER_GLOW_BLUR_PX = 14;
const HOVER_LIFT_PX = 1.5;
/** Selection outline width, CSS px. */
const SELECTION_WIDTH_PX = 2;
/** Draw-preview fill alpha and stroke width (CSS px). */
const PREVIEW_FILL = "rgba(74, 163, 255, 0.12)";
const PREVIEW_WIDTH_PX = 1.5;

export function createRenderer(
	canvas: HTMLCanvasElement,
	options: RendererOptions,
): Renderer {
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

	/**
	 * World layer: soft grid and ground line drawn under the camera transform.
	 * All geometry in world coordinates; line widths divided by zoom so they
	 * stay constant in screen pixels.
	 */
	function drawWorld(): void {
		const camera = options.camera;
		const zoom = camera.zoom;
		const dpr = window.devicePixelRatio;
		ctx.setTransform(
			dpr * zoom,
			0,
			0,
			dpr * zoom,
			dpr * camera.offsetX,
			dpr * camera.offsetY,
		);

		// Visible world bounds (screen = world·zoom + offset, y-down).
		const left = -camera.offsetX / zoom;
		const top = -camera.offsetY / zoom;
		const right = (cssWidth - camera.offsetX) / zoom;
		const bottom = (cssHeight - camera.offsetY) / zoom;

		// Coarsen the grid spacing until lines are far enough apart on screen,
		// then fade the fine level by how close it sits to the density limit.
		let spacing = GRID_BASE_SPACING;
		while (spacing * zoom < MIN_GRID_PX) spacing *= 2;
		const spacingPx = spacing * zoom;
		const fade = Math.min(
			Math.max((spacingPx - MIN_GRID_PX) / MIN_GRID_PX, 0),
			1,
		);

		ctx.lineWidth = 1 / zoom;
		ctx.strokeStyle = GRID_COLOR; // full-strength template; per-stroke alpha via globalAlpha
		ctx.globalAlpha = 0.35 + 0.65 * fade;
		ctx.beginPath();
		for (
			let x = Math.ceil(left / spacing) * spacing;
			x <= right;
			x += spacing
		) {
			ctx.moveTo(x, top);
			ctx.lineTo(x, bottom);
		}
		for (
			let y = Math.ceil(top / spacing) * spacing;
			y <= bottom;
			y += spacing
		) {
			ctx.moveTo(left, y);
			ctx.lineTo(right, y);
		}
		ctx.stroke();
		ctx.globalAlpha = 1;

		// Ground line: distinct from the grid — brighter, constant screen width.
		if (top <= 0 && bottom >= 0) {
			ctx.lineWidth = GROUND_WIDTH_PX / zoom;
			ctx.strokeStyle = GROUND_COLOR;
			ctx.beginPath();
			ctx.moveTo(left, 0);
			ctx.lineTo(right, 0);
			ctx.stroke();
		}

		// Bodies: drawn in the same world transform, above grid and ground line.
		if (options.scene) {
			drawBodies(zoom);
			drawPreview(zoom);
		}

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	/**
	 * Bodies from the physics state: filled with the material color, soft
	 * contact shadow, hover lift + accent glow, selection outline. `zoom`
	 * converts screen-constant widths to world units.
	 */
	function drawBodies(zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		const hoverId = scene.hoverId();
		const selectedId = scene.selectedId();
		const lift = HOVER_LIFT_PX / zoom;
		ctx.shadowBlur = BODY_SHADOW_BLUR_PX;
		ctx.shadowOffsetY = BODY_SHADOW_OFFSET_Y_PX;
		ctx.fillStyle = MATERIAL_DEFAULT.color;
		scene.forEachBody((id, shape, x, y, rot) => {
			const hovered = id === hoverId;
			ctx.shadowColor = hovered ? HOVER_GLOW : BODY_SHADOW;
			if (hovered) ctx.shadowBlur = HOVER_GLOW_BLUR_PX;
			ctx.save();
			ctx.translate(x, hovered ? y - lift : y);
			ctx.rotate(rot);
			ctx.beginPath();
			if (shape.kind === "box") {
				ctx.rect(
					-shape.halfWidth,
					-shape.halfHeight,
					shape.halfWidth * 2,
					shape.halfHeight * 2,
				);
			} else {
				ctx.arc(0, 0, shape.radius, 0, Math.PI * 2);
			}
			ctx.fill();
			ctx.restore();
			if (hovered) {
				ctx.shadowBlur = BODY_SHADOW_BLUR_PX;
				ctx.shadowOffsetY = BODY_SHADOW_OFFSET_Y_PX;
			}
		});
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;
		ctx.shadowOffsetY = 0;
		if (selectedId !== undefined) drawSelectionOutline(selectedId, zoom);
	}

	/** Accent outline + glow around the selected body. */
	function drawSelectionOutline(id: string, zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		let found:
			| { shape: BodyShape; x: number; y: number; rot: number }
			| undefined;
		scene.forEachBody((bid, shape, x, y, rot) => {
			if (bid === id) found = { shape, x, y, rot };
		});
		if (!found) return;
		ctx.shadowColor = HOVER_GLOW;
		ctx.shadowBlur = HOVER_GLOW_BLUR_PX;
		ctx.strokeStyle = ACCENT_COLOR;
		ctx.lineWidth = SELECTION_WIDTH_PX / zoom;
		ctx.save();
		const { shape, x, y, rot } = found;
		ctx.translate(x, y);
		ctx.rotate(rot);
		ctx.beginPath();
		if (shape.kind === "box") {
			ctx.rect(
				-shape.halfWidth,
				-shape.halfHeight,
				shape.halfWidth * 2,
				shape.halfHeight * 2,
			);
		} else {
			ctx.arc(0, 0, shape.radius + 1 / zoom, 0, Math.PI * 2);
		}
		ctx.stroke();
		ctx.restore();
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;
	}

	/** Accent preview with glow while a draw tool sizes a shape. */
	function drawPreview(zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		const p = scene.preview();
		if (!p) return;
		ctx.shadowColor = HOVER_GLOW;
		ctx.shadowBlur = HOVER_GLOW_BLUR_PX;
		ctx.fillStyle = PREVIEW_FILL;
		ctx.strokeStyle = ACCENT_COLOR;
		ctx.lineWidth = PREVIEW_WIDTH_PX / zoom;
		ctx.beginPath();
		if ("halfWidth" in p) {
			ctx.rect(
				p.cx - p.halfWidth,
				p.cy - p.halfHeight,
				p.halfWidth * 2,
				p.halfHeight * 2,
			);
		} else {
			ctx.arc(p.cx, p.cy, p.radius, 0, Math.PI * 2);
		}
		ctx.fill();
		ctx.stroke();
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;
	}

	let lastFrameTime = 0;

	function frame(): void {
		const now = performance.now();
		const dtSeconds = lastFrameTime === 0 ? 0 : (now - lastFrameTime) / 1000;
		lastFrameTime = now;
		if (options.onFrame) options.onFrame(dtSeconds);
		ctx.fillStyle = CANVAS_BACKGROUND;
		ctx.fillRect(0, 0, cssWidth, cssHeight);
		drawWorld();
		rafId = requestAnimationFrame(frame);
	}

	return {
		resize,
		start() {
			if (rafId) return;
			lastFrameTime = 0; // first frame after a restart gets dt=0, not the pause gap
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
