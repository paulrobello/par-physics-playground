/**
 * App entry point: boots the Canvas2D renderer, the Rapier world, and the
 * fixed-step clock that advances it from the rAF frame flow.
 */
import "./style.css";
import { debugEnabled } from "./debug";
import { Camera } from "./lib/camera";
import { attachCameraControls } from "./lib/camera-controls";
import { SimClock } from "./lib/clock";
import { installDebugApi } from "./lib/debug-api";
import {
	attachToolControls,
	CURSOR_DRAW,
	createToolEvents,
} from "./lib/interaction";
import { attachSimControls } from "./lib/sim-controls";
import {
	bodiesInRect,
	type PickableBody,
	pickBody,
	pickLabel,
	ToolSession,
} from "./lib/tools";
import { UndoStack } from "./lib/undo";
import { type BodyShape, PhysicsWorld } from "./lib/world";
import { createRenderer } from "./renderer";

const stage = document.querySelector<HTMLCanvasElement>("#stage");
if (!stage) throw new Error("#stage canvas missing from index.html");
// tsgo does not carry const narrowing into closures; alias with an explicit type.
const canvas: HTMLCanvasElement = stage;

/** Debug mode freezes the real-time feed; `advanceTime` drives the sim deterministically. */
let clock: SimClock | null = null;
/** Live physics world, built asynchronously at boot. */
let world: PhysicsWorld | null = null;
/** Tool state machine; built with the world. */
let session: ToolSession | null = null;

/** Collects a pickable snapshot list for pickBody (pointer events only, not per frame). */
function listPickableBodies(): PickableBody[] {
	const w = world;
	if (!w) return [];
	const list: PickableBody[] = [];
	for (const [id, body] of w.bodies) {
		const entity = w.doc.get(id);
		const shape = entity?.kind === "body" ? entity.shape : undefined;
		if (entity && shape)
			list.push({
				id,
				shape,
				x: body.translation().x,
				y: body.translation().y,
				rot: body.rotation(),
			});
	}
	return list;
}

/** Labels in pick order (topmost last, matching the document ordering). */
function listPickableLabels(): {
	id: string;
	x: number;
	y: number;
	text: string;
	rot: number;
}[] {
	const w = world;
	if (!w) return [];
	return w.labels().map((label) => ({
		id: label.id,
		x: label.x,
		y: label.y,
		text: label.text,
		rot: label.rot,
	}));
}

const sceneView = {
	forEachBody(
		fn: (
			id: string,
			shape: BodyShape,
			x: number,
			y: number,
			rot: number,
			isStatic: boolean,
		) => void,
	): void {
		const w = world;
		if (!w) return;
		for (const [id, body] of w.bodies) {
			const entity = w.doc.get(id);
			if (entity?.kind !== "body") continue;
			fn(
				id,
				entity.shape,
				body.translation().x,
				body.translation().y,
				body.rotation(),
				entity.isStatic,
			);
		}
	},
	forEachLabel(
		fn: (id: string, x: number, y: number, rot: number, text: string) => void,
	): void {
		const w = world;
		if (!w) return;
		for (const label of w.labels())
			fn(label.id, label.x, label.y, label.rot, label.text);
	},
	preview() {
		return session?.preview() ?? null;
	},
	rubberBand() {
		return session?.rubberBand() ?? null;
	},
	hoverId() {
		return session?.hoverId;
	},
	selectedIds() {
		return session ? [...session.selectedIds] : [];
	},
};

const camera = new Camera();

const renderer = createRenderer(canvas, {
	camera,
	scene: sceneView,
	onFrame: (dtSeconds) => {
		clock?.advanceRealTime(dtSeconds);
	},
});
attachCameraControls(
	canvas,
	camera,
	() => (session?.tool === "select" ? "" : CURSOR_DRAW),
	() => session?.isEditingText() ?? false,
);

function fit(): void {
	const rect = canvas.getBoundingClientRect();
	renderer.resize(rect.width, rect.height);
}

const observer = new ResizeObserver(fit);
observer.observe(canvas);
fit();

/** Ground line rests this far above the bottom edge in the default view (CSS px). */
const GROUND_SCREEN_MARGIN_PX = 80;
const bootRect = canvas.getBoundingClientRect();
camera.offsetX = 0;
camera.offsetY = bootRect.height - GROUND_SCREEN_MARGIN_PX;

renderer.start();

void (async () => {
	const simClock = new SimClock();
	const w = await PhysicsWorld.create();
	simClock.subscribe(() => w.step());
	world = w;
	// Undo/redo over the document: serialize always folds the LIVE sim state
	// into the document first (Ruling 14) so undo restores what the user saw;
	// restore rebuilds Rapier from the snapshot and clears the selection.
	const undoStack = new UndoStack(
		() => {
			w.syncLiveTransforms();
			return w.doc.all();
		},
		(entities) => {
			w.restoreSnapshot(entities);
			session?.selectedIds.clear();
		},
	);
	// Seed the history with the initial (empty) scene so the first action is
	// undoable back to it.
	undoStack.commit();
	// Getters are lazy: the session does not exist yet when the wiring is built.
	const events = createToolEvents(w, {
		isPaused: () => clock?.isPaused ?? false,
		selectedIds: () => session?.selectedIds ?? new Set<string>(),
		pruneSelection: (id) => {
			session?.selectedIds.delete(id);
			if (session?.hoverId === id) session.hoverId = undefined;
		},
		isStaticSpawn: () => session?.staticMode ?? false,
		recordAction: () => undoStack.commit(),
		beginAction: () => undoStack.beginAction(),
		cancelAction: () => undoStack.cancelAction(),
	});
	session = new ToolSession(
		events,
		(wx, wy) =>
			pickLabel(listPickableLabels(), wx, wy, camera.zoom) ??
			pickBody(listPickableBodies(), wx, wy),
		(rect) =>
			bodiesInRect([...listPickableBodies(), ...listPickableLabels()], rect),
	);
	const toolbar = document.querySelector<HTMLElement>("#tool-rail");
	if (!toolbar) throw new Error("#tool-rail missing from index.html");
	attachToolControls({ toolbar, canvas, camera, session, undo: undoStack });
	// Debug mode must pause the clock BEFORE the sim controls attach, so the
	// pause button's initial aria state reflects the paused clock.
	if (debugEnabled) simClock.setPaused(true);
	const topBar = document.querySelector<HTMLElement>("#top-bar");
	if (!topBar) throw new Error("#top-bar missing from index.html");
	attachSimControls({
		topBar,
		clock: simClock,
		isEditingText: () => session?.isEditingText() ?? false,
		// Cancel any active drag first so its mouse joint is removed before the
		// registry teardown drops the body it references.
		onReset: () => {
			session?.cancel();
			w.reset();
			session?.selectedIds.clear();
			if (session) session.hoverId = undefined;
			undoStack.clear();
		},
	});
	if (debugEnabled) {
		installDebugApi(simClock, w, camera, session, undoStack);
		console.info("[par-physics] debug mode enabled");
	}
	clock = simClock;
})();
