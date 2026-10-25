/**
 * The bottom status bar: contextual help for the active tool (how to close a
 * polygon, the thruster drag, the joint two-click flow, …), a live scene
 * census, and an optional FPS readout. Per-frame entry is allocation-light:
 * counts land in a reused record and strings rebuild only when their content
 * changes.
 */
import type { ToolId, ToolSession } from "./tools";
import type { PhysicsWorld } from "./world";

const TOOL_HELP: Record<ToolId, string> = {
	select:
		"Click: select · drag: move · R + vertical drag: rotate · Shift+click: multi-select · Del: delete · Ctrl+D: duplicate",
	box: "Drag to draw a box",
	circle: "Drag to draw a circle",
	polygon:
		"Click to place vertices · click the first vertex or press Enter to close · Escape cancels",
	line: "Drag (or click twice) to draw a beam · hold Shift to snap the angle to 45°",
	freehand: "Drag to sketch — the stroke closes into a shape on release",
	text: "Click to place text, type, then Enter commits · double-click placed text to edit it",
	joint: "Click body A, then body B (or empty space) to place the joint",
	thruster:
		"Click a body to mount the thruster, then drag to aim; release commits the direction",
};

const JOINT_HELP: Record<string, string> = {
	pin: "Pin: click body A, then body B (or empty space) — both spin freely about the shared pivot",
	weld: "Weld: click body A, then body B (or empty space) — the pair moves as one rigid unit",
	rod: "Rod: click body A, then body B — the pair keeps an exact distance",
	slider: "Slider: click body A, then body B — the pair slides along one axis",
	spring:
		"Spring: click body A, then body B — a spring pulls the pair together",
	motor: "Motor: click body A, then body B — a driven axle between the pair",
	rope: "Rope: drag a stroke from one body to another — it chains rope segments",
	pulley:
		"Pulley: click body A, then body B, then anywhere for the fixed wheel point",
};

export interface StatusBarDeps {
	/** The footer element hosting the bar (#status-bar). */
	host: HTMLElement;
	world: PhysicsWorld;
	session: ToolSession;
}

export interface StatusBar {
	/** Called once per rendered frame with the wall-clock delta. */
	frame(dtSeconds: number): void;
}

export function attachStatusBar(deps: StatusBarDeps): StatusBar {
	const helpEl = deps.host.querySelector<HTMLElement>("#status-help");
	const statsEl = deps.host.querySelector<HTMLElement>("#status-stats");
	const fpsEl = deps.host.querySelector<HTMLElement>("#status-fps");
	const fpsToggle = deps.host.querySelector<HTMLButtonElement>("#fps-toggle");
	if (!helpEl || !statsEl || !fpsEl || !fpsToggle)
		throw new Error("status bar: missing elements");

	let fpsVisible = false;
	fpsToggle.addEventListener("click", () => {
		fpsVisible = !fpsVisible;
		fpsEl.hidden = !fpsVisible;
		fpsToggle.setAttribute("aria-pressed", String(fpsVisible));
	});

	let lastHelp = "";
	let fps = 0;
	let fpsAccum = 0;
	const counts = {
		box: 0,
		circle: 0,
		polygon: 0,
		labels: 0,
		joints: 0,
		thrusters: 0,
	};
	const prev = { ...counts };

	const frame = (dt: number): void => {
		// Tool help: joint tool narrows to the active placement kind.
		const tool = deps.session.tool;
		const help =
			tool === "joint"
				? (JOINT_HELP[deps.session.jointKind] ?? JOINT_HELP.pin ?? "")
				: (TOOL_HELP[tool] ?? "");
		if (help !== lastHelp) {
			helpEl.textContent = help;
			lastHelp = help;
		}

		// Scene census into the reused record; rebuild the text on change only.
		for (const k of Object.keys(counts) as Array<keyof typeof counts>)
			counts[k] = 0;
		for (const [id] of deps.world.bodies) {
			const e = deps.world.doc.get(id);
			if (e?.kind === "body") counts[e.shape.kind] += 1;
		}
		deps.world.eachLabel(() => {
			counts.labels += 1;
		});
		deps.world.eachJointEntity(() => {
			counts.joints += 1;
		});
		deps.world.eachThrusterEntity(() => {
			counts.thrusters += 1;
		});
		let changed = false;
		for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
			if (counts[k] !== prev[k]) {
				prev[k] = counts[k];
				changed = true;
			}
		}
		if (changed) {
			const total = counts.box + counts.circle + counts.polygon;
			const detail: string[] = [];
			if (counts.box > 0) detail.push(`boxes ${counts.box}`);
			if (counts.circle > 0) detail.push(`circles ${counts.circle}`);
			if (counts.polygon > 0) detail.push(`polys ${counts.polygon}`);
			const parts: string[] = [];
			if (total > 0) parts.push(`bodies ${total} (${detail.join(" · ")})`);
			if (counts.joints > 0) parts.push(`joints ${counts.joints}`);
			if (counts.thrusters > 0) parts.push(`thrusters ${counts.thrusters}`);
			if (counts.labels > 0) parts.push(`labels ${counts.labels}`);
			statsEl.textContent =
				parts.length > 0 ? parts.join(" · ") : "empty scene";
		}

		// FPS: EMA over frame deltas, displayed at most 4×/second.
		if (dt > 0) fps = fps * 0.9 + (1 / dt) * 0.1;
		fpsAccum += dt;
		if (fpsVisible && fpsAccum >= 0.25) {
			fpsAccum = 0;
			fpsEl.textContent = `${Math.round(fps)} fps`;
		}
	};

	return { frame };
}
