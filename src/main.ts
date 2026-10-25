/**
 * App entry point: boots the Canvas2D renderer, the Rapier world, and the
 * fixed-step clock that advances it from the rAF frame flow.
 */
import "./style.css";
import { debugEnabled } from "./debug";
import type { Assembly } from "./lib/assembly";
import { attachAssemblyPanel } from "./lib/assembly-panel";
import { createAssemblyStore } from "./lib/assembly-store";
import { Camera, cameraFitForBounds } from "./lib/camera";
import { attachCameraControls } from "./lib/camera-controls";
import { SIM_DT_SECONDS, SIM_SPEED_FACTOR, SimClock } from "./lib/clock";
import { installDebugApi } from "./lib/debug-api";
import { buildDemoScene, demoSceneBounds } from "./lib/demo-scene";
import type { LabelFont, LabelTextAlign } from "./lib/document";
import { attachDrawOptions } from "./lib/draw-options";
import { markDemoSceneSeen, shouldLoadDemoScene } from "./lib/first-run";
import {
	attachToolControls,
	CURSOR_DRAW,
	createToolEvents,
	freshBodyId,
} from "./lib/interaction";
import { attachJointPanel } from "./lib/joint-panel";
import { attachLabelPanel } from "./lib/label-panel";
import { MATERIAL_DEFAULT_ID } from "./lib/material";
import { attachMaterialPanel } from "./lib/material-panel";
import { createMaterialStore } from "./lib/material-store";
import { attachRotatePanel } from "./lib/rotate-panel";
import {
	applySceneFile,
	buildSceneFile,
	validateSceneFile,
} from "./lib/scene-file";
import { SceneStore } from "./lib/scene-store";
import { attachSceneUI } from "./lib/scene-ui";
import {
	loadSettings,
	type PersistedSettings,
	saveSettings,
} from "./lib/settings-store";
import {
	attachSimControls,
	gravityFromVector,
	gravityVector,
	TimeScale,
} from "./lib/sim-controls";
import { createSimPump } from "./lib/sim-pump";
import { attachStatusBar, type StatusBar } from "./lib/status-bar";
import {
	bodiesInRect,
	type PickableBody,
	pickAllBodies,
	pickBody,
	pickBodyAtDepth,
	pickJoint,
	pickLabel,
	pickThruster,
	ToolSession,
} from "./lib/tools";
import { attachTooltips } from "./lib/tooltips";
import { UndoStack } from "./lib/undo";
import { type BodyShape, PhysicsWorld } from "./lib/world";
import { createRenderer } from "./renderer";

const stage = document.querySelector<HTMLCanvasElement>("#stage");
if (!stage) throw new Error("#stage canvas missing from index.html");
// tsgo does not carry const narrowing into closures; alias with an explicit type.
const canvas: HTMLCanvasElement = stage;

/** Debug mode freezes the real-time feed; `advanceTime` drives the sim deterministically. */
let clock: SimClock | null = null;
/** Per-frame refresh for the joint panel section (set at panel attach). */
let refreshJointPanel: (() => void) | null = null;
/** Per-frame refresh for the label properties section (set at panel attach). */
let refreshLabelPanel: (() => void) | null = null;
/** Per-frame refresh for the rotation section (set at panel attach). */
let refreshRotatePanel: (() => void) | null = null;
/** The bottom status bar (help + census + FPS); built at boot. */
let statusBar: StatusBar | null = null;
/** Demo-boot camera fit: set by the boot branch, applied after ALL panels attach. */
let demoBooted = false;
let demoEntitiesForFit: Parameters<typeof fitCameraToScene>[0] | null = null;
/** Live physics world, built asynchronously at boot. */
let world: PhysicsWorld | null = null;
/** Tool state machine; built with the world. */
let session: ToolSession | null = null;
/**
 * The material new draw-tool shapes take (D20): the material panel sets it
 * once booted; spawns before the panel exists take the palette default.
 */
let activeMaterialId = MATERIAL_DEFAULT_ID;

/**
 * Accumulator feed-rate scale (P3-T3, 0.25×–2×): the rAF delta is multiplied
 * by it before `advanceRealTime`; created here so the rAF closure, the top-bar
 * slider, and the debug API share one instance.
 */
const timeScale = new TimeScale();

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
	size: number | undefined;
	align: "left" | "center" | "right" | undefined;
}[] {
	const w = world;
	if (!w) return [];
	return w.labels().map((label) => ({
		id: label.id,
		x: label.x,
		y: label.y,
		text: label.text,
		rot: label.rot,
		size: label.size,
		align: label.align,
	}));
}

/** Joints with live glyph positions (pick order, topmost last). A pulley is
 * pickable at its wheel too — the wheel is its own glyph, separate from the
 * body anchors. */
function listPickableJoints(): { id: string; wx: number; wy: number }[] {
	const w = world;
	if (!w) return [];
	const out: { id: string; wx: number; wy: number }[] = [];
	for (const e of w.jointEntities()) {
		const anchor = w.jointWorldAnchor(e);
		if (anchor) out.push({ id: e.id, wx: anchor.x, wy: anchor.y });
		if (e.params.kind === "gear" || e.params.kind === "belt") {
			const anchors = w.jointWorldAnchors(e);
			if (anchors) out.push({ id: e.id, wx: anchors.b.x, wy: anchors.b.y });
		}
		if (e.params.kind === "pulley")
			out.push({ id: e.id, wx: e.params.wheelX, wy: e.params.wheelY });
	}
	return out;
}

/** Thrusters with live glyph positions (pick order, topmost last). */
function listPickableThrusters(): { id: string; wx: number; wy: number }[] {
	const w = world;
	if (!w) return [];
	const out: { id: string; wx: number; wy: number }[] = [];
	for (const t of w.thrusterEntities()) {
		const pose = w.thrusterPose(t);
		if (pose) out.push({ id: t.id, wx: pose.x, wy: pose.y });
	}
	return out;
}

/** Shared frozen empty selection: the scene adapter's no-session fallback
 * without an allocation (P5 per-frame allocation card). */
const EMPTY_SELECTION: ReadonlySet<string> = new Set();

const sceneView = {
	forEachBody(
		fn: (
			id: string,
			shape: BodyShape,
			x: number,
			y: number,
			rot: number,
			isStatic: boolean,
			color: string,
			/** Runtime fire state (flammable.ts): true draws the flame glyph. */
			burning: boolean,
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
				w.doc.material(entity.materialId).color,
				w.isBurning(id),
			);
		}
	},
	forEachJoint(
		fn: (
			id: string,
			jointType: string,
			wx: number,
			wy: number,
			motorOn: boolean,
			wx2: number,
			wy2: number,
			wx3: number,
			wy3: number,
			/** Gear/belt circle geometry for the rim-teeth overlay (0 = unused). */
			radiusA: number,
			rotA: number,
			radiusB: number,
			rotB: number,
		) => void,
	): void {
		const w = world;
		if (!w) return;
		w.eachJointEntity((e) => {
			const anchors = w.jointWorldAnchors(e);
			if (!anchors) return;
			const gearDrive = e.params.kind === "gear" || e.params.kind === "belt";
			let radiusA = 0;
			let rotA = 0;
			let radiusB = 0;
			let rotB = 0;
			if (gearDrive) {
				const shapeA = w.shapeOf(e.bodyA);
				const shapeB = e.bodyB ? w.shapeOf(e.bodyB) : undefined;
				if (shapeA?.kind === "circle") radiusA = shapeA.radius;
				if (shapeB?.kind === "circle") radiusB = shapeB.radius;
				rotA = w.bodies.get(e.bodyA)?.rotation() ?? 0;
				rotB = e.bodyB ? (w.bodies.get(e.bodyB)?.rotation() ?? 0) : 0;
			}
			fn(
				e.id,
				e.jointType,
				anchors.a.x,
				anchors.a.y,
				e.params.kind === "motor" ? e.params.on : true,
				anchors.b.x,
				anchors.b.y,
				e.params.kind === "pulley" ? e.params.wheelX : anchors.b.x,
				e.params.kind === "pulley" ? e.params.wheelY : anchors.b.y,
				radiusA,
				rotA,
				radiusB,
				rotB,
			);
		});
	},
	/**
	 * Joint relationship lines (the joint-lines toggle's input): one call
	 * per anchor→connected-body-center segment. Rope links are omitted —
	 * their anchor sits ON the bead center so the segment is degenerate —
	 * and a world-anchored joint (bodyB null) draws only its body side.
	 */
	forEachJointLine(
		fn: (ax: number, ay: number, bx: number, by: number) => void,
	): void {
		const w = world;
		if (!w) return;
		w.eachJointEntity((e) => {
			const anchors = w.jointWorldAnchors(e);
			if (!anchors) return;
			if (e.jointType === "rope") return;
			const a = w.bodies.get(e.bodyA);
			if (a) {
				const t = a.translation();
				fn(anchors.a.x, anchors.a.y, t.x, t.y);
			}
			const b = e.bodyB ? w.bodies.get(e.bodyB) : undefined;
			if (b) {
				const t = b.translation();
				fn(anchors.b.x, anchors.b.y, t.x, t.y);
			}
		});
	},
	forEachLabel(
		fn: (
			id: string,
			x: number,
			y: number,
			rot: number,
			text: string,
			size: number | undefined,
			font: LabelFont | undefined,
			align: LabelTextAlign | undefined,
		) => void,
	): void {
		const w = world;
		if (!w) return;
		w.eachLabel((label) =>
			fn(
				label.id,
				label.x,
				label.y,
				label.rot,
				label.text,
				label.size,
				label.font,
				label.align,
			),
		);
	},
	forEachThruster(
		fn: (
			id: string,
			wx: number,
			wy: number,
			angle: number,
			on: boolean,
		) => void,
	) {
		const w = world;
		if (!w) return;
		w.eachThrusterEntity((t) => {
			const pose = w.thrusterPose(t);
			if (pose) fn(t.id, pose.x, pose.y, pose.angle, w.thrusterFiring(t.id));
		});
	},
	preview() {
		return session?.preview() ?? null;
	},
	// Animation phase for pause-freezing effects: the sim clock's tick count
	// (0 before the clock exists — debug pages boot paused with a still
	// flame).
	simTime() {
		return clock ? clock.tick * SIM_DT_SECONDS : 0;
	},
	rubberBand() {
		return session?.rubberBand() ?? null;
	},
	hoverId() {
		return session?.hoverId;
	},
	selectedIds(): ReadonlySet<string> {
		// The LIVE selection set (P5 per-frame allocation card): the renderer
		// reads it during rAF — single-threaded, so no torn reads — and the
		// per-frame [...spread] copy is gone.
		return session ? session.selectedIds : EMPTY_SELECTION;
	},
};

const camera = new Camera();

/**
 * Fit the camera so the scene's body-content bounds sit centered in the
 * viewport (the demo-boot fix: the camera used to stay at the generic
 * ground-at-bottom default, drawing the machine off to the right). Both
 * demo-load paths call this; scene/autosave restores keep the camera alone
 * (a returning session's view is the user's, not ours to move).
 */
const fitCameraToScene = (
	entities: Parameters<typeof demoSceneBounds>[0],
): void => {
	const bounds = demoSceneBounds(entities);
	if (!bounds) return;
	const rect = canvas.getBoundingClientRect();
	const fit = cameraFitForBounds(
		bounds.minX,
		bounds.minY,
		bounds.maxX,
		bounds.maxY,
		rect.width,
		rect.height,
	);
	camera.zoom = fit.zoom;
	camera.offsetX = fit.offsetX;
	camera.offsetY = fit.offsetY;
};

const simPump = createSimPump(
	(seconds) => {
		// Time-scale (P3-T3) scales the pump's FEED only: the fixed 60Hz tick
		// is unchanged, and the debug advanceTime path (which steps ticks
		// directly) never sees the scale — determinism guard, pinned in e2e.
		// SIM_SPEED_FACTOR quadruples the nominal 1x: the world advances four
		// sim-seconds per wall second at the slider's 1.00 (Paul, 2026-10-24
		// — real-time gravity read as slow motion at this world scale;
		// doubled once, then again the same day).
		clock?.advanceRealTime(seconds * timeScale.value * SIM_SPEED_FACTOR);
	},
	() => performance.now(),
);

// Widget tooltips: ONE body-level element for every data-tip control. Must
// attach before any control renders its first hover — module level, app
// lifetime.
attachTooltips();

const renderer = createRenderer(canvas, {
	camera,
	scene: sceneView,
	onFrame: (dtSeconds) => {
		// The pump consumed this frame's wall time already (or the fallback
		// interval did — the pump makes double-feeding impossible).
		simPump.pump();
		refreshJointPanel?.();
		refreshLabelPanel?.();
		refreshRotatePanel?.();
		statusBar?.frame(dtSeconds);
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
// A monitor move (or browser zoom) changes devicePixelRatio without a size
// event — re-fit so the backing store stays sharp across monitors.
let dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
dprQuery.addEventListener("change", function refitOnDprChange() {
	const current = window.devicePixelRatio;
	dprQuery.removeEventListener("change", refitOnDprChange);
	dprQuery = matchMedia(`(resolution: ${current}dppx)`);
	dprQuery.addEventListener("change", refitOnDprChange);
	fit();
});

/** Ground line rests this far above the bottom edge in the default view (CSS px). */
const GROUND_SCREEN_MARGIN_PX = 80;
const bootRect = canvas.getBoundingClientRect();
camera.offsetX = 0;
camera.offsetY = bootRect.height - GROUND_SCREEN_MARGIN_PX;

renderer.start();

void (async () => {
	const simClock = new SimClock();
	const w = await PhysicsWorld.create();
	// Brittle shatter fragments mint body ids through the shared counter, so
	// the scene-file id sync never collides with a restored fragment.
	w.fragmentIdMinter = freshBodyId;
	simClock.subscribe(() => w.step());
	world = w;
	// Settings persistence (settings-store.ts): load before any control
	// attaches — the attach-time syncs mirror restored state into the DOM —
	// and a tiny save helper every wiring site below shares.
	const settings = loadSettings(localStorage);
	const save = (patch: Partial<PersistedSettings>): void => {
		saveSettings(localStorage, patch);
	};
	// Demo scene (P4-T5, PRD D16): preloads on first run (persisted flag);
	// `?demo=1` forces the load in debug mode as the deterministic e2e hook,
	// and `?debug=1` alone skips the preload so deterministic test pages
	// always boot with an empty world.
	const forceDemo =
		new URLSearchParams(window.location.search).get("demo") === "1";
	// Scene store (P5-T1): opened before the boot decision so a returning
	// session restores its autosaved working scene. Fresh debug contexts
	// carry no autosave, so deterministic test pages still boot empty.
	const sceneStore = new SceneStore();
	try {
		await sceneStore.open();
	} catch (err) {
		console.warn("[par-physics] scene store unavailable", err);
	}
	if (forceDemo || (!debugEnabled && shouldLoadDemoScene(localStorage))) {
		const demoEntities = buildDemoScene();
		w.restoreSnapshot(demoEntities);
		markDemoSceneSeen(localStorage);
		// The fit itself runs at the END of boot (bottom of this IIFE): the
		// tool rail and context panels attach later in the same IIFE, and
		// the fit must measure the SETTLED canvas rect or the scene lands
		// off-center by half a panel width.
		demoBooted = true;
		demoEntitiesForFit = demoEntities;
	} else {
		const autosave = await sceneStore.loadAutosave().catch(() => null);
		if (autosave && validateSceneFile(autosave).ok) {
			try {
				applySceneFile(w, autosave);
			} catch (err) {
				console.warn("[par-physics] autosave restore failed", err);
			}
		}
	}
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
		// Active material for new shapes (D20): the panel sets it; read per spawn.
		activeMaterialId: () => activeMaterialId,
		// Angle snap (draw options): the rotate gesture reads it per move.
		angleSnap: () => session?.angleSnap ?? false,
		recordAction: () => undoStack.commit(),
		beginAction: () => undoStack.beginAction(),
		cancelAction: () => undoStack.cancelAction(),
	});
	// Snap tool wiring (Paul, 2026-10-25): bodies-only depth pick (Alt+click
	// reaches stacked bodies), live body centers for the preview, and the
	// completion — teleport the mover onto the target's center, one undo
	// action for the whole gesture (arming press opened the snapshot).
	events.pickBodyOnly = (wx, wy, depth = 0) =>
		pickBodyAtDepth(listPickableBodies(), wx, wy, depth);
	events.pickAllBodies = (wx, wy) =>
		pickAllBodies(listPickableBodies(), wx, wy);
	events.bodyShape = (id) => w.shapeOf(id);
	events.bodyCenter = (id) => {
		const b = w.bodies.get(id);
		return b ? { x: b.translation().x, y: b.translation().y } : undefined;
	};
	events.onSnapBodies = ({ moverId, targetId }) => {
		const target = w.bodies.get(targetId);
		if (!target || !w.bodies.has(moverId)) return;
		const t = target.translation();
		w.moveBody(moverId, t.x, t.y);
		undoStack.commit();
	};
	session = new ToolSession(
		events,
		(wx, wy) =>
			pickJoint(listPickableJoints(), wx, wy, camera.zoom) ??
			pickThruster(listPickableThrusters(), wx, wy, camera.zoom) ??
			pickLabel(listPickableLabels(), wx, wy, camera.zoom) ??
			pickBody(listPickableBodies(), wx, wy),
		(rect) =>
			bodiesInRect([...listPickableBodies(), ...listPickableLabels()], rect),
	);
	// Restore tool + static mode before the toolbar attaches: the attach-time
	// syncToolbar/applyCursor mirror them into the DOM (boot has no gesture,
	// so the direct field writes skip setTool's gesture teardown).
	session.tool = settings.tool;
	session.staticMode = settings.staticMode;
	const toolbar = document.querySelector<HTMLElement>("#tool-rail");
	if (!toolbar) throw new Error("#tool-rail missing from index.html");
	attachToolControls({
		toolbar,
		canvas,
		camera,
		session,
		undo: undoStack,
		// Double-click re-enters a placed label's inline text edit (the panel
		// then shows its properties; the edit commits on Enter/Escape/click).
		onLabelDoubleClick: (wx, wy) => {
			const hit = pickLabel(listPickableLabels(), wx, wy, camera.zoom);
			const s = session;
			if (!hit || !s) return false;
			const label = w.labelOf(hit);
			if (!label) return false;
			s.beginTextEditing(hit, label.x, label.y, label.text);
			return true;
		},
		onToolChange: (tool) => save({ tool }),
		onStaticModeChange: (on) => save({ staticMode: on }),
	});
	// Debug mode must pause the clock BEFORE the sim controls attach, so the
	// pause button's initial aria state reflects the paused clock. A stored
	// pause restores first; the debug force-pause still wins in debug mode.
	if (settings.paused) simClock.setPaused(true);
	if (debugEnabled) simClock.setPaused(true);
	const topBar = document.querySelector<HTMLElement>("#top-bar");
	if (!topBar) throw new Error("#top-bar missing from index.html");
	// Header draw options (grid/snap/center/square/angle-snap): plain session
	// fields + the renderer's grid spacing; persistence restores via the
	// handle and saves every change.
	const drawOptions = attachDrawOptions({
		host: topBar,
		session,
		renderer,
		onChange: (values) => save(values),
	});
	drawOptions.apply({
		gridSize: settings.gridSize,
		gridSnap: settings.gridSnap,
		circleFromCenter: settings.circleFromCenter,
		constrainBox: settings.constrainBox,
		angleSnap: settings.angleSnap,
		xRay: settings.xRay,
		jointLines: settings.jointLines,
	});
	// Bottom status bar: per-tool help + live scene census + FPS toggle.
	const statusBarEl = document.querySelector<HTMLElement>("#status-bar");
	if (!statusBarEl) throw new Error("#status-bar missing from index.html");
	statusBar = attachStatusBar({
		host: statusBarEl,
		world: w,
		session,
		initialFpsVisible: settings.fpsVisible,
		onFpsToggle: (visible) => save({ fpsVisible: visible }),
	});
	// Demo / New-empty-world scene actions (P4-T5, D16): loading the demo
	// replaces the scene through the ordinary restoreSnapshot path and seeds
	// a fresh undo history from it; an empty world is the same teardown the
	// Reset button performs (drag canceled first).
	const clearWorld = (): void => {
		session?.cancel();
		w.reset();
		session?.selectedIds.clear();
		if (session) session.hoverId = undefined;
		undoStack.clear();
	};
	const loadDemo = (): void => {
		session?.cancel();
		const demoEntities = buildDemoScene();
		w.restoreSnapshot(demoEntities);
		fitCameraToScene(demoEntities);
		session?.selectedIds.clear();
		if (session) session.hoverId = undefined;
		undoStack.clear();
	};
	const demoButton =
		topBar.querySelector<HTMLButtonElement>('[data-sim="demo"]');
	const newWorldButton = topBar.querySelector<HTMLButtonElement>(
		'[data-sim="new-world"]',
	);
	if (!demoButton || !newWorldButton)
		throw new Error("scene action buttons missing from the top bar");
	demoButton.addEventListener("click", loadDemo);
	newWorldButton.addEventListener("click", clearWorld);
	// Scenes menu + autosave (P5-T1/T2): every recorded action (the undo
	// boundary) rewrites the autosave after a debounce; the menu owns named
	// saves and JSON I/O over the same scene-file format. onChange is a
	// single slot that attachToolControls already claimed for the undo
	// toolbar buttons — chain, don't clobber (review I1).
	attachSceneUI({ topBar, world: w, undo: undoStack, store: sceneStore });
	const previousOnChange = undoStack.onChange;
	let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
	undoStack.onChange = () => {
		previousOnChange?.();
		clearTimeout(autosaveTimer);
		autosaveTimer = setTimeout(() => {
			sceneStore
				.autosave(buildSceneFile(w.doc))
				.catch((err) => console.warn("[par-physics] autosave failed", err));
		}, 500);
	};
	attachSimControls({
		topBar,
		clock: simClock,
		world: w,
		timeScale,
		isEditingText: () => session?.isEditingText() ?? false,
		onPauseChange: (paused) => save({ paused }),
		// Cancel any active drag first so its mouse joint is removed before the
		// registry teardown drops the body it references.
		onReset: clearWorld,
	});
	// Restore speed + gravity after the sim controls attach — their existing
	// subscriptions repaint the sliders — and BEFORE the save subscriptions
	// so the boot restore never writes back.
	timeScale.set(settings.timeScale);
	const restoredG = gravityVector(
		settings.gravityAngleDeg,
		settings.gravityMagnitude,
	);
	w.setGravity(restoredG.x, restoredG.y);
	timeScale.subscribe((v) => save({ timeScale: v }));
	w.subscribeGravity((g) => {
		const { angleDeg, magnitude } = gravityFromVector(g);
		save({ gravityAngleDeg: angleDeg, gravityMagnitude: magnitude });
	});
	if (debugEnabled) {
		installDebugApi(
			simClock,
			w,
			camera,
			session,
			undoStack,
			() => activeMaterialId,
			timeScale,
		);
		console.info("[par-physics] debug mode enabled");
	}
	// Custom-material library (P3-T2): load persisted customs (IndexedDB,
	// schema-versioned store), merge into the registry, then attach the panel.
	// A load failure degrades to the palette-only library, not a dead app.
	const store = createMaterialStore();
	try {
		for (const material of await store.load()) w.doc.addMaterial(material);
	} catch (err) {
		console.warn("[par-physics] custom materials failed to load", err);
	}
	// Reusable assemblies: load the persisted library before the panels attach
	// (the material-library boot pattern); a load failure degrades to an empty
	// session-only library, not a dead app.
	const assemblyStore = createAssemblyStore();
	let savedAssemblies: Assembly[] = [];
	try {
		savedAssemblies = await assemblyStore.load();
	} catch (err) {
		console.warn("[par-physics] assemblies failed to load", err);
	}
	const contextPanel = document.querySelector<HTMLElement>("#context-panel");
	if (!contextPanel) throw new Error("#context-panel missing from index.html");
	attachMaterialPanel({
		panel: contextPanel,
		doc: w.doc,
		world: w,
		session,
		undo: undoStack,
		store,
		onActiveChange: (id) => {
			activeMaterialId = id;
		},
	});
	// Joint panel section appends to the same context panel (D15/D19); its
	// per-frame refresh rides the renderer's rAF flow above.
	refreshJointPanel = attachJointPanel({
		host: contextPanel,
		world: w,
		session,
		undo: undoStack,
	});
	// Assemblies section appends to the same context panel (the joint-panel
	// append pattern; neither clobbers the other).
	attachAssemblyPanel({
		host: contextPanel,
		world: w,
		session,
		undo: undoStack,
		store: assemblyStore,
		canvas,
		camera,
		initial: savedAssemblies,
	});
	// Label properties section (same append pattern): rides the rAF refresh.
	refreshLabelPanel = attachLabelPanel({
		host: contextPanel,
		world: w,
		session,
		undo: undoStack,
	});
	refreshRotatePanel = attachRotatePanel({
		host: contextPanel,
		world: w,
		session,
		undo: undoStack,
		isPaused: () => clock?.isPaused ?? false,
	});
	clock = simClock;
	// Demo-boot camera fit LAST: every panel is attached and the demo (if
	// any) restored; two rAFs guarantee the settled layout is measured.
	if (demoBooted && demoEntitiesForFit) {
		requestAnimationFrame(() =>
			requestAnimationFrame(() => fitCameraToScene(demoEntitiesForFit!)),
		);
	}
})();
