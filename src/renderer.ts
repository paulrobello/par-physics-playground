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
import type { LabelFont, LabelTextAlign } from "./lib/document";
import type { JointType } from "./lib/joint";
import { jointGlyphRadius } from "./lib/joint";
import {
	DEFAULT_GRID_SIZE,
	type DrawPreview,
	effectiveLabelFontSize,
	labelBounds,
} from "./lib/tools";
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
			isStatic: boolean,
			/** Resolved material fill color (ink fallback, dynamic bodies only). */
			color: string,
		) => void,
	): void;
	/** Non-physical labels, in document order (drawn above bodies). */
	forEachLabel(
		fn: (
			id: string,
			x: number,
			y: number,
			rot: number,
			text: string,
			/** World-unit size override; undefined renders at the zoom-adaptive default. */
			size: number | undefined,
			/** Font family override; undefined is the sans default. */
			font: LabelFont | undefined,
			/** Alignment at the anchor point; undefined is left. */
			align: LabelTextAlign | undefined,
		) => void,
	): void;
	/** Joints with their live anchor positions, in document order. */
	forEachJoint(
		fn: (
			id: string,
			jointType: string,
			wx: number,
			wy: number,
			/** Motor running state (true for non-motor types). */
			motorOn: boolean,
			/** Live world position of the second anchor (P4-T4 rope/spring drawing). */
			wx2: number,
			wy2: number,
			/**
			 * The pulley's fixed wheel point (pulleys only; anchor B's position
			 * for every other kind, unused there — a pulley draws through it).
			 */
			wx3: number,
			wy3: number,
		) => void,
	): void;
	/** Thrusters with their live poses, in document order (P4-T5). */
	forEachThruster(
		fn: (
			id: string,
			wx: number,
			wy: number,
			angle: number,
			on: boolean,
		) => void,
	): void;
	/** In-progress drawing preview geometry, or null. */
	preview(): DrawPreview | null;
	hoverId(): string | undefined;
	selectedIds(): ReadonlySet<string>;
	/** In-progress rubber-band selection rectangle, or null. */
	rubberBand(): {
		cx: number;
		cy: number;
		halfWidth: number;
		halfHeight: number;
	} | null;
}

export interface Renderer {
	resize(cssWidth: number, cssHeight: number): void;
	start(): void;
	stop(): void;
	/** Grid spacing in world units (draw options); drawn lines are its ×2ᵏ multiples. */
	gridSize: number;
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
/** Circle selection rings sit this far outside the shape's edge (CSS px). */
const SELECTION_PAD_PX = 2;
/** Draw-preview fill alpha and stroke width (CSS px). */
const PREVIEW_FILL = "rgba(74, 163, 255, 0.12)";
const PREVIEW_WIDTH_PX = 1.5;

/** Label text color (HUD primary-text token). */
const LABEL_COLOR = "#e6e9ee";
/** Dimmed joint glyph color (a stopped motor marker). */
const JOINT_OFF_COLOR = "rgba(152, 162, 179, 0.45)";
/** Label caret shown while the text tool edits an empty label. */
const LABEL_CARET_WIDTH_PX = 1.5;
/**
 * Joint glyph kinds drawn as OPEN paths (a line, not a region): Canvas fills
 * these as zero area, so the glyph pass strokes them instead.
 */
const LINE_GLYPH_TYPES: ReadonlySet<string> = new Set([
	"rod",
	"spring",
	"rope",
]);
/**
 * Static (terrain) bodies get the ground-line tone family instead of the
 * dynamic material fill: translucent slate fill + ground-line stroke, no
 * drop shadow (static geometry does not fall, so it does not hover).
 */
const STATIC_FILL = "rgba(152, 162, 179, 0.22)";
const STATIC_STROKE_WIDTH_PX = 1.5;

/** Trace a closed polygon path (caller starts/ends the path). */
function tracePolyPath(
	ctx: CanvasRenderingContext2D,
	points: readonly { readonly x: number; readonly y: number }[],
): void {
	const first = points[0];
	if (!first) return;
	ctx.moveTo(first.x, first.y);
	for (let i = 1; i < points.length; i++) {
		const p = points[i] as { x: number; y: number };
		ctx.lineTo(p.x, p.y);
	}
	ctx.closePath();
}

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
	/** User grid size in world units (draw options); drawn lines are its ×2ᵏ multiples. */
	let gridSpacingUser = DEFAULT_GRID_SIZE;

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
		// The base is the user's grid size (draw options), so drawn lines are
		// always multiples of the snapping spacing.
		let spacing = Math.max(gridSpacingUser, GRID_BASE_SPACING);
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
			drawJoints(zoom);
			drawThrusters(zoom);
			drawLabels(zoom);
			drawPreview(zoom);
			drawRubberBand(zoom);
		}

		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	/**
	 * Bodies from the physics state: filled with the material color, soft
	 * contact shadow, hover lift + accent glow, selection outline. Static
	 * (terrain) bodies get the ground-line tone family instead — translucent
	 * slate fill, ground-line stroke, no drop shadow or hover lift (static
	 * geometry does not fall, so it does not hover-lift). `zoom` converts
	 * screen-constant widths to world units.
	 *
	 * PRD R2: the shadow/fill pair is rasterized ONCE per body into an
	 * offscreen sprite (Canvas2D shadowBlur is a per-fill raster cost that
	 * measured 14 fps at 200 bodies when paid every frame) and blitted per
	 * frame; only the hovered body takes the live glow path, and the
	 * selection outline stays a live stroke. Sprites re-rasterize when their
	 * shape reference, material color, staticness, or dpr changes, or when
	 * zoom drifts past SPRITE_ZOOM_DRIFT from the rasterization zoom (blit
	 * scaling within the drift window is imperceptible for soft shadows).
	 */
	interface BodySprite {
		canvas: HTMLCanvasElement;
		/** Half-extents of the SPRITE (body + margin) in world units. */
		halfW: number;
		halfH: number;
		zoom: number;
		dpr: number;
		color: string;
		isStatic: boolean;
		shape: BodyShape;
	}
	const bodySprites = new Map<string, BodySprite>();
	/** Persistent per-frame scratch: cleared and refilled by drawBodies — no
	 * per-frame Set allocation (P5 allocation card). */
	const seenScratch = new Set<string>();
	const SPRITE_ZOOM_DRIFT = 0.3;
	const SPRITE_MARGIN_PX =
		BODY_SHADOW_BLUR_PX + Math.abs(BODY_SHADOW_OFFSET_Y_PX) + 4;

	/** World-space half-extents of a shape (sprite bounds exclude margin). */
	function shapeHalfExtents(shape: BodyShape): { hw: number; hh: number } {
		if (shape.kind === "box") {
			return { hw: shape.halfWidth, hh: shape.halfHeight };
		}
		if (shape.kind === "circle") {
			return { hw: shape.radius, hh: shape.radius };
		}
		let maxX = 0;
		let maxY = 0;
		for (const p of shape.points) {
			maxX = Math.max(maxX, Math.abs(p.x));
			maxY = Math.max(maxY, Math.abs(p.y));
		}
		return { hw: maxX, hh: maxY };
	}

	function rasterizeBodySprite(
		shape: BodyShape,
		color: string,
		isStatic: boolean,
		zoom: number,
		dpr: number,
	): BodySprite {
		const { hw, hh } = shapeHalfExtents(shape);
		const marginW = SPRITE_MARGIN_PX / zoom;
		const sprite = document.createElement("canvas");
		const cssW = (hw + marginW) * 2 * zoom;
		const cssH = (hh + marginW) * 2 * zoom;
		sprite.width = Math.max(1, Math.ceil(cssW * dpr));
		sprite.height = Math.max(1, Math.ceil(cssH * dpr));
		const sctx = sprite.getContext("2d");
		if (sctx) {
			// Sprite origin at center; geometry in sprite CSS pixels = world·zoom.
			sctx.setTransform(
				dpr * zoom,
				0,
				0,
				dpr * zoom,
				sprite.width / 2,
				sprite.height / 2,
			);
			sctx.beginPath();
			traceShapePath(sctx, shape);
			if (isStatic) {
				sctx.fillStyle = STATIC_FILL;
				sctx.fill();
				sctx.strokeStyle = GROUND_COLOR;
				sctx.lineWidth = STATIC_STROKE_WIDTH_PX / zoom;
				sctx.stroke();
			} else {
				sctx.shadowColor = BODY_SHADOW;
				sctx.shadowBlur = BODY_SHADOW_BLUR_PX;
				sctx.shadowOffsetY = BODY_SHADOW_OFFSET_Y_PX;
				sctx.fillStyle = color;
				sctx.fill();
			}
		}
		return {
			canvas: sprite,
			halfW: hw + marginW,
			halfH: hh + marginW,
			zoom,
			dpr,
			color,
			isStatic,
			shape,
		};
	}

	function drawBodies(zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		const hoverId = scene.hoverId();
		const selectedIds = scene.selectedIds();
		const lift = HOVER_LIFT_PX / zoom;
		const dpr = window.devicePixelRatio;
		seenScratch.clear();
		scene.forEachBody((id, shape, x, y, rot, isStatic, color) => {
			const hovered = id === hoverId;
			seenScratch.add(id);
			if (hovered) {
				// The one live path: hover glow (lift only for dynamic bodies,
				// static geometry does not hover-lift).
				ctx.save();
				ctx.translate(x, !isStatic ? y - lift : y);
				ctx.rotate(rot);
				ctx.shadowColor = HOVER_GLOW;
				ctx.shadowBlur = HOVER_GLOW_BLUR_PX;
				ctx.beginPath();
				traceShapePath(ctx, shape);
				if (isStatic) {
					ctx.fillStyle = STATIC_FILL;
					ctx.fill();
					ctx.shadowColor = "transparent";
					ctx.shadowBlur = 0;
					ctx.strokeStyle = GROUND_COLOR;
					ctx.lineWidth = STATIC_STROKE_WIDTH_PX / zoom;
					ctx.stroke();
				} else {
					ctx.fillStyle = color;
					ctx.fill();
				}
				ctx.restore();
				return;
			}
			let sprite = bodySprites.get(id);
			if (
				!sprite ||
				sprite.shape !== shape ||
				sprite.color !== color ||
				sprite.isStatic !== isStatic ||
				sprite.dpr !== dpr ||
				Math.abs(sprite.zoom / zoom - 1) > SPRITE_ZOOM_DRIFT
			) {
				sprite = rasterizeBodySprite(shape, color, isStatic, zoom, dpr);
				bodySprites.set(id, sprite);
			}
			ctx.save();
			ctx.translate(x, y);
			ctx.rotate(rot);
			ctx.drawImage(
				sprite.canvas,
				-sprite.halfW,
				-sprite.halfH,
				sprite.halfW * 2,
				sprite.halfH * 2,
			);
			ctx.restore();
		});
		// Prune sprites of bodies that left the document (deletes, restores).
		if (bodySprites.size > seenScratch.size + 64) {
			for (const id of bodySprites.keys()) {
				if (!seenScratch.has(id)) bodySprites.delete(id);
			}
		}
		if (selectedIds.size > 0) drawSelectionOutlines(selectedIds, zoom);
	}

	/** Trace any body shape's closed path (caller begins/ends the path). */
	function traceShapePath(
		ctx: CanvasRenderingContext2D,
		shape: BodyShape,
	): void {
		if (shape.kind === "box") {
			ctx.rect(
				-shape.halfWidth,
				-shape.halfHeight,
				shape.halfWidth * 2,
				shape.halfHeight * 2,
			);
		} else if (shape.kind === "polygon") {
			tracePolyPath(ctx, shape.points);
		} else {
			ctx.arc(0, 0, shape.radius, 0, Math.PI * 2);
		}
	}

	/**
	 * Joints: accent ring + per-type inner glyph at the live anchor, subtle
	 * glow (DESIGN.md accent tokens), stronger when selected. Drawn above
	 * bodies so a pinned assembly always shows its pivots. The radius clamps
	 * to [5, 14] CSS px on screen (shared with the picker via
	 * jointGlyphRadius). Line-type glyphs (rod/spring/rope — open paths) are
	 * STROKED, not filled: Canvas fills a two-point open path as zero area,
	 * which rendered the rod glyph invisible before the T2 stroke pass.
	 */
	function drawJoints(zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		const selected = new Set(scene.selectedIds());
		const r = jointGlyphRadius(zoom);
		// PRD R2: glow is a selection affordance, not an every-glyph state —
		// the blur raster is per-draw, and rope-heavy scenes draw hundreds of
		// links. Shadow state toggles per item (selected only).
		ctx.strokeStyle = ACCENT_COLOR;
		scene.forEachJoint((id, jointType, wx, wy, motorOn, wx2, wy2, wx3, wy3) => {
			const isSel = selected.has(id);
			ctx.shadowColor = isSel ? HOVER_GLOW : "transparent";
			ctx.shadowBlur = isSel ? HOVER_GLOW_BLUR_PX : 0;
			if (jointType === "pulley") {
				// Fixed pulley (post-MVP): the two rope lines through the wheel
				// ARE the glyph's body, with a wheel circle at the scene point —
				// no anchor ring (the rope-link convention). Selection glow from
				// the shadow state above; screen-constant widths via 1/zoom.
				ctx.save();
				ctx.lineWidth = (isSel ? 2 : 1.2) / zoom;
				ctx.beginPath();
				ctx.moveTo(wx, wy);
				ctx.lineTo(wx3, wy3);
				ctx.lineTo(wx2, wy2);
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(wx3, wy3, r, 0, Math.PI * 2);
				ctx.stroke();
				ctx.restore();
				return;
			}
			if (jointType === "rope") {
				// Rope link (P4-T4): no ring, no inner glyph — the chain of
				// stroked link lines IS the rope's continuous curve through the
				// segment centers.
				ctx.save();
				ctx.lineWidth = (isSel ? 2 : 1.2) / zoom;
				ctx.beginPath();
				ctx.moveTo(wx, wy);
				ctx.lineTo(wx2, wy2);
				ctx.stroke();
				ctx.restore();
				return;
			}
			// A stopped motor draws dimmed (the at-a-glance on/off state the
			// toggle affordance flips); everything else keeps the accent.
			const dim = jointType === "motor" && !motorOn;
			ctx.save();
			ctx.lineWidth = (isSel ? 2 : 1.5) / zoom;
			ctx.strokeStyle = dim ? JOINT_OFF_COLOR : ACCENT_COLOR;
			ctx.beginPath();
			ctx.arc(wx, wy, r, 0, Math.PI * 2);
			ctx.stroke();
			ctx.fillStyle = dim ? JOINT_OFF_COLOR : ACCENT_COLOR;
			const type = jointType as JointType;
			traceJointGlyph(ctx, type, wx, wy, r);
			if (LINE_GLYPH_TYPES.has(type)) {
				// Open path (a line, not a region): fill is zero-area; stroke it.
				ctx.stroke();
			} else {
				ctx.fill();
			}
			if (type === "spring") {
				// Coil between the anchors (P4-T4): the visible spring body.
				traceSpringCoil(ctx, wx, wy, wx2, wy2, zoom);
			}
			ctx.restore();
		});
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;
	}

	/**
	 * Stroke a zigzag coil between two anchor points — the spring's visible
	 * body (P4-T4). Amplitude is at least ~5 CSS px so the coil reads at any
	 * zoom; 12 points alternate side to side along the anchor axis.
	 */
	function traceSpringCoil(
		ctx: CanvasRenderingContext2D,
		x1: number,
		y1: number,
		x2: number,
		y2: number,
		zoom: number,
	): void {
		const dx = x2 - x1;
		const dy = y2 - y1;
		const len = Math.hypot(dx, dy);
		if (len < 1e-6) return;
		const ux = dx / len;
		const uy = dy / len;
		const px = -uy;
		const py = ux;
		const zigs = 12;
		const amp = Math.max(0.3, 5 / zoom);
		ctx.beginPath();
		ctx.moveTo(x1, y1);
		for (let i = 1; i < zigs; i++) {
			const t = i / zigs;
			const sign = i % 2 === 0 ? 1 : -1;
			ctx.lineTo(
				x1 + ux * len * t + px * amp * sign,
				y1 + uy * len * t + py * amp * sign,
			);
		}
		ctx.lineTo(x2, y2);
		ctx.stroke();
	}

	/**
	 * Thrusters (P4-T5): a direction arrow at the mounted body's live anchor —
	 * a shaft from behind the anchor to its tip, plus a filled head, screen-
	 * constant size (scaled by 1/zoom like every other glyph), accent when
	 * thrusting, dimmed when off (the motor-marker convention).
	 */
	function drawThrusters(zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		const selected = scene.selectedIds();
		const r = jointGlyphRadius(zoom);
		ctx.lineWidth = 1.5 / zoom;
		const now = performance.now();
		scene.forEachThruster((id, wx, wy, angle, on) => {
			const isSel = selected.has(id);
			// Same PRD R2 rule as joints: glow on selection only.
			ctx.shadowColor = isSel ? HOVER_GLOW : "transparent";
			ctx.shadowBlur = isSel ? HOVER_GLOW_BLUR_PX : 0;
			const color = on ? ACCENT_COLOR : JOINT_OFF_COLOR;
			const ux = Math.cos(angle);
			const uy = Math.sin(angle);
			// Exhaust plume (thrusting only): three tapering flat-fill layers
			// shooting OPPOSITE the thrust direction from just behind the
			// mount. Flat fills only (PRD R2 — no per-frame shadow state);
			// the flicker is two cheap sines keyed by the id hash so multiple
			// thrusters never pulse in sync.
			if (on) {
				let hash = 0;
				for (let i = 0; i < id.length; i++) {
					hash = (hash * 31 + id.charCodeAt(i)) | 0;
				}
				const t = now / 1000;
				const flicker =
					1 +
					0.13 * Math.sin(t * 21 + hash) +
					0.09 * Math.sin(t * 47 + hash * 2.7);
				const fx = wx - ux * r * 1.6;
				const fy = wy - uy * r * 1.6;
				const px = -uy;
				const py = ux;
				const layers: Array<[number, number, string]> = [
					[26, 5.2, "rgba(255, 138, 66, 0.55)"],
					[17, 3.6, "rgba(255, 179, 71, 0.75)"],
					[9, 2.2, "rgba(255, 224, 130, 0.9)"],
				];
				for (const [len, half, fill] of layers) {
					const L = len / zoom;
					const H = (half * flicker) / zoom;
					ctx.fillStyle = fill;
					ctx.beginPath();
					ctx.moveTo(fx, fy);
					ctx.lineTo(fx - ux * L + px * H, fy - uy * L + py * H);
					ctx.lineTo(fx - ux * L * 1.25, fy - uy * L * 1.25);
					ctx.lineTo(fx - ux * L - px * H, fy - uy * L - py * H);
					ctx.closePath();
					ctx.fill();
				}
			}
			// Dark casing under the glyph so the accent reads on any body fill
			// (the on-body contrast report): a wider stage-void stroke behind
			// the shaft and an outlined head triangle.
			const casing = "rgba(17, 20, 24, 0.85)";
			ctx.strokeStyle = casing;
			ctx.lineWidth = 4.4 / zoom;
			ctx.beginPath();
			ctx.moveTo(wx - ux * r * 2.6, wy - uy * r * 2.6);
			ctx.lineTo(wx + ux * r * 1.0, wy + uy * r * 1.0);
			ctx.stroke();
			ctx.strokeStyle = color;
			ctx.fillStyle = color;
			ctx.save();
			if (isSel) ctx.lineWidth = 2 / zoom;
			ctx.lineWidth = (isSel ? 2 : 1.5) / zoom;
			// Shaft from behind the anchor through it, head at the tip. The
			// head draws a filled casing triangle first (same contrast fix).
			ctx.beginPath();
			ctx.moveTo(wx - ux * r * 2.4, wy - uy * r * 2.4);
			ctx.lineTo(wx + ux * r * 0.8, wy + uy * r * 0.8);
			ctx.stroke();
			ctx.strokeStyle = casing;
			ctx.fillStyle = casing;
			ctx.beginPath();
			ctx.moveTo(wx + ux * r * 2.45, wy + uy * r * 2.45);
			ctx.lineTo(
				wx + ux * r * 0.45 - uy * r * 1.3,
				wy + uy * r * 0.45 + ux * r * 1.3,
			);
			ctx.lineTo(
				wx + ux * r * 0.45 + uy * r * 1.3,
				wy + uy * r * 0.45 - ux * r * 1.3,
			);
			ctx.closePath();
			ctx.fill();
			ctx.strokeStyle = color;
			ctx.fillStyle = color;
			ctx.moveTo(wx + ux * r * 2.2, wy + uy * r * 2.2);
			ctx.lineTo(
				wx + ux * r * 0.6 - uy * r * 1.1,
				wy + uy * r * 0.6 + ux * r * 1.1,
			);
			ctx.lineTo(
				wx + ux * r * 0.6 + uy * r * 1.1,
				wy + uy * r * 0.6 - ux * r * 1.1,
			);
			ctx.closePath();
			ctx.fill();
			ctx.restore();
		});
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;
	}

	/**
	 * Per-type inner glyph inside the anchor ring (distinct icon per joint
	 * type): pin = center dot, weld = square, slider = bar with end rails,
	 * motor = dot with an arc tick, rod = spoke, spring/rope = zig-zag.
	 * Path-only (the caller fills); all marks fit inside the ring.
	 */
	function traceJointGlyph(
		ctx: CanvasRenderingContext2D,
		jointType: JointType,
		x: number,
		y: number,
		r: number,
	): void {
		const s = r * 0.45;
		ctx.beginPath();
		switch (jointType) {
			case "pin":
				ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
				break;
			case "weld":
				ctx.rect(x - s, y - s, s * 2, s * 2);
				break;
			case "slider":
				ctx.rect(x - s * 1.6, y - s * 0.35, s * 3.2, s * 0.7);
				ctx.moveTo(x - s, y - s);
				ctx.lineTo(x - s, y + s);
				ctx.moveTo(x + s, y - s);
				ctx.lineTo(x + s, y + s);
				break;
			case "motor":
				ctx.arc(x, y, s * 0.6, 0, Math.PI * 2);
				ctx.moveTo(x + s * 1.2, y);
				ctx.arc(x, y, s * 1.2, 0, Math.PI / 3);
				break;
			case "rod":
				ctx.moveTo(x - s, y + s);
				ctx.lineTo(x + s, y - s);
				break;
			default:
				// spring / rope: a small zig-zag across the ring
				ctx.moveTo(x - s, y);
				ctx.lineTo(x - s * 0.4, y - s);
				ctx.lineTo(x + s * 0.4, y + s);
				ctx.lineTo(x + s, y);
				break;
		}
	}

	/**
	 * Committed labels: text drawn in world space at the anchor point. A
	 * user-set size (label panel) scales with the camera transform; labels
	 * without one keep the zoom-adaptive default so old scenes render exactly
	 * as before.
	 */
	function drawLabels(zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		ctx.fillStyle = LABEL_COLOR;
		scene.forEachLabel((_id, x, y, rot, text, size, font, align) => {
			const px = size ?? effectiveLabelFontSize(zoom);
			ctx.font = `${px}px ${labelFontFamily(font)}`;
			ctx.textAlign = align ?? "left";
			ctx.save();
			ctx.translate(x, y);
			ctx.rotate(rot);
			ctx.fillText(text, 0, 0);
			ctx.restore();
		});
	}

	/** The canvas font-family list for a label family (sans = the default). */
	function labelFontFamily(font: LabelFont | undefined): string {
		if (font === "serif") return 'Georgia, "Times New Roman", serif';
		if (font === "mono") return "ui-monospace, Menlo, Consolas, monospace";
		return "system-ui, -apple-system, sans-serif";
	}

	/** Accent outlines + glow around every selected body. Takes the LIVE
	 * selection set — no per-frame copy (P5 allocation card). */
	function drawSelectionOutlines(
		wanted: ReadonlySet<string>,
		zoom: number,
	): void {
		const scene = options.scene;
		if (!scene) return;
		ctx.shadowColor = HOVER_GLOW;
		ctx.shadowBlur = HOVER_GLOW_BLUR_PX;
		ctx.strokeStyle = ACCENT_COLOR;
		ctx.lineWidth = SELECTION_WIDTH_PX / zoom;
		scene.forEachBody((bid, shape, x, y, rot) => {
			if (!wanted.has(bid)) return;
			ctx.save();
			ctx.translate(x, y);
			ctx.rotate(rot);
			ctx.beginPath();
			if (shape.kind === "circle") {
				// A circle's edge stroke half-covers its own fill; pad the
				// selection ring outside the shape like the box outline reads.
				ctx.arc(0, 0, shape.radius + SELECTION_PAD_PX / zoom, 0, Math.PI * 2);
			} else {
				traceShapePath(ctx, shape);
			}
			ctx.stroke();
			ctx.restore();
		});
		// Selected labels: accent rectangle around the estimated hit box,
		// sized to the font actually drawn at this zoom (a user-set label
		// size overrides, and alignment shifts the box like the drawing).
		scene.forEachLabel(
			(
				lid: string,
				x: number,
				y: number,
				rot: number,
				text: string,
				size: number | undefined,
				_font: LabelFont | undefined,
				align: LabelTextAlign | undefined,
			) => {
				if (!wanted.has(lid)) return;
				ctx.save();
				ctx.translate(x, y);
				ctx.rotate(rot);
				const b = labelBounds(
					0,
					0,
					text,
					size ?? effectiveLabelFontSize(zoom),
					align ?? "left",
				);
				ctx.strokeRect(b.x0, b.y0, b.x1 - b.x0, b.y1 - b.y0);
				ctx.restore();
			},
		);
		ctx.shadowColor = "transparent";
		ctx.shadowBlur = 0;
	}

	/** Accent rubber-band rectangle while it sizes the selection frame. */
	function drawRubberBand(zoom: number): void {
		const scene = options.scene;
		if (!scene) return;
		const rect = scene.rubberBand();
		if (!rect) return;
		ctx.strokeStyle = ACCENT_COLOR;
		ctx.lineWidth = 1 / zoom;
		ctx.setLineDash([4 / zoom, 3 / zoom]);
		ctx.strokeRect(
			rect.cx - rect.halfWidth,
			rect.cy - rect.halfHeight,
			rect.halfWidth * 2,
			rect.halfHeight * 2,
		);
		ctx.setLineDash([]);
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
		if (p.kind === "line") {
			// Path construction captures the transform; restore is safe.
			ctx.save();
			ctx.translate(p.cx, p.cy);
			ctx.rotate(p.rot);
			ctx.rect(-p.halfLength, -p.halfWidth, p.halfLength * 2, p.halfWidth * 2);
			ctx.restore();
		} else if (p.kind === "stroke") {
			const first = p.points[0];
			if (first) {
				ctx.moveTo(first.x, first.y);
				for (let i = 1; i < p.points.length; i++) {
					const q = p.points[i] as { x: number; y: number };
					ctx.lineTo(q.x, q.y);
				}
			}
		} else if (p.kind === "polygon") {
			tracePolyPath(ctx, p.points);
		} else if (p.kind === "joint") {
			// Joint attach preview: accent line from the first anchor to the
			// cursor, endpoint rings at both ends; the far end's ring is dashed
			// when it is over empty space (world anchor). With `wheel` set (the
			// pulley's third-click phase) the preview draws the rope path
			// from→wheel→to with the wheel glyph under the cursor instead.
			ctx.save();
			ctx.shadowColor = "transparent";
			ctx.shadowBlur = 0;
			if (p.wheel) {
				ctx.beginPath();
				ctx.moveTo(p.from.x, p.from.y);
				ctx.lineTo(p.wheel.x, p.wheel.y);
				ctx.lineTo(p.to.x, p.to.y);
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(p.wheel.x, p.wheel.y, jointGlyphRadius(zoom), 0, Math.PI * 2);
				ctx.stroke();
				ctx.beginPath();
				ctx.arc(p.to.x, p.to.y, jointGlyphRadius(zoom), 0, Math.PI * 2);
				ctx.stroke();
				ctx.restore();
				return;
			}
			ctx.beginPath();
			ctx.moveTo(p.from.x, p.from.y);
			ctx.lineTo(p.to.x, p.to.y);
			ctx.stroke();
			ctx.setLineDash(p.toBody ? [] : [3 / zoom, 2 / zoom]);
			ctx.beginPath();
			ctx.arc(p.to.x, p.to.y, jointGlyphRadius(zoom), 0, Math.PI * 2);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.beginPath();
			ctx.arc(p.from.x, p.from.y, jointGlyphRadius(zoom), 0, Math.PI * 2);
			ctx.stroke();
			ctx.restore();
			return;
		} else if (p.kind === "thruster-aim") {
			// Drag-to-aim preview: a dashed accent ray from the mount toward
			// the cursor with an open arrowhead — the thrust direction the
			// release will store.
			ctx.save();
			ctx.shadowColor = "transparent";
			ctx.shadowBlur = 0;
			const ux = Math.cos(p.angle);
			const uy = Math.sin(p.angle);
			const px = -uy;
			const py = ux;
			const ray = 90 / zoom;
			ctx.setLineDash([5 / zoom, 3 / zoom]);
			ctx.beginPath();
			ctx.moveTo(p.x, p.y);
			ctx.lineTo(p.x + ux * ray, p.y + uy * ray);
			ctx.stroke();
			ctx.setLineDash([]);
			ctx.beginPath();
			ctx.moveTo(p.x + ux * ray, p.y + uy * ray);
			ctx.lineTo(
				p.x + ux * ray * 0.82 - (px * 6) / zoom,
				p.y + uy * ray * 0.82 + (py * 6) / zoom,
			);
			ctx.lineTo(
				p.x + ux * ray * 0.82 + (px * 6) / zoom,
				p.y + uy * ray * 0.82 - (py * 6) / zoom,
			);
			ctx.closePath();
			ctx.stroke();
			ctx.restore();
			return;
		} else if (p.kind === "text") {
			// In-progress label: the typed text, or a caret while empty.
			ctx.save();
			ctx.shadowColor = "transparent";
			ctx.shadowBlur = 0;
			ctx.fillStyle = LABEL_COLOR;
			ctx.font = `${effectiveLabelFontSize(zoom)}px system-ui, -apple-system, sans-serif`;
			if (p.text.length > 0) {
				ctx.fillText(p.text, p.x, p.y);
			} else {
				const size = effectiveLabelFontSize(zoom);
				ctx.fillStyle = ACCENT_COLOR;
				ctx.fillRect(p.x, p.y - size * 0.85, LABEL_CARET_WIDTH_PX / zoom, size);
			}
			ctx.restore();
			return;
		} else if (p.kind === "rect") {
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
		if (p.kind === "polygon" && p.closable) {
			// Accent dot on the first vertex: the close-click target.
			ctx.fillStyle = ACCENT_COLOR;
			ctx.beginPath();
			ctx.arc(p.first.x, p.first.y, 4 / zoom, 0, Math.PI * 2);
			ctx.fill();
		}
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
		get gridSize() {
			return gridSpacingUser;
		},
		set gridSize(v: number) {
			// Clamp to the smallest coarsening base so the drawn grid and the
			// snapping always share one spacing.
			gridSpacingUser = Math.max(GRID_BASE_SPACING, v);
		},
	};
}
