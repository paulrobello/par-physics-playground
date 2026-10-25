/**
 * Joint params panel (P4-T1 skeleton, P4-T2 fills in per-type controls, PRD
 * D15/D19): the right context panel gains a section that appears when the
 * selection contains a joint, showing the type, endpoints, and live anchor
 * position, with a delete action — plus, per type, editable params: rod
 * length (number input), slider axis readout + translation limits. Every
 * params edit routes through `world.updateJointParams` inside ONE undo
 * boundary. The section APPENDS to #context-panel (the material panel owns
 * its own children; neither clobbers the other), and `refresh()` is called
 * from the frame loop — cheap: it only touches the DOM when the shown joint
 * or its data changes.
 */
import { JOINT_TYPE_LABELS, type JointParams } from "./joint";
import { clampThrusterDuration, type ThrusterEntity } from "./thruster";
import type { ToolSession } from "./tools";
import type { UndoStack } from "./undo";
import type { PhysicsWorld } from "./world";

export interface JointPanelDeps {
	/** The context panel host (a section is appended to it). */
	host: HTMLElement;
	world: PhysicsWorld;
	session: ToolSession;
	undo: UndoStack;
}

/**
 * Attach the joint panel section. Returns a per-frame `refresh()` (compare
 * cheap state, touch DOM only on change) — main.ts wires it into the rAF
 * flow. Joints are shown in document order (first selected joint wins).
 */
export function attachJointPanel(deps: JointPanelDeps): () => void {
	const { world, session, undo } = deps;
	const section = document.createElement("section");
	section.className = "joint-panel";
	section.hidden = true;
	deps.host.append(section);
	section.innerHTML = `
		<h2>Joint</h2>
		<p class="joint-field" data-joint-type></p>
		<p class="joint-field" data-joint-bodies></p>
		<p class="joint-field" data-joint-anchor></p>
		<div class="joint-params" data-joint-params></div>
		<button type="button" class="joint-btn" data-joint-delete>Delete joint</button>
	`;
	const typeEl = section.querySelector<HTMLElement>("[data-joint-type]");
	const bodiesEl = section.querySelector<HTMLElement>("[data-joint-bodies]");
	const anchorEl = section.querySelector<HTMLElement>("[data-joint-anchor]");
	const paramsEl = section.querySelector<HTMLElement>("[data-joint-params]");
	if (!typeEl || !bodiesEl || !anchorEl || !paramsEl)
		throw new Error("joint panel: missing fields");

	section
		.querySelector<HTMLButtonElement>("[data-joint-delete]")
		?.addEventListener("click", () => {
			const id = shownEntityId();
			if (!id) return;
			undo.beginAction();
			// removeBody delegates joint ids to removeJoint and removes mounted
			// thrusters with their body (the P4-T5 cascade).
			world.removeBody(id);
			undo.commit();
		});

	/** The first selected joint, else the first selected thruster. */
	const shownEntityId = (): string | undefined => {
		for (const id of session.selectedIds) {
			const e = world.doc.get(id);
			if (e?.kind === "joint" || e?.kind === "thruster") return id;
		}
		return undefined;
	};

	/** Apply a params edit inside ONE undo boundary (doc + sim update). */
	const applyParams = (id: string, params: JointParams): void => {
		undo.beginAction();
		world.updateJointParams(id, params);
		undo.commit();
	};

	/** Apply a thruster edit inside ONE undo boundary. */
	const applyThruster = (
		id: string,
		patch: Partial<
			Pick<ThrusterEntity, "strength" | "on" | "angle" | "duration">
		>,
	): void => {
		undo.beginAction();
		world.updateThruster(id, patch);
		undo.commit();
	};

	/**
	 * Rebuild the per-type controls. The caller guards with the
	 * params-signature key, so a rebuild never interrupts the user typing in
	 * an input. Pin/weld have no editable params — the readouts are the panel.
	 */
	const buildParamsControls = (id: string, params: JointParams): void => {
		paramsEl.innerHTML = "";
		if (params.kind === "rod") {
			paramsEl.innerHTML = `
				<label class="joint-field">Length
					<input type="number" step="1" min="1" data-rod-length value="${params.length}" />
				</label>
			`;
			paramsEl
				.querySelector<HTMLInputElement>("[data-rod-length]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value > 0)
						applyParams(id, { kind: "rod", length: value });
				});
		} else if (params.kind === "slider") {
			const deg = (x: number, y: number): number =>
				(Math.round((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
			paramsEl.innerHTML = `
				<p class="joint-field">Axis (local): ${deg(params.axisX, params.axisY)}°</p>
				<label class="joint-field">Min
					<input type="number" step="1" data-slider-min value="${params.min}" />
				</label>
				<label class="joint-field">Max
					<input type="number" step="1" data-slider-max value="${params.max}" />
				</label>
			`;
			paramsEl
				.querySelector<HTMLInputElement>("[data-slider-min]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value < params.max)
						applyParams(id, { ...params, min: value });
				});
			paramsEl
				.querySelector<HTMLInputElement>("[data-slider-max]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value > params.min)
						applyParams(id, { ...params, max: value });
				});
		} else if (params.kind === "motor") {
			// Motor controls (P4-T3): drive params + the on/off toggle. Each
			// edit routes through applyParams (ONE undo boundary; the impulse
			// joint is replaced with the new motor config).
			paramsEl.innerHTML = `
				<label class="joint-field">Target velocity (rad/s)
					<input type="number" step="0.5" data-motor-vel value="${params.targetVelocity}" />
				</label>
				<label class="joint-field">Max torque
					<input type="number" step="100" min="0" data-motor-torque value="${params.maxTorque}" />
				</label>
				<label class="joint-field">
					<input type="checkbox" data-motor-on ${params.on ? "checked" : ""} />
					Running
				</label>
			`;
			paramsEl
				.querySelector<HTMLInputElement>("[data-motor-vel]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value))
						applyParams(id, { ...params, targetVelocity: value });
				});
			paramsEl
				.querySelector<HTMLInputElement>("[data-motor-torque]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value >= 0)
						applyParams(id, { ...params, maxTorque: value });
				});
			paramsEl
				.querySelector<HTMLInputElement>("[data-motor-on]")
				?.addEventListener("change", (ev) => {
					const on = (ev.target as HTMLInputElement).checked;
					applyParams(id, { ...params, on });
				});
		} else if (params.kind === "spring") {
			// Spring controls (P4-T4): rest length plus the per-mass
			// stiffness/damping (ω = √stiffness; ζ = damping / (2√stiffness)).
			paramsEl.innerHTML = `
				<label class="joint-field">Rest length
					<input type="number" step="1" min="0" data-spring-rest value="${params.restLength}" />
				</label>
				<label class="joint-field">Stiffness (per mass)
					<input type="number" step="5" min="1" data-spring-stiff value="${params.stiffness}" />
				</label>
				<label class="joint-field">Damping (per mass)
					<input type="number" step="0.5" min="0" data-spring-damp value="${params.damping}" />
				</label>
			`;
			paramsEl
				.querySelector<HTMLInputElement>("[data-spring-rest]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value >= 0)
						applyParams(id, { ...params, restLength: value });
				});
			paramsEl
				.querySelector<HTMLInputElement>("[data-spring-stiff]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value > 0)
						applyParams(id, { ...params, stiffness: value });
				});
			paramsEl
				.querySelector<HTMLInputElement>("[data-spring-damp]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value >= 0)
						applyParams(id, { ...params, damping: value });
				});
		} else if (params.kind === "rope") {
			// Rope link controls (P4-T4): the link's rest length, edited like
			// a rod length (each rope link is its own joint entity).
			paramsEl.innerHTML = `
				<label class="joint-field">Link length
					<input type="number" step="0.5" min="0.1" data-rope-length value="${params.length}" />
				</label>
			`;
			paramsEl
				.querySelector<HTMLInputElement>("[data-rope-length]")
				?.addEventListener("change", (ev) => {
					const value = (ev.target as HTMLInputElement).valueAsNumber;
					if (Number.isFinite(value) && value > 0)
						applyParams(id, { kind: "rope", length: value });
				});
		} else if (params.kind === "gear" || params.kind === "belt") {
			paramsEl.innerHTML = `
				<p class="joint-field">Radius ratio (A/B): ${params.ratio.toFixed(3)}</p>
				<p class="joint-field">Drive: ${params.kind === "gear" ? "Opposite spins (mesh)" : "Same-direction (belt)"}</p>
				<p class="joint-field">Delete and re-place to change the ratio.</p>
			`;
		} else if (params.kind === "pulley") {
			// Pulley readouts (post-MVP): rope length and wheel coordinates are
			// READ-ONLY — the approved design locks the length at placement and
			// the wheel is a scene attachment; neither is panel-editable.
			paramsEl.innerHTML = `
				<p class="joint-field">Rope length: ${params.length.toFixed(1)}</p>
				<p class="joint-field">Wheel: ${params.wheelX.toFixed(1)}, ${params.wheelY.toFixed(1)}</p>
			`;
		}
	};

	/**
	 * Thruster controls (P4-T5): strength number + the on/off checkbox, each
	 * edit inside ONE undo boundary via updateThruster. The Angle field (the
	 * aiming affordance) edits the body-local direction in DEGREES — 0 points
	 * along +x in the body's frame, rotating with the body like the mount
	 * anchor.
	 */
	const buildThrusterControls = (id: string, entity: ThrusterEntity): void => {
		const angleDeg = Math.round((entity.angle * 180) / Math.PI);
		paramsEl.innerHTML = `
			<label class="joint-field">Force
				<input type="number" step="500" min="0" data-thruster-strength value="${entity.strength}" />
			</label>
			<label class="joint-field">Angle (°, body-local)
				<input type="number" step="15" data-thruster-angle value="${angleDeg}" />
			</label>
			<label class="joint-field">Duration (s)
				<input type="number" step="0.01" min="0" max="600" placeholder="∞" data-thruster-duration value="${entity.duration ?? ""}" />
			</label>
			<label class="joint-field">
				<input type="checkbox" data-thruster-on ${entity.on ? "checked" : ""} />
				Thrusting
			</label>
		`;
		paramsEl
			.querySelector<HTMLInputElement>("[data-thruster-strength]")
			?.addEventListener("change", (ev) => {
				const value = (ev.target as HTMLInputElement).valueAsNumber;
				if (Number.isFinite(value) && value >= 0)
					applyThruster(id, { strength: value });
			});
		paramsEl
			.querySelector<HTMLInputElement>("[data-thruster-angle]")
			?.addEventListener("change", (ev) => {
				const value = (ev.target as HTMLInputElement).valueAsNumber;
				if (Number.isFinite(value))
					applyThruster(id, { angle: (value * Math.PI) / 180 });
			});
		// Duration (Paul, 2026-10-25): empty clears the limit (∞ placeholder);
		// a value normalizes through clampThrusterDuration (2-decimal
		// precision, 0.01–600 s) — undefined patches are a doc.replace with
		// the field dropped, so the entity stays rebuild-exact.
		paramsEl
			.querySelector<HTMLInputElement>("[data-thruster-duration]")
			?.addEventListener("change", (ev) => {
				const input = ev.target as HTMLInputElement;
				if (input.value.trim() === "") {
					applyThruster(id, { duration: undefined });
					return;
				}
				const value = clampThrusterDuration(input.valueAsNumber);
				applyThruster(id, { duration: value });
				if (value !== undefined) input.value = String(value);
			});
		paramsEl
			.querySelector<HTMLInputElement>("[data-thruster-on]")
			?.addEventListener("change", (ev) => {
				const on = (ev.target as HTMLInputElement).checked;
				applyThruster(id, { on });
			});
	};

	let lastKey = "";
	let lastParamsKey = "";

	/** Per-frame refresh; call from the rAF flow (main.ts). */
	return () => {
		const id = shownEntityId();
		if (!id) {
			if (lastKey !== "") {
				lastKey = "";
				section.hidden = true;
			}
			return;
		}
		const entity = world.doc.get(id);
		if (!entity || (entity.kind !== "joint" && entity.kind !== "thruster")) {
			return;
		}
		const anchor =
			entity.kind === "joint"
				? world.jointWorldAnchor(entity)
				: world.thrusterPose(entity);
		const paramsKey = JSON.stringify(
			entity.kind === "joint" ? entity.params : entity,
		);
		const key = `${id}:${paramsKey}:${anchor ? `${anchor.x.toFixed(2)},${anchor.y.toFixed(2)}` : ""}`;
		if (key === lastKey) return;
		const typeChanged = !lastKey.startsWith(`${id}:`);
		lastKey = key;
		section.hidden = false;
		const heading = section.querySelector<HTMLElement>("h2");
		if (heading)
			heading.textContent = entity.kind === "joint" ? "Joint" : "Thruster";
		typeEl.textContent =
			entity.kind === "joint"
				? `Type: ${JOINT_TYPE_LABELS[entity.jointType]}`
				: `Mounted on: ${entity.bodyId}`;
		bodiesEl.textContent =
			entity.kind === "joint"
				? `Bodies: ${entity.bodyA}${entity.bodyB ? ` ↔ ${entity.bodyB}` : " ↔ world"}`
				: `Force: ${entity.strength}`;
		anchorEl.textContent = anchor
			? `Anchor: ${anchor.x.toFixed(1)}, ${anchor.y.toFixed(1)}`
			: "Anchor: (culled)";
		// Rebuild the per-type controls only when the joint or its params
		// actually changed (a pure anchor move must not clobber the inputs).
		if (typeChanged || paramsKey !== lastParamsKey) {
			lastParamsKey = paramsKey;
			if (entity.kind === "joint") buildParamsControls(id, entity.params);
			else buildThrusterControls(id, entity);
		}
	};
}
