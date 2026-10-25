/**
 * The built-in demo scene (P4-T5, PRD D16): a Rube Goldberg starter authored
 * as a plain document snapshot — the same entity records the world rebuilds
 * from, so loading routes through the ordinary restoreSnapshot path (undo,
 * save/load, and rebuild fidelity come for free). Fixed `demo-*` ids make
 * the scene addressable from tests and the debug API.
 *
 * Machine layout (y-down world, ground at y=0): a ball starts on a tilted
 * ramp, rolls onto a paddle-wheel conveyor (a motorized wheel protruding
 * through a slot in the conveyor platform — static bodies may overlap it),
 * is carried across and rolls down a slightly tilted shelf, knocking over a
 * row of dominoes on the way. At the end of the machine a ROPE-AND-
 * COUNTERWEIGHT LIFT hangs from a static hook: a rope of small bead links
 * (the P4-T4 rope chain) carries a cradle platform with a welded counter-
 * weight block; the final ball sits in the cradle with a THRUSTER mounted on
 * it. The thruster is on from boot: the ball slides out of the cradle, drops
 * to the ground, and the continuous thrust carries it across the FINISH
 * marker. The marker is a label; the e2e asserts the ball's x passes it.
 *
 * D17 note: this is a fixed authored scene, not subject to the rope-chain
 * placement caps (those guard interactive strokes); the chain here is 17
 * beads, well inside them anyway.
 */
import { type DocEntity, defaultBody, type LabelEntity } from "./document";
import {
	type JointEntity,
	type JointParams,
	MOTOR_DEFAULT_TORQUE,
	makeJoint,
} from "./joint";
import { MATERIAL_DEFAULT_ID } from "./material";
import type { ThrusterEntity } from "./thruster";
import type { Vec2 } from "./triangulate";
import type { DocumentId } from "./world";

/** Id of the final ball — the one the end-marker assertion tracks. */
export const DEMO_FINAL_BODY_ID = "demo-final";
/** The ball crosses the FINISH marker when its x passes this. */
export const DEMO_FINISH_X = 450;

/** Rope chain geometry for the lift (coarser than the tool's stroke chain). */
const ROPE_BEAD_RADIUS = 0.6;
const ROPE_BEAD_SPACING = 10;
const ROPE_LINK_SLACK = 1.05;

/**
 * Build the demo scene's entities, in insertion order (draw order). Pure:
 * callers load it with `world.restoreSnapshot(buildDemoScene())`.
 */
export function buildDemoScene(): DocEntity[] {
	const entities: DocEntity[] = [];
	let linkSeq = 0;

	const box = (
		id: string,
		x: number,
		y: number,
		hw: number,
		hh: number,
		rot = 0,
		isStatic = false,
		materialId: string = MATERIAL_DEFAULT_ID,
	): void => {
		entities.push({
			...defaultBody(
				id,
				{ kind: "box", halfWidth: hw, halfHeight: hh },
				x,
				y,
				rot,
			),
			isStatic,
			materialId,
		});
	};
	const circle = (
		id: string,
		x: number,
		y: number,
		r: number,
		isStatic = false,
		materialId: string = MATERIAL_DEFAULT_ID,
	): void => {
		entities.push({
			...defaultBody(id, { kind: "circle", radius: r }, x, y),
			isStatic,
			materialId,
		});
	};
	const joint = (
		id: string,
		params: JointParams,
		bodyA: DocumentId,
		bodyB: DocumentId | null,
		pivot: Vec2,
		transformA: { x: number; y: number; rot: number },
		transformB: { x: number; y: number; rot: number } | null,
		endpointB?: Vec2,
	): void => {
		const entity: JointEntity = makeJoint(
			id,
			params,
			bodyA,
			bodyB,
			pivot,
			transformA,
			transformB,
			endpointB,
		);
		entities.push(entity);
	};

	// Stage 1 — ramp and start ball. Ice ramp + ice ball (μ ≈ 0.02): the
	// ball slides instead of crawling at the rolling-ball rate. From rest a
	// slide still takes ~8 s to reach the conveyor — Rube Goldberg pacing.
	box("demo-ramp", -420, -180, 110, 5, 0.55, true, "ice");
	circle("demo-ball", -460, -262, 12, false, "ice");

	// Stage 2 — paddle-wheel conveyor: a motorized wheel pinned to the world
	// at its centre (motor joint → wheel/ground contacts off, so no ground
	// friction fights the spin), standing free between ramp and shelf. The
	// clockwise surface (left side moving UP) catches the ball falling off
	// the ramp tip and carries it up-over-right, depositing it on the shelf.
	circle("demo-wheel", -230, -35, 30);
	joint(
		"demo-conveyor",
		{
			kind: "motor",
			targetVelocity: 0.8,
			maxTorque: MOTOR_DEFAULT_TORQUE,
			on: true,
		},
		"demo-wheel",
		null,
		{ x: -230, y: -35 },
		{ x: -230, y: -35, rot: 0 },
		null,
	);

	// Stage 3 — shelf with dominoes (tilted so the ball keeps rolling after
	// the conveyor hands it over; its left edge sits just past the wheel's
	// right shoulder, level with the ball's exit path for a flat transfer).
	box("demo-shelf", -7.5, -12, 192.5, 5, 0.03, true, "ice");
	const dominoXs = [-100, -76, -52, -28, -4, 20];
	// 2 units of air between each domino's base and the tilted shelf surface
	// (an embedded spawn gets ejected and topples at boot, measured); bases
	// 5 wide so a 22-tall domino is stable on the tilt, and the tilt itself
	// shallow (0.03) because domino rows on an ice-pair surface crept down
	// slope and toppled in lockstep within ~6 s (measured at 0.08 and 0.12).
	const dominoYs = [-33, -32, -31.5, -30.5, -30, -29];
	dominoXs.forEach((x, i) => {
		box(`demo-domino-${i + 1}`, x, dominoYs[i] as number, 2.5, 11);
	});

	// Stage 4 — rope-and-counterweight lift: hook (static), rope chain down
	// to the cradle, counterweight welded under the cradle, final ball in
	// the cradle with a thruster mounted on it.
	box("demo-hook", 330, -255, 8, 3, 0, true);
	const hookTransform = { x: 330, y: -255, rot: 0 };
	box("demo-cradle", 330, -85, 20, 3);
	const cradleTransform = { x: 330, y: -85, rot: 0 };
	box("demo-weight", 330, -71, 10, 10);
	const weightTransform = { x: 330, y: -71, rot: 0 };
	joint(
		"demo-cradle-weld",
		{ kind: "weld", relRot: 0 },
		"demo-cradle",
		"demo-weight",
		{ x: 330, y: -81 },
		cradleTransform,
		weightTransform,
	);

	// Rope beads hang from the hook to the cradle top; capture pins at both
	// ends. The end beads sit half inside the hook and cradle (the tool path's
	// capture shape), so both pins carry contactsOff for the same measured
	// reason as the tool path's capture pins: a contact-vs-pin fight stretches
	// the adjacent links.
	const top = { x: 330, y: -252 };
	const bottom = { x: 330, y: -86 };
	const dy = bottom.y - top.y;
	const beadCount = Math.max(
		2,
		Math.round(Math.abs(dy) / ROPE_BEAD_SPACING) + 1,
	);
	const beadIds: string[] = [];
	for (let i = 0; i < beadCount; i++) {
		const t = i / (beadCount - 1);
		const p = { x: top.x, y: top.y + dy * t };
		const id = `demo-rope-${i + 1}`;
		circle(id, p.x, p.y, ROPE_BEAD_RADIUS);
		beadIds.push(id);
	}
	for (let i = 1; i < beadIds.length; i++) {
		const aId = beadIds[i - 1] as string;
		const bId = beadIds[i] as string;
		const a = { x: top.x, y: top.y + (dy * (i - 1)) / (beadCount - 1) };
		const b = { x: top.x, y: top.y + (dy * i) / (beadCount - 1) };
		const placed = Math.hypot(b.x - a.x, b.y - a.y);
		linkSeq += 1;
		joint(
			`demo-rope-link-${linkSeq}`,
			{ kind: "rope", length: placed * ROPE_LINK_SLACK },
			aId,
			bId,
			a,
			{ x: a.x, y: a.y, rot: 0 },
			{ x: b.x, y: b.y, rot: 0 },
			b,
		);
	}
	joint(
		"demo-rope-cap-top",
		{ kind: "pin", contactsOff: true },
		beadIds[0] as string,
		"demo-hook",
		top,
		{ x: top.x, y: top.y, rot: 0 },
		hookTransform,
	);
	joint(
		"demo-rope-cap-bottom",
		{ kind: "pin", contactsOff: true },
		beadIds[beadIds.length - 1] as string,
		"demo-cradle",
		bottom,
		{ x: bottom.x, y: bottom.y, rot: 0 },
		cradleTransform,
	);

	// The final ball: sits in the cradle, thruster pointing +x, ON.
	circle(DEMO_FINAL_BODY_ID, 334, -96, 8);
	const thruster: ThrusterEntity = {
		kind: "thruster",
		id: "demo-thruster",
		bodyId: DEMO_FINAL_BODY_ID,
		anchorX: 0,
		anchorY: 0,
		angle: 0,
		strength: 3000,
		on: true,
	};
	entities.push(thruster);

	// The end marker: a plain label the ball crosses.
	const finish: LabelEntity = {
		kind: "label",
		id: "demo-finish-label",
		x: DEMO_FINISH_X,
		y: -60,
		rot: 0,
		text: "FINISH",
	};
	entities.push(finish);

	return entities;
}

/**
 * Content bounds over a document's BODIES (labels/thrusters excluded — a
 * far-flung label must not drag the camera fit out), or null when there are
 * no bodies. Polygon points are centroid-local: their worst-case extent is
 * their farthest point, which overestimates a rotated hull slightly but is
 * exact enough for a camera fit. Pure; the camera-fit paths in main.ts use
 * it to center the demo scene on boot.
 */
export function demoSceneBounds(
	entities: readonly DocEntity[],
): { minX: number; minY: number; maxX: number; maxY: number } | null {
	let minX = Number.POSITIVE_INFINITY;
	let minY = Number.POSITIVE_INFINITY;
	let maxX = Number.NEGATIVE_INFINITY;
	let maxY = Number.NEGATIVE_INFINITY;
	for (const e of entities) {
		if (e.kind !== "body") continue;
		const shape = e.shape;
		let reach: number;
		if (shape.kind === "box") {
			reach = Math.hypot(shape.halfWidth, shape.halfHeight);
		} else if (shape.kind === "circle") {
			reach = shape.radius;
		} else {
			let far = 0;
			for (const p of shape.points) {
				far = Math.max(far, Math.hypot(p.x, p.y));
			}
			reach = far;
		}
		minX = Math.min(minX, e.x - reach);
		maxX = Math.max(maxX, e.x + reach);
		minY = Math.min(minY, e.y - reach);
		maxY = Math.max(maxY, e.y + reach);
	}
	if (minX === Number.POSITIVE_INFINITY) return null;
	return { minX, minY, maxX, maxY };
}
