/**
 * Tool system, DOM-free: tool identity, drag-to-size math, polygon/line
 * placement state machines, body picking, selection-set state (click,
 * shift-toggle, rubber-band), and the tool state machine that turns pointer
 * events into spawn/move/rotate/delete/duplicate commands. All geometry is in
 * world coordinates (y-down world per src/lib/world.ts). DOM wiring lives in
 * src/lib/interaction.ts.
 */
import type { BodyShape, LabelTextAlign } from "./document";
import {
	decideFreehand,
	type FreehandDecision,
	FreehandStrokeBuilder,
} from "./freehand";
import { jointPickRadius, type PlaceableJointKind } from "./joint";
import { showNotice } from "./notice";
import { THRUSTER_AIM_MIN_DRAG } from "./thruster";
import { pointInPolygon, type Vec2 } from "./triangulate";

export type ToolId =
	| "select"
	| "box"
	| "circle"
	| "polygon"
	| "line"
	| "freehand"
	| "text"
	| "thruster"
	| "joint"
	| "snap";

/** All tool ids, for DOM validation of toolbar buttons. */
export const TOOL_IDS: readonly ToolId[] = [
	"select",
	"box",
	"joint",
	"snap",
	"circle",
	"polygon",
	"line",
	"freehand",
	"text",
	"thruster",
];

export function isToolId(value: string): value is ToolId {
	return (TOOL_IDS as readonly string[]).includes(value);
}

/**
 * Keyboard shortcuts: V select, B box, C circle, G polygon, L line, F
 * freehand, T text, H thruster, J joint, N snap.
 */
export const TOOL_KEYS: Record<string, ToolId> = {
	KeyV: "select",
	KeyB: "box",
	KeyC: "circle",
	KeyG: "polygon",
	KeyL: "line",
	KeyF: "freehand",
	KeyT: "text",
	KeyH: "thruster",
	KeyJ: "joint",
	KeyN: "snap",
};

/**
 * Base label text size in world units (the text tool's font at high zoom).
 * The on-screen size is clamped to a readable window by
 * {@link effectiveLabelFontSize} — the ONE font-size computation shared by
 * the renderer, the picker, and the selection outline, so what you see is
 * exactly what you can click at every zoom.
 */
export const LABEL_FONT_SIZE = 1.5;
/** Label font screen-size clamp (CSS px): smallest readable, largest sane. */
export const LABEL_MIN_PX = 10;
export const LABEL_MAX_PX = 48;
/** Estimated average glyph width as a fraction of the font size (system-ui). */
export const LABEL_CHAR_WIDTH = 0.6;

/**
 * The label font size in world units at the given zoom: the on-screen height
 * of the text stays within [LABEL_MIN_PX, LABEL_MAX_PX] CSS pixels. Zooming
 * out grows the world-unit size (labels never become unreadably small);
 * zooming in shrinks it (labels never balloon).
 */
export function effectiveLabelFontSize(zoom: number): number {
	return Math.min(
		Math.max(LABEL_FONT_SIZE, LABEL_MIN_PX / zoom),
		LABEL_MAX_PX / zoom,
	);
}

/**
 * Smallest allowed half-size: a click without a drag still commits a shape of
 * at least this half-extent (1x1 box / r=0.5 circle) instead of a degenerate one.
 */
export const MIN_SHAPE_HALF_SIZE = 0.5;

/**
 * Spawn floor for the drag-drawn shapes (box, circle, beam): a plain click or
 * a sub-minimum drag commits at this half-size instead of a pixel dot —
 * 4 world units reads as a visible 8-unit shape at 1× zoom. The freehand
 * simplification keeps its own, much finer granularity via
 * {@link MIN_SHAPE_HALF_SIZE}.
 */
export const MIN_SPAWN_HALF_SIZE = 4;

/**
 * Line/beam thickness: the beam is a thin rotated box (half-extent across the
 * segment). Chosen over a capsule for an exact rectangular silhouette and a
 * cheap collider; the width is fixed until a properties panel exists.
 */
export const BEAM_HALF_WIDTH = 0.25;

/**
 * Segment drag vs. two-click threshold: a release within this distance of the
 * press keeps the line tool armed for a second click (two-click drawing).
 */
export const SEGMENT_CLICK_EPSILON = 0.05;

/** Click within this world distance of the first vertex closes a polygon. */
export const POLYGON_CLOSE_RADIUS = 0.75;

/**
 * The close hitbox is at least this many SCREEN pixels regardless of zoom
 * (world radius = px / zoom) — the 0.75-world-unit floor is sub-pixel at 1×
 * zoom, which made the close click unusable. The renderer draws the
 * first-vertex ring at exactly this radius, so the ring IS the hitbox.
 */
export const POLYGON_CLOSE_SCREEN_PX = 12;

/** How the inline label edit handles a key. */
export type EditKeyAction = "commit" | "backspace" | "insert" | "ignore";

/**
 * Classify a keydown for the inline label edit (DOM-free). Modifier combos
 * (Cmd/Ctrl/Alt + anything) are "ignore" — the edit must neither commit nor
 * undo on shortcuts like Cmd+Z, nor type the bare letter into the text.
 */
export function classifyEditKey(event: {
	readonly code: string;
	readonly key: string;
	readonly ctrlKey: boolean;
	readonly metaKey: boolean;
	readonly altKey: boolean;
}): EditKeyAction {
	if (event.ctrlKey || event.metaKey || event.altKey) return "ignore";
	if (event.code === "Enter" || event.code === "Escape") return "commit";
	// Delete edits the text like Backspace during an inline label edit (a
	// bare Delete was a silent no-op — the UX card's delete-while-editing).
	if (event.code === "Backspace" || event.code === "Delete") return "backspace";
	if (event.key.length === 1) return "insert";
	return "ignore";
}

/**
 * Duplicate offset copy placement, world units: right and up (y-down world).
 * A fixed delta so repeated duplicates tile diagonally.
 */
export const DUPLICATE_OFFSET = { x: 1, y: -1 } as const;

/**
 * Rotate sensitivity for R-drag: radians of rotation per world unit of
 * vertical pointer travel. Dragging down (y-down world) rotates clockwise.
 */
export const ROTATE_RADIANS_PER_UNIT = 0.01;

/**
 * Fling estimation (P3 rotation momentum): samples older than this many
 * seconds fully decay out of the EMA, so a hesitation before release never
 * flings; below this angular speed a release is a stop, not a fling.
 */
export const ROTATE_FLING_STALE_S = 0.12;
export const ROTATE_FLING_MIN_RAD_S = 0.8;
/** Hard cap on a fling's applied spin (provisional — sane tumble, no cannon). */
export const ROTATE_FLING_MAX_RAD_S = 12;

/** Angle swept by a vertical drag from `startY` to `curY`. */
export function angleFromVerticalDrag(startY: number, curY: number): number {
	return (curY - startY) * ROTATE_RADIANS_PER_UNIT;
}

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
	square = false,
): DragRect {
	const cx = (ax + bx) / 2;
	const cy = (ay + by) / 2;
	// Square constrain: the larger drag dimension wins, so growing past the
	// other axis keeps the shape square instead of collapsing it.
	const side = square
		? Math.max(
				Math.abs(bx - ax) / 2,
				Math.abs(by - ay) / 2,
				MIN_SPAWN_HALF_SIZE,
			)
		: 0;
	const halfWidth = square
		? side
		: Math.max(Math.abs(bx - ax) / 2, MIN_SPAWN_HALF_SIZE);
	const halfHeight = square
		? side
		: Math.max(Math.abs(by - ay) / 2, MIN_SPAWN_HALF_SIZE);
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

/**
 * Circle from center (the draw-options Center toggle): the press point stays
 * the center; the radius tracks the larger drag dimension — the same "reaches
 * the longer sides' midpoints" convention as {@link circleFromDrag}, just
 * anchored at the press point instead of the drag midpoint.
 */
export function circleFromCenterDrag(
	ax: number,
	ay: number,
	bx: number,
	by: number,
): { cx: number; cy: number; radius: number } {
	return {
		cx: ax,
		cy: ay,
		radius: Math.max(Math.abs(bx - ax), Math.abs(by - ay), MIN_SPAWN_HALF_SIZE),
	};
}

/** Default grid spacing in world units (matches the 1×-zoom adaptive grid). */
export const DEFAULT_GRID_SIZE = 32;

/** Rotation angle snap quantum (the draw-options Angle-snap toggle). */
export const ANGLE_SNAP_STEP = Math.PI / 12;

/** Nearest multiple of `step` (radians) — 15° steps by default. */
export function snapAngle(rad: number, step = ANGLE_SNAP_STEP): number {
	return Math.round(rad / step) * step;
}

/** Nearest grid multiple (the draw-options Snap toggle; `size` in world units). */
export function snapToGrid(value: number, size: number): number {
	return Math.round(value / size) * size;
}

/**
 * Snap the segment's far end so its direction is the nearest multiple of 45°
 * (horizontal, vertical, or diagonal — the line-run shift-constraint). Length
 * is preserved; the start point stays put.
 */
export function constrainSegment(
	ax: number,
	ay: number,
	bx: number,
	by: number,
): Vec2 {
	const dx = bx - ax;
	const dy = by - ay;
	if (dx === 0 && dy === 0) return { x: bx, y: by };
	const length = Math.hypot(dx, dy);
	const step = Math.PI / 4;
	const snapped = Math.round(Math.atan2(dy, dx) / step) * step;
	return {
		x: ax + length * Math.cos(snapped),
		y: ay + length * Math.sin(snapped),
	};
}

/** Rotated thin-box geometry for a straight segment (the line/beam tool). */
export interface BeamGeom {
	readonly cx: number;
	readonly cy: number;
	readonly rot: number;
	readonly halfLength: number;
	readonly halfWidth: number;
}

/** Live preview geometry for whichever draw tool is active. */
export type DrawPreview =
	| {
			kind: "rect";
			cx: number;
			cy: number;
			halfWidth: number;
			halfHeight: number;
	  }
	| { kind: "circle"; cx: number; cy: number; radius: number }
	| ({ kind: "line" } & BeamGeom)
	| {
			kind: "polygon";
			/** Placed vertices plus the current cursor position as the last one. */
			points: Vec2[];
			/** The first vertex (the close-click target / dot the renderer draws). */
			first: Vec2;
			/**
			 * The click-to-close hitbox radius in world units — the renderer
			 * draws the first-vertex ring at exactly this radius.
			 */
			closeRadius: number;
			closable: boolean;
	  }
	| { kind: "stroke"; points: readonly Vec2[] }
	| { kind: "text"; x: number; y: number; text: string }
	/** Joint tool arming: first anchor to the cursor; `toBody` highlights a valid second endpoint. */
	| {
			kind: "joint";
			from: Vec2;
			to: Vec2;
			toBody: boolean;
			/**
			 * Pulley third-click phase: both anchors are fixed and this is the
			 * wheel point under the cursor — the preview draws the rope path
			 * from→wheel→to instead of the single attach line.
			 */
			wheel?: Vec2;
	  }
	/**
	 * Snap tool arming: the mover's center to the cursor; `toBody` marks a
	 * valid snap target under the cursor (dashed ring when empty space).
	 */
	| { kind: "snap"; from: Vec2; to: Vec2; toBody: boolean }
	/** Thruster drag-to-aim: the mount arrow pivots toward the cursor. */
	| { kind: "thruster-aim"; x: number; y: number; angle: number };

/** Beam centered on the segment midpoint, oriented along it, min length clamped. */
export function beamFromSegment(
	ax: number,
	ay: number,
	bx: number,
	by: number,
): BeamGeom {
	return {
		cx: (ax + bx) / 2,
		cy: (ay + by) / 2,
		rot: Math.atan2(by - ay, bx - ax),
		halfLength: Math.max(Math.hypot(bx - ax, by - ay) / 2, MIN_SPAWN_HALF_SIZE),
		halfWidth: BEAM_HALF_WIDTH,
	};
}

/** One body snapshot for picking and rubber-band selection. */
export interface PickableBody {
	readonly id: string;
	readonly shape: BodyShape;
	readonly x: number;
	readonly y: number;
	readonly rot: number;
}

/**
 * Topmost body containing the world point, or undefined. Bodies are tested
 * last-to-first so later entries (drawn on top, spawned later) win. Circles,
 * boxes, and polygons use exact shape tests; boxes and polygons account for
 * their rotation.
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
		} else if (b.shape.kind === "polygon") {
			const cos = Math.cos(-b.rot);
			const sin = Math.sin(-b.rot);
			const dx = wx - b.x;
			const dy = wy - b.y;
			if (
				pointInPolygon(dx * cos - dy * sin, dx * sin + dy * cos, b.shape.points)
			)
				return b.id;
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

/**
 * ALL bodies containing the point, TOPMOST FIRST (pickBody's order): the
 * joint tool's Shift+click ties the whole stack (Paul, 2026-10-25).
 */
export function pickAllBodies(
	bodies: readonly PickableBody[],
	wx: number,
	wy: number,
): string[] {
	const hits: string[] = [];
	for (let i = bodies.length - 1; i >= 0; i--) {
		const b = bodies[i];
		if (!b) continue;
		if (pickBody([b], wx, wy) !== undefined) hits.push(b.id);
	}
	return hits;
}

/**
 * The `depth`-th body containing the point, TOPMOST FIRST: 0 is the
 * topmost (pickBody's answer), 1 is the body one beneath it — the Alt+click
 * pick for reaching a body hidden behind another (Paul, 2026-10-25). Depth
 * past the last hit clamps to the deepest.
 */
export function pickBodyAtDepth(
	bodies: readonly PickableBody[],
	wx: number,
	wy: number,
	depth: number,
): string | undefined {
	const hits = pickAllBodies(bodies, wx, wy);
	if (hits.length === 0) return undefined;
	const d = Math.max(0, Math.min(Math.floor(depth), hits.length - 1));
	return hits[d];
}

/**
 * Axis-aligned hit box for a label (world units). The label anchors at the
 * left end of its baseline, so the box runs from the anchor rightward and
 * mostly above it (descenders reach a little below). Uses the estimated
 * character width — the DOM-free stand-in for canvas text metrics; the same
 * estimate draws the selection outline, so picking and the outline agree.
 */
export function labelBounds(
	x: number,
	y: number,
	text: string,
	fontSize = LABEL_FONT_SIZE,
	align: LabelTextAlign = "left",
): { x0: number; y0: number; x1: number; y1: number } {
	const width = Math.max(text.length * LABEL_CHAR_WIDTH * fontSize, fontSize);
	// Alignment shifts the box relative to the anchor: left starts at it,
	// center straddles it, right ends at it (the renderer's ctx.textAlign
	// reads the same anchor semantics).
	const x0 =
		align === "left" ? x : align === "center" ? x - width / 2 : x - width;
	return {
		x0,
		y0: y - fontSize * 0.85,
		x1: x0 + width,
		y1: y + fontSize * 0.3,
	};
}

/**
 * Topmost label whose hit box contains the world point, or undefined. Tested
 * last-to-first like pickBody; labels always sit above bodies in the pick
 * order (callers combine `pickLabel(...) ?? pickBody(...)`). `zoom` sizes the
 * hit box to the font the renderer actually draws at that zoom.
 */
export function pickLabel(
	labels: readonly {
		readonly id: string;
		readonly x: number;
		readonly y: number;
		readonly text: string;
		readonly rot?: number;
		readonly size?: number | undefined;
		readonly align?: LabelTextAlign | undefined;
	}[],
	wx: number,
	wy: number,
	zoom = 1,
): string | undefined {
	for (let i = labels.length - 1; i >= 0; i--) {
		const label = labels[i];
		if (!label) continue;
		// A user-set size overrides the zoom-adaptive default (matching the
		// renderer); alignment shifts the box the same way it draws.
		const fontSize = label.size ?? effectiveLabelFontSize(zoom);
		const b = labelBounds(0, 0, label.text, fontSize, label.align ?? "left");
		const angle = -(label.rot ?? 0);
		const dx = wx - label.x;
		const dy = wy - label.y;
		const x = dx * Math.cos(angle) - dy * Math.sin(angle);
		const y = dx * Math.sin(angle) + dy * Math.cos(angle);
		if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1) return label.id;
	}
	return undefined;
}

/**
 * Topmost joint whose glyph pick radius contains the world point, or
 * undefined. Tested last-to-first like pickBody/pickLabel; callers resolve
 * each joint's live world anchor (jointWorldAnchor) and list joints after
 * bodies so a joint glyph wins over the body underneath it. `zoom` sizes the
 * hit radius to the glyph the renderer actually draws at this zoom.
 */
export function pickJoint(
	joints: readonly { id: string; wx: number; wy: number }[],
	wx: number,
	wy: number,
	zoom = 1,
): string | undefined {
	for (let i = joints.length - 1; i >= 0; i--) {
		const j = joints[i];
		if (!j) continue;
		const r = jointPickRadius(zoom);
		const dx = wx - j.wx;
		const dy = wy - j.wy;
		if (dx * dx + dy * dy <= r * r) return j.id;
	}
	return undefined;
}

/**
 * Thruster glyph picking (P4-T5): the same screen-constant radius as a joint
 * glyph (what you see is what you click), topmost-last like joints.
 */
export function pickThruster(
	thrusters: readonly { id: string; wx: number; wy: number }[],
	wx: number,
	wy: number,
	zoom = 1,
): string | undefined {
	return pickJoint(thrusters, wx, wy, zoom);
}

/**
 * Unclamped rectangle from two corners — the rubber-band selection frame (a
 * near-zero click rectangle legitimately selects nothing, unlike draw sizing
 * which clamps to a minimum shape).
 */
export function rubberRect(
	ax: number,
	ay: number,
	bx: number,
	by: number,
): DragRect {
	return {
		cx: (ax + bx) / 2,
		cy: (ay + by) / 2,
		halfWidth: Math.abs(bx - ax) / 2,
		halfHeight: Math.abs(by - ay) / 2,
	};
}

/** Bodies whose centre lies inside the rubber-band rectangle, in pick order. */
export function bodiesInRect(
	bodies: readonly { id: string; x: number; y: number }[],
	rect: DragRect,
): string[] {
	const hits: string[] = [];
	for (const b of bodies) {
		if (
			Math.abs(b.x - rect.cx) <= rect.halfWidth &&
			Math.abs(b.y - rect.cy) <= rect.halfHeight
		) {
			hits.push(b.id);
		}
	}
	return hits;
}

/** Pointer-event modifiers the session cares about (DOM layer extracts them). */
export interface PointerMods {
	/** Shift-held: click toggles membership, rubber-band adds to the selection. */
	readonly shift?: boolean;
	/** R-held with the select tool: a press on the selection rotates it. */
	readonly rotate?: boolean;
	/**
	 * Alt-held with the snap tool: a click picks the body ONE BENEATH the
	 * topmost at that point (stacked bodies — Paul, 2026-10-25).
	 */
	readonly alt?: boolean;
}

/** Events the session emits; the interaction layer forwards them to the world. */
export interface ToolSessionEvents {
	onBeginAction?(): void;
	onCancelAction?(): void;
	labelAt?(id: string): { x: number; y: number; text: string } | undefined;
	/** A drag-to-size shape was committed on release. */
	onSpawnBox(shape: DragRect): void;
	onSpawnCircle(shape: { cx: number; cy: number; radius: number }): void;
	/** A closed polygon was committed: absolute-space vertices, ≥3 points. */
	onSpawnPolygon(points: readonly Vec2[]): void;
	/** A straight beam was committed as rotated thin-box geometry. */
	onSpawnLine(beam: BeamGeom): void;
	/**
	 * A freehand stroke was released: the cleanup/snap decision (primitive
	 * snap, freeform polygon, open-stroke chain, or nothing) to commit.
	 */
	onSpawnFreehand(result: FreehandDecision): void;
	/**
	 * A click with the text tool placed a new label: create the (empty) label
	 * entity and return its id — the session edits it in place until the
	 * inline edit commits.
	 */
	onCreateLabel(pos: { x: number; y: number }): string;
	/**
	 * The inline label edit finished: store `text` on the label. An empty
	 * (all-whitespace) text was already discarded by the session.
	 */
	onCommitLabel(id: string, text: string): void;
	/** A body was grabbed with the select tool; `grab` is the world grab point. */
	onDragStart(id: string, grab: { x: number; y: number }): void;
	onDragMove(target: { x: number; y: number }): void;
	onDragEnd(): void;
	/** A rotate gesture started on the selection (base rotations captured now). */
	onRotateStart(): void;
	/** Rotation delta from the rotate gesture's start angle (cumulative). */
	onRotate(delta: number): void;
	/** The rotate gesture ended (release, cancel, or tool switch). A RELEASE
	 * mid-motion carries the fling estimate (signed rad/s, P3 rotation
	 * momentum); cancellations pass undefined — never fling on cancel. */
	onRotateEnd(angularVelocity?: number): void;
	/** The selection set was deleted; ids are the removed bodies. */
	onDelete(ids: readonly string[]): void;
	/**
	 * Offset copies were created; returns the new ids aligned with `ids`
	 * (undefined when a body could not be duplicated).
	 */
	onDuplicate(ids: readonly string[]): (string | undefined)[];
	/**
	 * The joint tool completed its two-click attach: body `bodyAId` to body
	 * `bodyBId`, or to the world when null. `anchorX/Y` is the arming click
	 * (the first point), `x, y` the placement click (the second). `jointKind`
	 * selects the materialized joint type. Returns the new joint's id so the
	 * session selects it (D19: a joint selects, deletes like any entity), or
	 * undefined when the placement was refused (missing body, unmaterialized
	 * kind). Optional so test doubles and headless harnesses that never place
	 * joints can omit it. `wheelX/Y` carries the pulley's third click (the
	 * fixed wheel point); other kinds omit it.
	 */
	onPlaceJoint?(spec: {
		readonly bodyAId: string;
		readonly bodyBId: string | null;
		readonly jointKind: PlaceableJointKind;
		readonly anchorX: number;
		readonly anchorY: number;
		readonly x: number;
		readonly y: number;
		readonly wheelX?: number;
		readonly wheelY?: number;
	}): string | undefined;
	/**
	 * The thruster tool placed a mount: a single click on body `bodyId` at
	 * the world point `x, y`. Returns the new thruster's id so the session
	 * selects it (panel opens, glyph toggle live), or undefined when the
	 * placement was refused (no body under the click).
	 */
	onPlaceThruster?(spec: {
		readonly bodyId: string;
		readonly x: number;
		readonly y: number;
	}): string | undefined;
	/**
	 * The thruster-aim drag ended: `worldAngle` is the drag direction in
	 * world radians when the drag covered THRUSTER_AIM_MIN_DRAG, or null for
	 * a below-minimum drag / Escape / tool-switch (the thruster keeps its
	 * current angle and the placement's undo snapshot records the mount).
	 * The events layer converts to body-local and records the undo action —
	 * mount + aim land as ONE undo step.
	 */
	onThrusterAim?(spec: {
		readonly id: string;
		readonly worldAngle: number | null;
	}): void;
	/**
	 * Glyph toggle affordance (P4-T3 motor, P4-T5 thruster): a plain
	 * select-tool press landed on the picked entity `id` (no shift, no rotate
	 * modifier). Return true when the press was CONSUMED as a glyph toggle —
	 * the press must not then start a drag or rubber-band. The toggle itself
	 * routes through the ordinary update boundary in the events layer;
	 * selection follows the ordinary select path so the panel opens on the
	 * toggled entity.
	 */
	onMotorGlyphClick?(id: string): boolean;
	/**
	 * P4-T4 rope: a rope stroke was released. `points` are the captured
	 * (shift-snapped) stroke samples; `captureA`/`captureB` are the pick ids
	 * under each endpoint — a live body captures that end by a pin joint,
	 * anything else (empty space, label, …) captures it to the WORLD at the
	 * endpoint point (D18 "bodies/world"). Returns null when the chain was
	 * refused (the D17 bounds — the events layer surfaces the reason visibly).
	 */
	onSpawnRope?(spec: {
		readonly points: readonly Vec2[];
		readonly captureA?: string | undefined;
		readonly captureB?: string | undefined;
	}): {
		readonly segments: readonly string[];
		readonly joints: readonly string[];
	} | null;
	/**
	 * Snap tool's bodies-only depth pick (Alt-click reaches stacked bodies):
	 * resolves against live bodies like {@link pickBodyAtDepth}. Omitted in
	 * tests that don't exercise the snap tool.
	 */
	pickBodyOnly?(wx: number, wy: number, depth?: number): string | undefined;
	/** Live center of a body id, or undefined when culled (snap preview). */
	bodyCenter?(id: string): Vec2 | undefined;
	/**
	 * The picked entity's body shape, or undefined when the id is not a
	 * body (gear/belt placement requires circles — the second-click refusal
	 * needs the shape kind, which the tool session cannot resolve itself).
	 */
	bodyShape?(id: string): BodyShape | undefined;
	/**
	 * A snap gesture completed: teleport `moverId` so its center lands on
	 * `targetId`'s center (the events layer applies world.moveBody and
	 * commits the undo action the arming press opened).
	 */
	onSnapBodies?(spec: {
		readonly moverId: string;
		readonly targetId: string;
	}): void;
	/**
	 * Joint tool's Shift+click: ties EVERY body under the click together —
	 * consecutive pairs of `ids` (topmost first) get `jointKind` joints, all
	 * anchored at the click point, one undo action for the whole chain.
	 * Returns the placed count (0 = refused).
	 */
	onPlaceJointChain?(spec: {
		readonly ids: readonly string[];
		readonly jointKind: PlaceableJointKind;
		readonly x: number;
		readonly y: number;
	}): number;
	/**
	 * Snap-Join mode's completion: teleport `moverId` so its center lands on
	 * `targetId`'s center, then place `jointKind` with both anchors at that
	 * shared center — move + joint as ONE undo action. Returns the joint id
	 * or undefined when refused.
	 */
	onPlaceSnapJoint?(spec: {
		readonly targetId: string;
		readonly moverId: string;
		readonly jointKind: PlaceableJointKind;
		readonly targetPoint: Vec2;
		readonly moverPoint: Vec2;
	}): string | undefined;
	/**
	 * Joint tool's Shift+click support: ALL bodies under the point, topmost
	 * first (see {@link pickAllBodies}).
	 */
	pickAllBodies?(wx: number, wy: number): string[];
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
	| {
			readonly kind: "line-drawing";
			startX: number;
			startY: number;
			curX: number;
			curY: number;
			shift: boolean;
	  }
	| {
			readonly kind: "polygon-place";
			/** Committed vertices so far (the first one closes on re-click). */
			points: Vec2[];
			curX: number;
			curY: number;
	  }
	| { readonly kind: "freehand"; readonly stroke: FreehandStrokeBuilder }
	| {
			readonly kind: "text-editing";
			readonly id: string;
			readonly anchorX: number;
			readonly anchorY: number;
			text: string;
	  }
	| { readonly kind: "dragging"; id: string }
	| {
			readonly kind: "rubberband";
			startX: number;
			startY: number;
			curX: number;
			curY: number;
			additive: boolean;
	  }
	| {
			readonly kind: "rotating";
			startY: number;
			/** Fling estimate (rad/s, signed): EMA of per-move angular velocity. */
			velocity: number;
			lastY: number;
			lastTime: number;
	  }
	| {
			readonly kind: "joint-arming";
			readonly bodyAId: string;
			/** World point of the first click (bodyA's pivot). */
			readonly anchorX: number;
			readonly anchorY: number;
			curX: number;
			curY: number;
	  }
	| {
			/**
			 * Thruster drag-to-aim: the press already mounted the thruster
			 * (angle 0); dragging sets the thrust direction — the preview
			 * tracks the cursor and release converts the WORLD drag angle to
			 * the body-local stored angle via {@link aimAngleLocal}. A drag
			 * below THRUSTER_AIM_MIN_DRAG commits null (keeps 0).
			 */
			readonly kind: "thruster-aim";
			readonly id: string;
			/** Mount point (world). */
			readonly anchorX: number;
			readonly anchorY: number;
			/** Current drag point (world). */
			aimX: number;
			aimY: number;
	  }
	| {
			/**
			 * Pulley third-click phase (post-MVP): two bodies armed, the next
			 * click anywhere sets the fixed wheel point. The B anchor is the
			 * already-taken second click, carried here so the wheel click does
			 * not displace it.
			 */
			readonly kind: "joint-wheel";
			readonly bodyAId: string;
			readonly bodyBId: string;
			readonly anchorX: number;
			readonly anchorY: number;
			readonly anchorBX: number;
			readonly anchorBY: number;
			curX: number;
			curY: number;
	  }
	| {
			/**
			 * Snap tool: the mover body is picked, the next body pick snaps it
			 * onto that body's center. `cycleDepth` remembers how deep the
			 * Alt+click cycle went for the mover pick so a repeat Alt+click at
			 * the same spot re-picks one deeper instead of completing.
			 */
			readonly kind: "snap-arming";
			readonly moverId: string;
			/** Where the mover-pick click landed (preview fallback). */
			readonly pickX: number;
			readonly pickY: number;
			readonly cycleDepth: number;
			curX: number;
			curY: number;
	  }
	| {
			/**
			 * Rope placement (P4-T4, D18): a freehand stroke drawn while the
			 * joint tool's rope kind is active; the release converts it to a
			 * segment chain. Shift angle-snaps each new sample to
			 * horizontal/vertical/45° from the LAST captured point (line-run
			 * pattern via {@link constrainSegment}).
			 */
			readonly kind: "rope-draw";
			readonly stroke: FreehandStrokeBuilder;
	  };

/**
 * Tool state machine. Feed it world-space pointer events; it emits spawn,
 * drag, rotate, delete, and duplicate commands. `pick` resolves hover and
 * press against the live body list; `pickRect` resolves rubber-band
 * selection against it (defaults to selecting nothing).
 */
export class ToolSession {
	tool: ToolId = "select";
	/**
	 * Static mode: while on, box/circle/polygon/line/freehand spawns are
	 * committed with `isStatic: true` (terrain — infinite mass). A spawn
	 * property, not a tool, so it composes with any draw tool.
	 */
	staticMode = false;
	/**
	 * Draw options (header toggles/field, wired in draw-options.ts): grid snap
	 * snaps box/circle/polygon/line pointer samples to the grid spacing;
	 * from-center anchors circles at the press point; constrain-square forces
	 * box drags square; angle snap quantizes the rotate gesture to 15° steps
	 * (and suppresses the release fling, which would immediately break the
	 * snap).
	 */
	gridSnap = false;
	gridSize = DEFAULT_GRID_SIZE;
	circleFromCenter = false;
	constrainBox = false;
	angleSnap = false;

	/** Pointer sample for the point-based draw tools, snapped when Snap is on. */
	private snapPoint(wx: number, wy: number): { x: number; y: number } {
		if (!this.gridSnap || this.gridSize <= 0) return { x: wx, y: wy };
		return {
			x: snapToGrid(wx, this.gridSize),
			y: snapToGrid(wy, this.gridSize),
		};
	}
	/**
	 * The joint tool's active placement kind (P4-T2; motor joins in P4-T3):
	 * the segmented picker in the tool rail sets it; placement derives params
	 * from it via {@link makePlacedJoint}. Default pin (the T1 behavior).
	 */
	jointKind: PlaceableJointKind = "pin";

	/**
	 * Snap-Join mode (Paul, 2026-10-25): the joint tool's FIRST click IS the
	 * target location; the second click's body teleports so its clicked
	 * point lands on it, and the joint applies at that shared point. Center
	 * clicks make this center-to-center (the requested example). Move +
	 * joint = one undo action. Rope and pulley kinds ignore the mode
	 * (stroke / third-click flows).
	 */
	snapJoin = false;

	/**
	 * Set the placement kind from the tool rail. Changing kind mid-gesture
	 * cancels the gesture outright (the setTool teardown): an armed pulley
	 * must not leak its two taken clicks into a different kind's placement.
	 * With nothing in progress this is a plain field set — the selection and
	 * any idle state are untouched.
	 */
	setJointKind(kind: PlaceableJointKind): void {
		if (kind === this.jointKind) return;
		if (this.phase.kind !== "idle") this.cancel();
		this.jointKind = kind;
	}
	/**
	 * Body under the pointer (hover). Invariant: pointerMove keeps this
	 * tracking the pointer-picked body in every phase — placement flows
	 * included, so the center helper marks the joint/rope anchor candidate —
	 * except while rotating or dragging, where the pressed body stays the
	 * hover target and moves over other bodies must not steal it.
	 */
	hoverId: string | undefined;
	/** Currently selected bodies, in no particular order. */
	selectedIds: Set<string> = new Set();

	private phase: Phase = { kind: "idle" };
	/** Last pointer-event zoom (interaction.ts passes it); sizes screen-constant hitboxes. */
	private lastZoom = 1;

	constructor(
		private readonly events: ToolSessionEvents,
		private readonly pick: (wx: number, wy: number) => string | undefined,
		private readonly pickRect?: (rect: DragRect) => readonly string[],
		/** Monotonic clock in ms (injected: the fling estimate is pure). */
		private readonly now: () => number = () => performance.now(),
	) {}

	/** Box/circle geometry for the current drag, honoring the option toggles. */
	private boxCircleGeom(
		ax: number,
		ay: number,
		bx: number,
		by: number,
	):
		| {
				kind: "rect";
				cx: number;
				cy: number;
				halfWidth: number;
				halfHeight: number;
		  }
		| { kind: "circle"; cx: number; cy: number; radius: number } {
		if (this.tool === "box") {
			return {
				kind: "rect",
				...rectFromDrag(ax, ay, bx, by, this.constrainBox),
			};
		}
		const circle = this.circleFromCenter
			? circleFromCenterDrag(ax, ay, bx, by)
			: circleFromDrag(ax, ay, bx, by);
		return { kind: "circle", ...circle };
	}

	/** The in-progress drawing preview geometry, or null when not drawing. */
	preview(): DrawPreview | null {
		if (this.phase.kind === "drawing") {
			return this.boxCircleGeom(
				this.phase.startX,
				this.phase.startY,
				this.phase.curX,
				this.phase.curY,
			);
		}
		if (this.phase.kind === "line-drawing") {
			return {
				kind: "line",
				...this.lineGeom(
					this.phase.startX,
					this.phase.startY,
					this.phase.curX,
					this.phase.curY,
					this.phase.shift,
				),
			};
		}
		if (this.phase.kind === "freehand") {
			return { kind: "stroke", points: this.phase.stroke.points };
		}
		if (this.phase.kind === "polygon-place") {
			const first = this.phase.points[0] as Vec2;
			const points = [
				...this.phase.points,
				{ x: this.phase.curX, y: this.phase.curY },
			];
			const dx = this.phase.curX - first.x;
			const dy = this.phase.curY - first.y;
			return {
				kind: "polygon",
				points,
				first,
				closeRadius: this.polygonCloseRadius(),
				closable:
					this.phase.points.length >= 3 &&
					dx * dx + dy * dy <=
						this.polygonCloseRadius() * this.polygonCloseRadius(),
			};
		}
		if (this.phase.kind === "text-editing") {
			return {
				kind: "text",
				x: this.phase.anchorX,
				y: this.phase.anchorY,
				text: this.phase.text,
			};
		}
		if (this.phase.kind === "joint-arming") {
			return {
				kind: "joint",
				from: { x: this.phase.anchorX, y: this.phase.anchorY },
				to: { x: this.phase.curX, y: this.phase.curY },
				toBody: this.pick(this.phase.curX, this.phase.curY) !== undefined,
			};
		}
		if (this.phase.kind === "joint-wheel") {
			// Rope preview: both anchors fixed, the wheel follows the cursor.
			return {
				kind: "joint",
				from: { x: this.phase.anchorX, y: this.phase.anchorY },
				to: { x: this.phase.anchorBX, y: this.phase.anchorBY },
				toBody: true,
				wheel: { x: this.phase.curX, y: this.phase.curY },
			};
		}
		if (this.phase.kind === "snap-arming") {
			// Mover center → cursor; the ring at the cursor marks a valid
			// target (dashed when no body is under it).
			const center = this.events.bodyCenter?.(this.phase.moverId) ?? {
				x: this.phase.pickX,
				y: this.phase.pickY,
			};
			const cursorHit = this.events.pickBodyOnly?.(
				this.phase.curX,
				this.phase.curY,
			);
			return {
				kind: "snap",
				from: center,
				to: { x: this.phase.curX, y: this.phase.curY },
				toBody: cursorHit !== undefined && cursorHit !== this.phase.moverId,
			};
		}
		if (this.phase.kind === "thruster-aim") {
			const dx = this.phase.aimX - this.phase.anchorX;
			const dy = this.phase.aimY - this.phase.anchorY;
			if (Math.hypot(dx, dy) < 2) return null;
			return {
				kind: "thruster-aim",
				x: this.phase.anchorX,
				y: this.phase.anchorY,
				angle: Math.atan2(dy, dx),
			};
		}
		if (this.phase.kind === "rope-draw") {
			return { kind: "stroke", points: this.phase.stroke.points };
		}
		return null;
	}

	/** Shift-constrained beam geometry for the line tool's current segment. */
	private lineGeom(
		ax: number,
		ay: number,
		bx: number,
		by: number,
		shift: boolean,
	): BeamGeom {
		const end = shift ? constrainSegment(ax, ay, bx, by) : { x: bx, y: by };
		return beamFromSegment(ax, ay, end.x, end.y);
	}

	/** Commit a beam (drag release or the second click of the two-click flow). */
	private spawnLine(
		ax: number,
		ay: number,
		bx: number,
		by: number,
		shift: boolean,
	): void {
		this.events.onSpawnLine(this.lineGeom(ax, ay, bx, by, shift));
	}

	/** The in-progress rubber-band rectangle, or null when not rubber-banding. */
	rubberBand(): DragRect | null {
		if (this.phase.kind !== "rubberband") return null;
		return rubberRect(
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
		// the switch is a no-op. The selection survives a tool switch — it is
		// the edit target, not part of the gesture. An in-progress label edit
		// commits instead: typed text is not a gesture to discard.
		if (this.phase.kind === "dragging") this.events.onDragEnd();
		if (this.phase.kind === "rotating") this.events.onRotateEnd();
		if (this.phase.kind === "text-editing") this.commitText();
		if (this.phase.kind === "thruster-aim") {
			// The mount is KEPT: commit the aim as-is (null keeps the placed
			// angle) inside the same undo step, never a snapshot drop — the
			// thruster already exists in the world.
			this.events.onThrusterAim?.({ id: this.phase.id, worldAngle: null });
			this.phase = { kind: "idle" };
			this.tool = tool;
			return;
		}
		this.events.onCancelAction?.();
		this.phase = { kind: "idle" };
		this.tool = tool;
	}

	/**
	 * Cancel drawing/drag/rotate; Escape with nothing in progress clears
	 * selection. An in-progress label edit commits (Escape commits per the
	 * text tool's contract); only an all-whitespace label is discarded.
	 */
	cancel(): void {
		if (this.phase.kind === "dragging") this.events.onDragEnd();
		if (this.phase.kind === "rotating") this.events.onRotateEnd();
		if (this.phase.kind === "text-editing") this.commitText();
		if (this.phase.kind === "thruster-aim") {
			// Mount kept, aim committed as-is (see setTool) — no snapshot drop.
			this.events.onThrusterAim?.({ id: this.phase.id, worldAngle: null });
			this.phase = { kind: "idle" };
			return;
		}
		this.events.onCancelAction?.();
		const wasGesture = this.phase.kind !== "idle";
		this.phase = { kind: "idle" };
		if (!wasGesture) this.selectedIds.clear();
	}

	/**
	 * Close the in-progress polygon (Enter or the close click): false when no
	 * polygon placement is active or it has fewer than three vertices.
	 */
	closePolygon(): boolean {
		if (this.phase.kind !== "polygon-place") return false;
		if (this.phase.points.length < 3) return false;
		const { points } = this.phase;
		this.phase = { kind: "idle" };
		this.events.onSpawnPolygon(points);
		return true;
	}

	/** True while a text-tool inline label edit is in progress. */
	isEditingText(): boolean {
		return this.phase.kind === "text-editing";
	}

	/** Append a printable character to the in-progress label (editing only). */
	editTextKey(key: string): void {
		if (this.phase.kind !== "text-editing") return;
		this.phase = { ...this.phase, text: this.phase.text + key };
	}

	/** Delete the last character of the in-progress label (editing only). */
	editTextBackspace(): void {
		if (this.phase.kind !== "text-editing") return;
		this.phase = { ...this.phase, text: this.phase.text.slice(0, -1) };
	}

	/**
	 * Commit the inline label edit (Enter, Escape, a tool change, any gesture
	 * interruption): false when not editing. An all-whitespace text discards
	 * the label entirely — empty labels never enter the document.
	 */
	commitText(): boolean {
		if (this.phase.kind !== "text-editing") return false;
		const { id, text } = this.phase;
		this.phase = { kind: "idle" };
		if (text.trim() === "") {
			this.events.onDelete([id]);
		} else {
			this.events.onCommitLabel(id, text);
		}
		return true;
	}

	/**
	 * Re-enter the inline label edit on an EXISTING label (double-click with
	 * the select tool): the same phase and commit contract as the text tool's
	 * placement flow, with one undo action opened for the text change. The
	 * edited label becomes the selection so the properties panel follows.
	 */
	beginTextEditing(id: string, x: number, y: number, text: string): void {
		if (this.phase.kind === "dragging") this.events.onDragEnd();
		if (this.phase.kind === "rotating") this.events.onRotateEnd();
		this.events.onBeginAction?.();
		this.selectedIds = new Set([id]);
		this.phase = { kind: "text-editing", id, anchorX: x, anchorY: y, text };
	}

	/** Delete the selection; false when nothing is selected. */ requestDelete(): boolean {
		if (this.selectedIds.size === 0) return false;
		if (this.phase.kind === "dragging" || this.phase.kind === "rotating")
			this.cancel();
		const ids = [...this.selectedIds];
		this.selectedIds.clear();
		this.events.onDelete(ids);
		return true;
	}

	/** Offset-duplicate the selection; the copies become the selection. */
	requestDuplicate(): boolean {
		if (this.selectedIds.size === 0) return false;
		const newIds = this.events.onDuplicate([...this.selectedIds]);
		this.selectedIds = new Set(
			newIds.filter((id): id is string => id !== undefined),
		);
		return true;
	}

	/**
	 * The click-to-close radius in world units at the pointer's zoom: the
	 * 0.75-unit floor, or 12 screen pixels — whichever is larger. Shared by
	 * the close check and the preview so the drawn ring IS the hitbox.
	 */
	private polygonCloseRadius(): number {
		return Math.max(
			POLYGON_CLOSE_RADIUS,
			POLYGON_CLOSE_SCREEN_PX / this.lastZoom,
		);
	}

	pointerDown(
		wx: number,
		wy: number,
		mods: PointerMods = {},
		zoom?: number,
	): void {
		if (zoom !== undefined) this.lastZoom = zoom;
		// A click during an in-progress label edit commits that label first
		// (the click itself is not consumed — with the text tool it starts the
		// next label, with any other tool it draws/selects).
		if (this.phase.kind === "text-editing") this.commitText();
		if (this.phase.kind === "line-drawing") {
			// Two-click mode: this press is the segment's far end → commit.
			const { startX, startY, shift } = this.phase;
			const snapped = this.snapPoint(wx, wy);
			this.phase = { kind: "idle" };
			this.spawnLine(
				startX,
				startY,
				snapped.x,
				snapped.y,
				shift || mods.shift === true,
			);
			return;
		}
		if (this.phase.kind === "joint-arming") {
			// Second click: a body becomes bodyB; empty space anchors to the
			// world (pin-to-world). The joint is placed AT the second click.
			// Clicking bodyA again aborts the arming (a self-joint is refused).
			const { bodyAId, anchorX, anchorY } = this.phase;
			if (this.jointKind === "pulley") {
				// Pulley needs TWO bodies: a second click on empty space or on
				// bodyA itself aborts the arming; a body enters the wheel
				// (third-click) phase. Every abort drops the snapshot the
				// arming press took (onCancelAction) so a later placement's
				// commit cannot inherit it and undo would rewind past it.
				this.phase = { kind: "idle" };
				const hitId = this.pick(wx, wy);
				if (!hitId || hitId === bodyAId) {
					this.events.onCancelAction?.();
					return;
				}
				this.phase = {
					kind: "joint-wheel",
					bodyAId,
					bodyBId: hitId,
					anchorX,
					anchorY,
					anchorBX: wx,
					anchorBY: wy,
					curX: wx,
					curY: wy,
				};
				return;
			}
			this.phase = { kind: "idle" };
			// Snap-Join mode: the second body TELEPORTS so its clicked point
			// lands on the first click's point (center clicks = the doc
			// example), then the joint applies at that shared point — move +
			// joint as one undo action (Paul, 2026-10-25).
			const angularDrive =
				this.jointKind === "gear" || this.jointKind === "belt";
			const snapTarget = angularDrive
				? this.events.pickBodyOnly?.(wx, wy)
				: this.pick(wx, wy);
			if (angularDrive) {
				if (
					!snapTarget ||
					snapTarget === bodyAId ||
					this.events.bodyShape?.(snapTarget)?.kind !== "circle"
				) {
					showNotice(
						"Gear and belt joints connect two distinct circles",
						"error",
					);
					this.events.onCancelAction?.();
					return;
				}
				const jointId = this.events.onPlaceJoint?.({
					bodyAId,
					bodyBId: snapTarget,
					jointKind: this.jointKind,
					anchorX,
					anchorY,
					x: wx,
					y: wy,
				});
				if (jointId) this.selectedIds = new Set([jointId]);
				return;
			}
			if (this.snapJoin && snapTarget) {
				if (snapTarget === bodyAId) {
					this.events.onCancelAction?.();
					return;
				}
				const jointId = this.events.onPlaceSnapJoint?.({
					targetId: bodyAId,
					moverId: snapTarget,
					jointKind: this.jointKind,
					targetPoint: { x: anchorX, y: anchorY },
					moverPoint: { x: wx, y: wy },
				});
				if (jointId) this.selectedIds = new Set([jointId]);
				return;
			}
			// Shift+click ties bodyA plus every body under the click — chain
			// of joints at the click point, one undo action.
			if (mods.shift === true && this.jointKind !== "rope") {
				const stack = this.events.pickAllBodies?.(wx, wy) ?? [];
				if (stack.length > 0) {
					this.events.onPlaceJointChain?.({
						ids: [bodyAId, ...stack.filter((id) => id !== bodyAId)],
						jointKind: this.jointKind,
						x: wx,
						y: wy,
					});
					return;
				}
				this.events.onCancelAction?.();
				return;
			}
			const hitId = snapTarget;
			if (hitId === bodyAId) {
				// Self-joint abort (see the pulley comment): drop the snapshot.
				this.events.onCancelAction?.();
				return;
			}
			const jointId = this.events.onPlaceJoint?.({
				bodyAId,
				bodyBId: hitId ?? null,
				jointKind: this.jointKind,
				anchorX,
				anchorY,
				x: wx,
				y: wy,
			});
			if (jointId) this.selectedIds = new Set([jointId]);
			return;
		}
		if (this.phase.kind === "joint-wheel") {
			// Third click: the fixed wheel point, anywhere (the wheel is a
			// scene attachment, not a body pick).
			const p = this.phase;
			this.phase = { kind: "idle" };
			const jointId = this.events.onPlaceJoint?.({
				bodyAId: p.bodyAId,
				bodyBId: p.bodyBId,
				jointKind: this.jointKind,
				anchorX: p.anchorX,
				anchorY: p.anchorY,
				x: p.anchorBX,
				y: p.anchorBY,
				wheelX: wx,
				wheelY: wy,
			});
			if (jointId) this.selectedIds = new Set([jointId]);
			return;
		}
		if (this.phase.kind === "snap-arming") {
			const p = this.phase;
			// Alt+click near the mover pick RE-PICKS the mover one deeper (the
			// cycle continues); any other click is the snap target. The mover
			// cycle reuses the arming snapshot — no new beginAction, since the
			// gesture has not completed yet.
			const nearPick =
				Math.hypot(wx - p.pickX, wy - p.pickY) < 8 / this.lastZoom;
			if (mods.alt === true && nearPick) {
				const deeper = this.events.pickBodyOnly?.(wx, wy, p.cycleDepth + 1);
				if (deeper && deeper !== p.moverId) {
					this.phase = {
						...p,
						moverId: deeper,
						cycleDepth: p.cycleDepth + 1,
						curX: wx,
						curY: wy,
					};
				}
				return;
			}
			this.phase = { kind: "idle" };
			const targetId = this.events.pickBodyOnly?.(
				wx,
				wy,
				mods.alt === true ? 1 : 0,
			);
			if (!targetId || targetId === p.moverId) {
				// Missing target or the mover itself: abort and drop the arming
				// snapshot (the pulley-abort convention).
				this.events.onCancelAction?.();
				return;
			}
			this.events.onSnapBodies?.({ moverId: p.moverId, targetId });
			return;
		}
		if (this.phase.kind === "polygon-place") {
			const first = this.phase.points[0] as Vec2;
			const snapped = this.snapPoint(wx, wy);
			const dx = snapped.x - first.x;
			const dy = snapped.y - first.y;
			if (
				this.phase.points.length >= 3 &&
				dx * dx + dy * dy <=
					this.polygonCloseRadius() * this.polygonCloseRadius()
			) {
				this.closePolygon();
				return;
			}
			this.phase = {
				...this.phase,
				points: [...this.phase.points, { x: snapped.x, y: snapped.y }],
				curX: snapped.x,
				curY: snapped.y,
			};
			return;
		}
		if (this.phase.kind !== "idle") return;
		if (this.tool !== "select") this.events.onBeginAction?.();
		if (this.tool === "joint") {
			// Rope placement (P4-T4): a freehand stroke, not a two-click attach —
			// the release converts the stroke into a segment chain (D18).
			if (this.jointKind === "rope") {
				const stroke = new FreehandStrokeBuilder();
				stroke.add(wx, wy);
				this.phase = { kind: "rope-draw", stroke };
				return;
			}
			// Shift+click ties the WHOLE stack under the click immediately —
			// consecutive pairs get the joint at the click point (Paul,
			// 2026-10-25). One or zero bodies falls through to the normal arm.
			if (
				mods.shift === true &&
				this.jointKind !== "pulley" &&
				this.jointKind !== "gear" &&
				this.jointKind !== "belt"
			) {
				const stack = this.events.pickAllBodies?.(wx, wy) ?? [];
				if (stack.length >= 2) {
					this.events.onPlaceJointChain?.({
						ids: stack,
						jointKind: this.jointKind,
						x: wx,
						y: wy,
					});
					return;
				}
			}
			const angularDrive =
				this.jointKind === "gear" || this.jointKind === "belt";
			const hitId = angularDrive
				? this.events.pickBodyOnly?.(wx, wy)
				: this.pick(wx, wy);
			if (
				angularDrive &&
				(!hitId || this.events.bodyShape?.(hitId)?.kind !== "circle")
			) {
				showNotice("Gear and belt joints connect two circles", "error");
				this.events.onCancelAction?.();
				return;
			}
			if (!hitId) {
				// No body under the first click: no gesture started, so drop the
				// generic beginAction snapshot this tool's press already took.
				this.events.onCancelAction?.();
				return;
			}
			this.phase = {
				kind: "joint-arming",
				bodyAId: hitId,
				anchorX: wx,
				anchorY: wy,
				curX: wx,
				curY: wy,
			};
			return;
		}
		if (this.tool === "snap") {
			// Arm: the picked body is the mover; the next body click snaps it
			// onto that body's center. Alt+click picks one beneath the topmost
			// (stacked bodies); depth remembers for a repeat Alt+click cycle.
			const depth = mods.alt === true ? 1 : 0;
			const hitId = this.events.pickBodyOnly?.(wx, wy, depth);
			if (!hitId) {
				// No body: no gesture started — drop the generic beginAction
				// snapshot this tool's press already took.
				this.events.onCancelAction?.();
				return;
			}
			this.phase = {
				kind: "snap-arming",
				moverId: hitId,
				pickX: wx,
				pickY: wy,
				cycleDepth: depth,
				curX: wx,
				curY: wy,
			};
			return;
		}
		if (this.tool === "thruster") {
			// Press mounts the thruster at the click point (empty space refuses
			// — nothing to push against), then the DRAG aims it: the phase
			// tracks the cursor and pointerUp converts the drag to the
			// body-local angle. The undo action recorded by the events layer
			// at aim time covers mount + aim as one step.
			const hitId = this.pick(wx, wy);
			if (!hitId) {
				this.events.onCancelAction?.();
				return;
			}
			const thrusterId = this.events.onPlaceThruster?.({
				bodyId: hitId,
				x: wx,
				y: wy,
			});
			if (!thrusterId) return;
			this.selectedIds = new Set([thrusterId]);
			this.phase = {
				kind: "thruster-aim",
				id: thrusterId,
				anchorX: wx,
				anchorY: wy,
				aimX: wx,
				aimY: wy,
			};
			return;
		}
		if (this.tool === "line") {
			const snapped = this.snapPoint(wx, wy);
			this.phase = {
				kind: "line-drawing",
				startX: snapped.x,
				startY: snapped.y,
				curX: snapped.x,
				curY: snapped.y,
				shift: mods.shift === true,
			};
			return;
		}
		if (this.tool === "polygon") {
			const snapped = this.snapPoint(wx, wy);
			this.phase = {
				kind: "polygon-place",
				points: [{ x: snapped.x, y: snapped.y }],
				curX: snapped.x,
				curY: snapped.y,
			};
			return;
		}
		if (this.tool === "freehand") {
			const stroke = new FreehandStrokeBuilder();
			stroke.add(wx, wy);
			this.phase = { kind: "freehand", stroke };
			return;
		}
		if (this.tool === "text") {
			this.events.onBeginAction?.();
			const hit = this.pick(wx, wy);
			const label = hit ? this.events.labelAt?.(hit) : undefined;
			const id =
				label && hit ? hit : this.events.onCreateLabel({ x: wx, y: wy });
			this.phase = {
				kind: "text-editing",
				id,
				anchorX: label?.x ?? wx,
				anchorY: label?.y ?? wy,
				text: label?.text ?? "",
			};
			return;
		}
		if (this.tool !== "select") {
			const snapped = this.snapPoint(wx, wy);
			this.phase = {
				kind: "drawing",
				startX: snapped.x,
				startY: snapped.y,
				curX: snapped.x,
				curY: snapped.y,
			};
			return;
		}
		const hit = this.pick(wx, wy);
		if (hit && mods.rotate) {
			// R-drag rotates the selection; an unselected body joins it first.
			if (!this.selectedIds.has(hit)) this.selectedIds = new Set([hit]);
			this.phase = {
				kind: "rotating",
				startY: wy,
				velocity: 0,
				lastY: wy,
				lastTime: this.now(),
			};
			this.events.onRotateStart();
			return;
		}
		if (hit && mods.shift) {
			// Shift-click toggles membership, either direction, and never starts
			// a drag — the selected set is moved by a plain press on a member.
			if (this.selectedIds.has(hit)) {
				this.selectedIds.delete(hit);
			} else {
				this.selectedIds.add(hit);
			}
			return;
		} else if (hit) {
			if (!this.selectedIds.has(hit)) this.selectedIds = new Set([hit]);
			// Motor/thruster glyph affordance (P4-T3/P4-T5): a consumed press
			// toggled a glyph's on/off state; it takes no drag phase (joints
			// and thrusters are not draggable).
			if (this.events.onMotorGlyphClick?.(hit)) {
				this.phase = { kind: "idle" };
				return;
			}
		} else {
			// Empty space: rubber-band (additive under shift), not deselect yet —
			// a zero-size band (plain click) deselects on release.
			this.phase = {
				kind: "rubberband",
				startX: wx,
				startY: wy,
				curX: wx,
				curY: wy,
				additive: mods.shift === true,
			};
			return;
		}
		this.phase = { kind: "dragging", id: hit };
		this.events.onDragStart(hit, { x: wx, y: wy });
	}

	pointerMove(
		wx: number,
		wy: number,
		mods: { shift?: boolean } = {},
		zoom?: number,
	): void {
		if (zoom !== undefined) this.lastZoom = zoom;
		// Hover tracking runs before the per-phase dispatch: only an active
		// rotate or drag pins the hover to the pressed body (see hoverId).
		if (this.phase.kind !== "rotating" && this.phase.kind !== "dragging") {
			this.hoverId = this.pick(wx, wy);
		}
		if (this.phase.kind === "drawing") {
			const snapped = this.snapPoint(wx, wy);
			this.phase = { ...this.phase, curX: snapped.x, curY: snapped.y };
			return;
		}
		if (this.phase.kind === "line-drawing") {
			const snapped = this.snapPoint(wx, wy);
			this.phase = {
				...this.phase,
				curX: snapped.x,
				curY: snapped.y,
				shift: mods.shift ?? this.phase.shift,
			};
			return;
		}
		if (this.phase.kind === "polygon-place") {
			const snapped = this.snapPoint(wx, wy);
			this.phase = { ...this.phase, curX: snapped.x, curY: snapped.y };
			return;
		}
		if (this.phase.kind === "freehand") {
			this.phase.stroke.add(wx, wy);
			return;
		}
		if (this.phase.kind === "rubberband") {
			this.phase = { ...this.phase, curX: wx, curY: wy };
			return;
		}
		if (this.phase.kind === "thruster-aim") {
			this.phase = { ...this.phase, aimX: wx, aimY: wy };
			return;
		}
		if (
			this.phase.kind === "joint-arming" ||
			this.phase.kind === "joint-wheel" ||
			this.phase.kind === "snap-arming"
		) {
			this.phase = { ...this.phase, curX: wx, curY: wy };
			return;
		}
		if (this.phase.kind === "rope-draw") {
			// Shift angle-snaps the new sample to horizontal/vertical/45° from
			// the LAST captured point (line-run pattern); plain moves append.
			const last =
				this.phase.stroke.points[this.phase.stroke.points.length - 1];
			if (mods.shift && last) {
				const snapped = constrainSegment(last.x, last.y, wx, wy);
				this.phase.stroke.add(snapped.x, snapped.y);
			} else {
				this.phase.stroke.add(wx, wy);
			}
			return;
		}
		if (this.phase.kind === "rotating") {
			// Fling estimate (P3 rotation momentum): the LAST move's angular
			// velocity; staleness is judged at release, so a hesitation before
			// lifting never flings.
			const t = this.now();
			const dt = (t - this.phase.lastTime) / 1000;
			if (dt > 1e-4) {
				this.phase.velocity =
					((wy - this.phase.lastY) * ROTATE_RADIANS_PER_UNIT) / dt;
				this.phase.lastY = wy;
				this.phase.lastTime = t;
			}
			this.events.onRotate(angleFromVerticalDrag(this.phase.startY, wy));
			return;
		}
		if (this.phase.kind === "dragging") {
			this.events.onDragMove({ x: wx, y: wy });
			return;
		}
	}

	pointerUp(zoom?: number): void {
		if (zoom !== undefined) this.lastZoom = zoom;
		if (this.phase.kind === "thruster-aim") {
			const { id, anchorX, anchorY, aimX, aimY } = this.phase;
			this.phase = { kind: "idle" };
			const dx = aimX - anchorX;
			const dy = aimY - anchorY;
			this.events.onThrusterAim?.({
				id,
				worldAngle:
					Math.hypot(dx, dy) >= THRUSTER_AIM_MIN_DRAG
						? Math.atan2(dy, dx)
						: null,
			});
			return;
		}
		if (this.phase.kind === "rope-draw") {
			const points = this.phase.stroke.points;
			this.phase = { kind: "idle" };
			if (points.length < 2) {
				// A click without a stroke: no chain to place — drop the gesture
				// snapshot the press took.
				this.events.onCancelAction?.();
				return;
			}
			const first = points[0] as Vec2;
			const last = points[points.length - 1] as Vec2;
			this.events.onSpawnRope?.({
				points,
				captureA: this.pick(first.x, first.y),
				captureB: this.pick(last.x, last.y),
			});
			return;
		}
		if (this.phase.kind === "freehand") {
			const decision = decideFreehand(this.phase.stroke.points);
			this.phase = { kind: "idle" };
			if (decision.kind !== "none") this.events.onSpawnFreehand(decision);
			else this.events.onCancelAction?.();
			return;
		}
		if (this.phase.kind === "line-drawing") {
			const { startX, startY, curX, curY, shift } = this.phase;
			// A real drag commits on release; a near-stationary release leaves
			// the tool armed for the two-click flow's second press.
			if (Math.hypot(curX - startX, curY - startY) > SEGMENT_CLICK_EPSILON) {
				this.phase = { kind: "idle" };
				this.spawnLine(startX, startY, curX, curY, shift);
			}
			return;
		}
		if (this.phase.kind === "drawing") {
			const { startX, startY, curX, curY } = this.phase;
			this.phase = { kind: "idle" };
			const geom = this.boxCircleGeom(startX, startY, curX, curY);
			// Emit the bare payload the events expect (no discriminator kind).
			if (geom.kind === "rect")
				this.events.onSpawnBox({
					cx: geom.cx,
					cy: geom.cy,
					halfWidth: geom.halfWidth,
					halfHeight: geom.halfHeight,
				});
			else
				this.events.onSpawnCircle({
					cx: geom.cx,
					cy: geom.cy,
					radius: geom.radius,
				});
			return;
		}
		if (this.phase.kind === "rubberband") {
			const { startX, startY, curX, curY, additive } = this.phase;
			this.phase = { kind: "idle" };
			const rect = rubberRect(startX, startY, curX, curY);
			const hits = this.pickRect?.(rect) ?? [];
			this.selectedIds = additive
				? new Set([...this.selectedIds, ...hits])
				: new Set(hits);
			return;
		}
		if (this.phase.kind === "rotating") {
			// A release more than ROTATE_FLING_STALE_S after the last motion is
			// a deliberate stop; only a genuine mid-motion release flings.
			const stale = (this.now() - this.phase.lastTime) / 1000;
			const { velocity } = this.phase;
			this.phase = { kind: "idle" };
			this.events.onRotateEnd(
				stale <= ROTATE_FLING_STALE_S &&
					Math.abs(velocity) >= ROTATE_FLING_MIN_RAD_S
					? velocity
					: undefined,
			);
			return;
		}
		if (this.phase.kind === "dragging") {
			this.phase = { kind: "idle" };
			this.events.onDragEnd();
		}
	}
}
