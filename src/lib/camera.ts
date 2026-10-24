/**
 * Camera: zoom and pan state mapping world coordinates to screen (CSS pixel)
 * coordinates. Pure math — no DOM. Renderer composes this with devicePixelRatio.
 *
 * Convention: screen = world · zoom + offset, y-down in both spaces (the
 * canvas convention; the physics world is y-down too — see src/lib/world.ts).
 */

/**
 * Zoom scale limits. The same 1 world unit maps to this many CSS pixels.
 */
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 20;

/**
 * Multiplicative wheel zoom sensitivity: zoom factor per unit of wheel deltaY
 * (pixel mode), applied as `exp(-deltaY · sensitivity)` so scrolling up zooms in.
 */
export const WHEEL_ZOOM_SENSITIVITY = 0.0015;

/** A 2D point in whatever space the caller names. */
export interface Point2 {
	x: number;
	y: number;
}

/**
 * Pan/zoom camera. All coordinates are CSS pixels unless a `dpr` argument is
 * passed, which converts to/from canvas backing-store pixels.
 */
export class Camera {
	zoom = 1;
	offsetX = 0;
	offsetY = 0;

	/** Pan by a screen-space (CSS pixel) delta. */
	panBy(dx: number, dy: number): void {
		this.offsetX += dx;
		this.offsetY += dy;
	}

	/**
	 * Zoom by a multiplicative factor anchored at screen point (`sx`, `sy`):
	 * the world point under the anchor stays under it. Clamped to
	 * [MIN_ZOOM, MAX_ZOOM]; a no-op when already saturated.
	 */
	zoomAt(sx: number, sy: number, factor: number): void {
		const next = clampZoom(this.zoom * factor);
		if (next === this.zoom) return;
		const k = next / this.zoom;
		this.offsetX = sx - (sx - this.offsetX) * k;
		this.offsetY = sy - (sy - this.offsetY) * k;
		this.zoom = next;
	}

	/**
	 * World → screen. With `dpr` = 1 returns CSS pixels; otherwise backing-store
	 * pixels. Inverse of {@link Camera.screenToWorld} for the same `dpr`.
	 */
	worldToScreen(wx: number, wy: number, dpr = 1): Point2 {
		return {
			x: (wx * this.zoom + this.offsetX) * dpr,
			y: (wy * this.zoom + this.offsetY) * dpr,
		};
	}

	/**
	 * Screen → world. `sx`/`sy` are CSS pixels (or backing-store pixels when
	 * `dpr` ≠ 1). Inverse of {@link Camera.worldToScreen} for the same `dpr`.
	 */
	screenToWorld(sx: number, sy: number, dpr = 1): Point2 {
		return {
			x: (sx / dpr - this.offsetX) / this.zoom,
			y: (sy / dpr - this.offsetY) / this.zoom,
		};
	}

	/** Copy of the transform state, for inspection and debug hooks. */
	state(): CameraState {
		return { zoom: this.zoom, offsetX: this.offsetX, offsetY: this.offsetY };
	}
}

export interface CameraState {
	zoom: number;
	offsetX: number;
	offsetY: number;
}

export function clampZoom(zoom: number): number {
	return Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
}
