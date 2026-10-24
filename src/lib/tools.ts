/**
 * Tool system, DOM-free: tool identity, drag-to-size math, body picking, and
 * the tool state machine that turns pointer events into spawn/drag commands.
 * All geometry is in world coordinates (y-down world per src/lib/world.ts).
 * DOM wiring lives in src/lib/interaction.ts.
 */
import type { BodyShape } from "./world";

export type ToolId = "select" | "box" | "circle";

/** Keyboard shortcuts: V select, B box, C circle. */
export const TOOL_KEYS: Record<string, ToolId> = {
	KeyV: "select",
	KeyB: "box",
	KeyC: "circle",
};

/**
 * Smallest allowed half-size: a click without a drag still commits a shape of
 * at least this half-extent (1x1 box / r=0.5 circle) instead of a degenerate one.
 */
export const MIN_SHAPE_HALF_SIZE = 0.5;

/** Axis-aligned drag rectangle from two corners, clamped to the minimum size. */
export interface DragRect {
	readonly cx: number;
	readonly cy: number;
	readonly halfWidth: number;
	readonly halfHeight: number;
}

/** Rectangle centered on the drag's midpoint, half-extents clamped to the minimum. */
export function rectFromDrag(
	ax: number,
	ay: number,
	bx: number,
	by: number,
): DragRect {
	const cx = (ax + bx) / 2;
	const cy = (ay + by) / 2;
	const halfWidth = Math.max(Math.abs(bx - ax) / 2, MIN_SHAPE_HALF_SIZE);
	const halfHeight = Math.max(Math.abs(by - ay) / 2, MIN_SHAPE_HALF_SIZE);
	return { cx, cy, halfWidth, halfHeight };
}

/**
 * Circle from drag: center is the drag rectangle's midpoint, radius is half
 * the rectangle's larger side (the circle reaches the longer sides' midpoints;
 * the rectangle's corners lie outside it). A click without a drag yields the
 * minimum radius.
 */
export function circleFromDrag(
	ax: number,
	ay: number,
	bx: number,
	by: number,
): { cx: number; cy: number; radius: number } {
	const rect = rectFromDrag(ax, ay, bx, by);
	return {
		cx: rect.cx,
		cy: rect.cy,
		radius: Math.max(rect.halfWidth, rect.halfHeight),
	};
}

/** One body snapshot for picking. */
export interface PickableBody {
	readonly id: string;
	readonly shape: BodyShape;
	readonly x: number;
	readonly y: number;
	readonly rot: number;
}

/**
 * Topmost body containing the world point, or undefined. Bodies are tested
 * last-to-first so later entries (drawn on top, spawned later) win. Circles
 * and boxes use exact shape tests; boxes account for their rotation.
 */
export function pickBody(
	bodies: readonly PickableBody[],
	wx: number,
	wy: number,
): string | undefined {
	for (let i = bodies.length - 1; i >= 0; i--) {
		const b = bodies[i];
		if (!b) continue;
		if (b.shape.kind === "circle") {
			const dx = wx - b.x;
			const dy = wy - b.y;
			if (dx * dx + dy * dy <= b.shape.radius * b.shape.radius) return b.id;
		} else {
			const cos = Math.cos(-b.rot);
			const sin = Math.sin(-b.rot);
			const dx = wx - b.x;
			const dy = wy - b.y;
			const lx = dx * cos - dy * sin;
			const ly = dx * sin + dy * cos;
			if (
				Math.abs(lx) <= b.shape.halfWidth &&
				Math.abs(ly) <= b.shape.halfHeight
			) {
				return b.id;
			}
		}
	}
	return undefined;
}

/** Events the session emits; the interaction layer forwards them to the world. */
export interface ToolSessionEvents {
	/** A drag-to-size shape was committed on release. */
	onSpawnBox(shape: DragRect): void;
	onSpawnCircle(shape: { cx: number; cy: number; radius: number }): void;
	/** A body was grabbed with the select tool; `grab` is the world grab point. */
	onDragStart(id: string, grab: { x: number; y: number }): void;
	onDragMove(target: { x: number; y: number }): void;
	onDragEnd(): void;
}

type Phase =
	| { readonly kind: "idle" }
	| {
			readonly kind: "drawing";
			startX: number;
			startY: number;
			curX: number;
			curY: number;
	  }
	| { readonly kind: "dragging"; id: string };

/**
 * Tool state machine. Feed it world-space pointer events; it emits spawn and
 * drag commands. `pick` resolves hover and press against the live body list.
 */
export class ToolSession {
	tool: ToolId = "select";
	/** Body under the pointer (hover), updated by pointerMove when idle. */
	hoverId: string | undefined;
	/** Currently selected body. */
	selectedId: string | undefined;

	private phase: Phase = { kind: "idle" };

	constructor(
		private readonly events: ToolSessionEvents,
		private readonly pick: (wx: number, wy: number) => string | undefined,
	) {}

	/** The in-progress drawing preview geometry, or null when not drawing. */
	preview(): DragRect | { cx: number; cy: number; radius: number } | null {
		if (this.phase.kind !== "drawing") return null;
		return this.tool === "box"
			? rectFromDrag(
					this.phase.startX,
					this.phase.startY,
					this.phase.curX,
					this.phase.curY,
				)
			: circleFromDrag(
					this.phase.startX,
					this.phase.startY,
					this.phase.curX,
					this.phase.curY,
				);
	}

	setTool(tool: ToolId): void {
		if (tool === this.tool) return;
		// A tool change terminates the in-progress gesture outright: a drag
		// releases its body (like pointerUp), a drawing is discarded without
		// committing, and the phase returns to idle so the release that follows
		// the switch is a no-op.
		if (this.phase.kind === "dragging") this.events.onDragEnd();
		this.phase = { kind: "idle" };
		this.tool = tool;
	}

	/** Cancel drawing or drag; Escape with nothing in progress clears selection. */
	cancel(): void {
		if (this.phase.kind === "dragging") this.events.onDragEnd();
		const wasDragging = this.phase.kind === "dragging";
		this.phase = { kind: "idle" };
		if (!wasDragging) this.selectedId = undefined;
	}

	pointerDown(wx: number, wy: number): void {
		if (this.phase.kind !== "idle") return;
		if (this.tool === "select") {
			const hit = this.pick(wx, wy);
			this.selectedId = hit;
			if (hit) {
				this.phase = { kind: "dragging", id: hit };
				this.events.onDragStart(hit, { x: wx, y: wy });
			}
			return;
		}
		this.phase = {
			kind: "drawing",
			startX: wx,
			startY: wy,
			curX: wx,
			curY: wy,
		};
	}

	pointerMove(wx: number, wy: number): void {
		if (this.phase.kind === "drawing") {
			this.phase = { ...this.phase, curX: wx, curY: wy };
			return;
		}
		if (this.phase.kind === "dragging") {
			this.events.onDragMove({ x: wx, y: wy });
			return;
		}
		this.hoverId = this.pick(wx, wy);
	}

	pointerUp(): void {
		if (this.phase.kind === "drawing") {
			const { startX, startY, curX, curY } = this.phase;
			this.phase = { kind: "idle" };
			if (this.tool === "box") {
				this.events.onSpawnBox(rectFromDrag(startX, startY, curX, curY));
			} else {
				this.events.onSpawnCircle(circleFromDrag(startX, startY, curX, curY));
			}
			return;
		}
		if (this.phase.kind === "dragging") {
			this.phase = { kind: "idle" };
			this.events.onDragEnd();
		}
	}
}
