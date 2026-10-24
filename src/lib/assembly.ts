/**
 * Reusable assemblies: a NAMED snapshot of the current selection (bodies +
 * labels + joints whose BOTH endpoints are selected bodies), persisted to its
 * own IndexedDB store, and stamped back onto the canvas as a copy with FRESH
 * non-colliding ids. The record carries a whole SceneFile-shaped subset
 * document (the scene-file primitives: buildSceneFile's shape,
 * validateSceneFile's SCENE_BOUNDS gate), so a saved assembly, a reloaded
 * library, and a stamp all share one validated form.
 *
 * Id discipline (the review-C1 class of bug: a mint colliding with a restored
 * id silently REPLACES that body): capture stores the ORIGINAL ids (they are
 * the assembly's internal wiring); stamp NEVER reuses them — every stamped
 * entity mints a new id from the live counters (freshBodyId / freshJointId /
 * freshThrusterId) and joint endpoints remap through that id map, so two
 * stamps of the same assembly can never collide with each other or with the
 * scene.
 *
 * Geometry: the subset is normalized around the positioned entities' centroid
 * at capture, and re-translated to the stamp click point. Joint anchors are
 * body-LOCAL (makeJoint), so they survive translation unchanged — except a
 * WORLD-pinned anchorB (bodyB === null stores a world point), which moves
 * with the assembly.
 */
import type { DocEntity } from "./document";
import { freshBodyId, freshJointId, freshThrusterId } from "./interaction";
import { MATERIAL_PREDEFINED, type Material } from "./material";
import {
	SCENE_SCHEMA_VERSION,
	type SceneDoc,
	type SceneFile,
	validateSceneFile,
} from "./scene-file";
import type { DocumentId, PhysicsWorld } from "./world";

/** A saved reusable assembly: identity + display name + subset document. */
export interface Assembly {
	readonly id: string;
	readonly name: string;
	/** Validated subset document (bodies/labels/joints around origin). */
	readonly file: SceneFile;
}

export type AssemblyCaptureResult =
	| { ok: true; assembly: Assembly; entities: number }
	| { ok: false; error: string };

/**
 * Capture the selection as an assembly subset document. Positioned entities
 * (bodies/labels) come from `selectedIds`; joints join when BOTH endpoints are
 * selected bodies (a world-pinned joint has a non-body endpoint, so it stays
 * out). Thrusters are not part of the capture vocabulary. The custom
 * materials the captured bodies reference ride along (the buildSceneFile
 * rule); predefined palette entries stay implicit (they are code).
 */
export function captureAssembly(
	doc: SceneDoc,
	selectedIds: ReadonlySet<string>,
	name: string,
): AssemblyCaptureResult {
	const byId = new Map(doc.all().map((e) => [e.id, e]));
	const captured: DocEntity[] = [];
	const selectedPositioned = new Set<string>();
	for (const id of selectedIds) {
		const e = byId.get(id);
		if (e && (e.kind === "body" || e.kind === "label")) {
			captured.push(structuredClone(e));
			selectedPositioned.add(id);
		}
	}
	if (selectedPositioned.size === 0) {
		return {
			ok: false,
			error: "Select bodies or labels first — an assembly needs a selection",
		};
	}
	for (const e of doc.all()) {
		if (
			e.kind === "joint" &&
			e.bodyB !== null &&
			selectedPositioned.has(e.bodyA) &&
			selectedPositioned.has(e.bodyB)
		) {
			captured.push(structuredClone(e));
		}
	}

	// Normalize around the positioned entities' centroid; a world-pinned
	// anchorB moves with the assembly (it is the one joint coordinate that is
	// a world point rather than body-local), and a pulley's wheel is the
	// other one — it lives in the params record and shifts with the same
	// offset so the stamped rope still routes through the stamped wheel.
	let sx = 0;
	let sy = 0;
	for (const e of captured) {
		if (e.kind === "body" || e.kind === "label") {
			sx += e.x;
			sy += e.y;
		}
	}
	const cx = sx / selectedPositioned.size;
	const cy = sy / selectedPositioned.size;
	const entities = captured.map((e) => {
		if (e.kind === "body" || e.kind === "label")
			return { ...e, x: e.x - cx, y: e.y - cy };
		if (e.kind === "joint" && e.bodyB === null)
			return { ...e, anchorB: { x: e.anchorB.x - cx, y: e.anchorB.y - cy } };
		if (e.kind === "joint" && e.params.kind === "pulley")
			return {
				...e,
				params: {
					...e.params,
					wheelX: e.params.wheelX - cx,
					wheelY: e.params.wheelY - cy,
				},
			};
		return e;
	});

	const predefined = new Set(MATERIAL_PREDEFINED.map((m) => m.id));
	const referencedIds = new Set(
		entities
			.filter(
				(e): e is Extract<DocEntity, { kind: "body" }> => e.kind === "body",
			)
			.map((e) => e.materialId),
	);
	const customMaterials: Material[] = doc
		.allMaterials()
		.filter((m) => !predefined.has(m.id) && referencedIds.has(m.id))
		.map((m) => ({ ...m }));

	const candidate: SceneFile = {
		schemaVersion: SCENE_SCHEMA_VERSION,
		entities,
		customMaterials,
		savedAt: Date.now(),
	};
	const check = validateSceneFile(candidate);
	if (!check.ok)
		return { ok: false, error: `Assembly rejected: ${check.error}` };
	return {
		ok: true,
		assembly: { id: "", name, file: check.file },
		entities: entities.length,
	};
}

/**
 * Stamp a copy of an assembly's subset document at world point (cx, cy),
 * centered there. Every spawned entity takes a FRESH id from the live
 * minters; joint endpoints (and a thruster's mount) remap through the id map
 * so the copy is internally consistent and collision-free. Returns the spawned
 * ids (bodies, labels, joints); the undo boundary belongs to the caller (the
 * onSpawnFreehand precedent: beginAction before, recordAction after).
 */
export function stampAssembly(
	world: PhysicsWorld,
	file: SceneFile,
	cx: number,
	cy: number,
): DocumentId[] {
	const positioned = file.entities.filter(
		(e) => e.kind === "body" || e.kind === "label",
	);
	if (positioned.length === 0) return [];
	let sx = 0;
	let sy = 0;
	for (const e of positioned) {
		sx += e.x;
		sy += e.y;
	}
	const dx = cx - sx / positioned.length;
	const dy = cy - sy / positioned.length;

	// Custom materials register first (the applySceneFile rule: file wins on a
	// colliding id), so stamped bodies resolve their materialId.
	for (const material of file.customMaterials) {
		if (!world.doc.updateMaterial(material)) world.doc.addMaterial(material);
	}

	const idMap = new Map<string, DocumentId>();
	const spawned: DocumentId[] = [];
	// Bodies and labels first (the rebuild invariant: bodies before joints).
	for (const e of file.entities) {
		if (e.kind === "body") {
			const id = freshBodyId();
			idMap.set(e.id, id);
			world.spawnEntity({
				...structuredClone(e),
				id,
				x: e.x + dx,
				y: e.y + dy,
			});
			spawned.push(id);
		} else if (e.kind === "label") {
			const id = freshBodyId();
			idMap.set(e.id, id);
			world.addLabel(id, e.x + dx, e.y + dy);
			world.setLabelText(id, e.text);
			spawned.push(id);
		}
	}
	for (const e of file.entities) {
		if (e.kind === "joint") {
			const bodyA = idMap.get(e.bodyA);
			if (!bodyA) continue;
			let bodyB: DocumentId | null = null;
			if (e.bodyB !== null) {
				const mapped = idMap.get(e.bodyB);
				if (!mapped) continue;
				bodyB = mapped;
			}
			const id = freshJointId();
			const ok = world.spawnJoint({
				...structuredClone(e),
				id,
				bodyA,
				bodyB,
				anchorB:
					e.bodyB === null
						? { x: e.anchorB.x + dx, y: e.anchorB.y + dy }
						: structuredClone(e.anchorB),
				params:
					e.params.kind === "pulley"
						? {
								...e.params,
								wheelX: e.params.wheelX + dx,
								wheelY: e.params.wheelY + dy,
							}
						: e.params,
			});
			if (ok) spawned.push(id);
		} else if (e.kind === "thruster") {
			// Not part of the capture vocabulary, but a SceneFile can legally
			// carry one — stamp it consistently rather than silently dropping it.
			const bodyId = idMap.get(e.bodyId);
			if (!bodyId) continue;
			const id = freshThrusterId();
			if (world.spawnThruster({ ...structuredClone(e), id, bodyId }))
				spawned.push(id);
		}
	}
	return spawned;
}
