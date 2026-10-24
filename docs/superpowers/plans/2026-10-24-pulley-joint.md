# Pulley Joint Implementation Plan

> **STATUS (2026-10-24, post-implementation): SHIPPED — historical plan; the
> text below is preserved as written. Final decisions that superseded it:**
> the panel params are READ-ONLY (rope length locks at placement — no length
> edit was authorized); the solver is a one-sided VELOCITY-LEVEL impulse
> solve (`solvePulleyImpulse`), not the PD force sketch; the effective mass
> is angular-aware (per body `1/m + (r×û)²/I`, assembled in world.ts); static
> endpoints contribute ZERO inverse mass via Rapier's own invMass/invI (no
> fake finite 1e9); and assembly capture/stamp translate the wheel point
> explicitly (body-local anchors stay put). See `src/lib/pulley.ts`,
> `applyPulleyTension` in `src/lib/world.ts`, and
> `.superpowers/sdd/2026-10-24-pulley-joint/task-1-report.md`.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fixed pulley joint — two bodies on an inextensible rope over a fixed wheel point; a falling weight yanks the light body up.

**Architecture:** Force-based custom constraint in the seam reserved by PRD R6 (Rapier 0.21 has no pulley joint): a per-tick one-sided PD solve (`pulley.ts`, pure + unit-tested) applies tension impulses at both rope anchors from `PhysicsWorld.step()` (the thruster precedent). The pulley is a new `JointParams` record `{ kind: "pulley", wheelX, wheelY, length }` riding the existing joint document machinery — undo, save/load, assemblies, removal cascades come free. Placement extends the joint tool with a third click (wheel point).

**Tech Stack:** TypeScript strict, Rapier2D-compat 0.21 (no new dependency), bun test, Playwright e2e.

**Spec:** Approved design in session 2026-10-24 (kanban card `01a16fe70ea077699c1c9b9078d4b5cd` notes): wheel = fixed world point in params, not a body; rope length locks at placement path length; anchors body-local (rotate with bodies); one-sided rope (pulls only); thin-line rendering + wheel glyph; panel gets rope-length edit.

## Global Constraints

- `make checkall` green after each phase; `make checkall-ci` before merge.
- Per-mass constants convention (rod precedent): PULLEY_STIFFNESS_PER_MASS = 1600, PULLEY_DAMPING_PER_MASS = 80 (ω = 40 rad/s, ω·dt ≈ 0.67 at 60 Hz — inside semi-implicit stability window).
- No per-frame allocations in render/sim walk paths (PRD P5 allocation card): iterate via `doc.eachJoint`, no Set/Map churn.
- PRD R2: glow is selection-only; the pulley draw follows the joint glyph rules (accent color, selection glow).
- Id namespace: the pulley is a normal joint entity — `freshJointId()` mints it; no new minter.

## Review Focus

- Both bodies asleep at placement → tension must wake them (`applyImpulseAtPoint` wake=true, thruster precedent).
- Wheel dragged onto/near a body's anchor (degenerate side length < 1e-6) → zero tension, never NaN (test pinned).
- A pulley whose endpoint body is deleted → removal cascade destroys the joint like any joint (existing machinery; e2e deletes one).
- Save/load round-trip: pulley entity survives buildSceneFile/applySceneFile and still pulls (unit test).
- Zoom extremes: wheel glyph + lines stay screen-constant size (line width /zoom; radius via jointGlyphRadius).

---

### Task 1: Placement math + constraint solve (pure core)

**Files:**
- Modify: `src/lib/joint.ts` (JointType, JointParams pulley record, PlaceableJointKind, isPlaceableJointKind, JOINT_TYPE_LABELS, makePlacedJoint wheel param)
- Create: `src/lib/pulley.ts`
- Test: `tests/unit/pulley.test.ts`

**Interfaces:**
- Consumes: existing `makePlacedJoint` signature; new optional 9th param `wheel?: Vec2`.
- Produces: `solvePulleyTension(input: {ax,ay,bx,by,wx,wy,avx,avy,bvx,bvy,ma,mb,length}): number` (≥ 0); constants `PULLEY_STIFFNESS_PER_MASS = 1600`, `PULLEY_DAMPING_PER_MASS = 80`; params record `{ kind: "pulley"; wheelX: number; wheelY: number; length: number }`.

- [ ] **Step 1: Write failing tests** — `tests/unit/pulley.test.ts` describe blocks "pulley placement math" and "solvePulleyTension" (already drafted in the worktree).
- [ ] **Step 2: Run** `bun test tests/unit/pulley.test.ts` — expect FAIL (module/type missing).
- [ ] **Step 3: Implement.** Solve: `c = dA + dB − length`; slack `c ≤ 0 → 0`; else `T = mEff·(k·c + d·ċ)`, clamp ≥ 0; `ċ = vA·ûA + vB·ûB` (û from wheel to anchor); `mEff = 1/(1/ma + 1/mb)`; degenerate side `d < 1e-6 → 0`; `ma/mb ≤ 0` treated as 1e9 (static).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(pulley): placement math + one-sided force solve (pure core)`.

### Task 2: Sim wiring

**Files:**
- Modify: `src/lib/world.ts` (spawnJoint early pulley branch — no Rapier joint; `applyPulleyForces()` in `step()` after `applyThrusters()`)

**Interfaces:**
- Consumes: Task 1 solve + params record.
- Produces: spawnJoint accepts pulley (returns true, doc-adds, no impulse joint); each tick applies `T·SIM_DT_SECONDS` impulses at both world anchors toward the wheel (`applyImpulseAtPoint`, wake=true).

- [ ] **Step 1: Write failing physics tests** (describe "pulley physics (fixed-step sim)": weight exchange, static endpoint, slack/re-tension, NaN guard).
- [ ] **Step 2: Run** — expect FAIL.
- [ ] **Step 3: Implement** world wiring.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `feat(pulley): per-tick tension in step(); spawnJoint branch`.

### Task 3: Tool flow + rendering + panel

**Files:**
- Modify: `src/lib/tools.ts` (new `joint-arming-b` phase; pointerDown second-click branch for pulley; pointerMove curX/curY; preview; onPlaceJoint spec gains `wheelX?/wheelY?`)
- Modify: `src/lib/interaction.ts` (pass wheel through to makePlacedJoint)
- Modify: `src/main.ts` (forEachJoint adapter passes wheel coords; listPickableJoints uses wheel for pulleys)
- Modify: `src/renderer.ts` (pulley draw: two lines + wheel circle, selection glow)
- Modify: `src/lib/joint-panel.ts` (pulley controls: rope length input + wheel readout)

**Interfaces:**
- Consumes: Task 1 params record; existing radio-kind rail (add a "pulley" button in index.html if kinds are enumerated there).
- Produces: three-click placement (body A → body B → wheel anywhere); pickable wheel glyph.

- [ ] **Step 1: Check index.html for the joint-kind button list; add pulley.**
- [ ] **Step 2: Implement tool flow** (second click on empty space aborts arming like the self-joint precedent; third click fires placement).
- [ ] **Step 3: Implement adapter/renderer/panel.**
- [ ] **Step 4: Run `make checkall`** — expect PASS.
- [ ] **Step 5: Commit** `feat(pulley): three-click placement, wheel rendering, panel controls`.

### Task 4: E2E, round-trip proof, gates

**Files:**
- Create: `e2e/pulley.pw.ts`
- Test: extend `tests/unit/pulley.test.ts` with a buildSceneFile/applySceneFile round-trip.
- Modify: `PRD.md` post-MVP section (pulley shipped).

**Interfaces:**
- Consumes: everything above through the REAL tool radio + clicks.

- [ ] **Step 1: Unit round-trip test** (buildSceneFile → applySceneFile → fresh world still exchanges weights).
- [ ] **Step 2: e2e**: select joint tool, pick pulley kind, click A, click B, click wheel; run sim; assert light rose; delete an endpoint body → joint gone; reload autosave → pulley persists.
- [ ] **Step 3: Full gates**: `make checkall`, full e2e suite, `make checkall-ci`, visual baselines (`make visual-update` if renderer diff accepted).
- [ ] **Step 4: Commit** `test(pulley): e2e + round-trip; PRD post-MVP update`.

---

**Execution:** in-session (native), one fresh whole-branch reviewer before merge.
