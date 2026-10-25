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
import { SIM_SPEED_FACTOR, SimClock } from "./lib/clock";
import { installDebugApi } from "./lib/debug-api";
import { buildDemoScene, demoSceneBounds } from "./lib/demo-scene";
import { markDemoSceneSeen, shouldLoadDemoScene } from "./lib/first-run";
import {
	attachToolControls,
	CURSOR_DRAW,
	createToolEvents,
	freshBodyId,
} from "./lib/interaction";
import { attachJointPanel } from "./lib/joint-panel";
import { MATERIAL_DEFAULT_ID } from "./lib/material";
import { attachMaterialPanel } from "./lib/material-panel";
import { createMaterialStore } from "./lib/material-store";
import {
	applySceneFile,
	buildSceneFile,
	validateSceneFile,
} from "./lib/scene-file";
import { SceneStore } from "./lib/scene-store";
import { attachSceneUI } from "./lib/scene-ui";
import { attachSimControls, TimeScale } from "./lib/sim-controls";
import { createSimPump } from "./lib/sim-pump";
import {
	bodiesInRect,
	type PickableBody,
	pickBody,
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
		) => void,
	): void {
		const w = world;
		if (!w) return;
		w.eachJointEntity((e) => {
			const anchors = w.jointWorldAnchors(e);
			if (anchors)
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
				);
		});
	},
	forEachLabel(
		fn: (id: string, x: number, y: number, rot: number, text: string) => void,
	): void {
		const w = world;
		if (!w) return;
		w.eachLabel((label) =>
			fn(label.id, label.x, label.y, label.rot, label.text),
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
			if (pose) fn(t.id, pose.x, pose.y, pose.angle, t.on);
		});
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
		// SIM_SPEED_FACTOR doubles the nominal 1x: the world advances two
		// sim-seconds per wall second at the slider's 1.00 (Paul, 2026-10-24
		// — real-time gravity read as slow motion at this world scale).
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
	onFrame: () => {
		// The pump consumed this frame's wall time already (or the fallback
		// interval did — the pump makes double-feeding impossible).
		simPump.pump();
		refreshJointPanel?.();
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
		recordAction: () => undoStack.commit(),
		beginAction: () => undoStack.beginAction(),
		cancelAction: () => undoStack.cancelAction(),
	});
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
	const toolbar = document.querySelector<HTMLElement>("#tool-rail");
	if (!toolbar) throw new Error("#tool-rail missing from index.html");
	attachToolControls({ toolbar, canvas, camera, session, undo: undoStack });
	// Debug mode must pause the clock BEFORE the sim controls attach, so the
	// pause button's initial aria state reflects the paused clock.
	if (debugEnabled) simClock.setPaused(true);
	const topBar = document.querySelector<HTMLElement>("#top-bar");
	if (!topBar) throw new Error("#top-bar missing from index.html");
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
		// Cancel any active drag first so its mouse joint is removed before the
		// registry teardown drops the body it references.
		onReset: clearWorld,
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
	clock = simClock;
	// Demo-boot camera fit LAST: every panel is attached and the demo (if
	// any) restored; two rAFs guarantee the settled layout is measured.
	if (demoBooted && demoEntitiesForFit) {
		requestAnimationFrame(() =>
			requestAnimationFrame(() => fitCameraToScene(demoEntitiesForFit!)),
		);
	}
})();
