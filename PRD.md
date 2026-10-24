# Par Physics Playground — Product Requirements and Phased Plan

| | |
|---|---|
| **Product** | Par Physics Playground — 2D physics sandbox |
| **Repo** | `~/Repos/par-physics-playground` |
| **Owner** | Paul Robello |
| **Status** | Planning complete 2026-10-23. Implementation not yet authorized — run plans from `plans/` in a later session. |
| **Date** | 2026-10-23 |

## Overview

A freeform 2D physics sandbox for the desktop browser. The player draws shapes into a large panable world, assigns physics materials to them, connects objects with joints and constraints, and actuates machines with motors and thrusters. The core pleasure is building a machine — a cart, a catapult, a Rube Goldberg chain reaction — and watching real physics run it.

There are no goals, levels, or required progression. The sandbox is the product. An autonomous character is a stretch goal, explicitly out of the initial application.

Derived from an owner interview on 2026-10-23; all `D` decisions below are owner-confirmed.

## Goals

- **G1** — Pan/zoom a large (effectively unbounded) 2D world with a static ground plane.
- **G2** — A rich drawing toolset: box, circle, polygon, freehand stroke, line/beam, brush/chain, spring, text/label, terrain painting.
- **G3** — A material system: physics properties (density, friction, restitution) defined once as a named material and applied to objects. Predefined palette plus user-defined custom materials.
- **G4** — Joints and constraints to attach objects to each other and to the world: pin, motor, slider, spring, rod, weld, rope — enough to build working machines.
- **G5** — Actuation: motorized joints and thrusters, so machines move on their own.
- **G6** — Full simulation control: pause/play, single-step, gravity direction/strength, time-scale.
- **G7** — Comfortable at 500–1000 objects (rope segments count toward this).
- **G8** — Named scenes saved locally in the browser, plus JSON file import/export.
- **G9** — Complete editing: select, move, rotate, duplicate, delete, undo/redo.
- **G10** — Clean editor aesthetic built through the `impeccable` skill: subtle details, glows, hover lifts, shadows.
- **G11** — Deployed at `https://physics.pardev.net` on GitHub Pages.

## Non-Goals

Entirely out of scope:

- Multiplayer or world sharing beyond JSON files.
- Procedural art, generated audio, storybook presentation (this is not line-run).
- Mobile/touch as a first-class target (desktop first; touch is a later adaptation).

Deferred post-MVP (wanted, not in the first release — tracked as Open Questions):

- Gears and pulleys (no native Rapier2D joint; needs custom constraint work).
- Material extras: brittle/breakable, flammable, melting.
- Saving a group of parts as a re-usable assembly.
- An autonomous character (stretch goal).

## Confirmed decisions

| ID | Decision |
|---|---|
| D1 | Freeform creative sandbox. No autonomous character, objectives, or scoring in the initial app. |
| D2 | MVP line (owner-approved strawman): pan/zoom canvas, draw box/circle/freehand shapes, gravity on, one default material, drag-to-fling, pause/step. Materials editor, joints, save/load come after. |
| D3 | Full drawing toolset is in scope: box, circle, polygon, freehand, brush/chain, line/beam, spring, text/label, terrain painting. |
| D4 | Motors and thrusters first among actuators; then everything (springs, ropes, etc.). |
| D5 | Full sim controls: gravity toggle/direction, time-scale slider, single-step. |
| D6 | Materials: predefined palette plus user-defined customs (name, density, friction, restitution, color). Algodoo-style extras (brittle, flammable, melting) post-MVP. |
| D7 | Joint set: pin/revolute, motor (powered revolute with speed/torque), slider/prismatic, spring, rigid rod, weld, rope, pin-to-world. Gears and pulleys post-MVP. |
| D8 | Scenes: browser-local named saves plus JSON import/export. Storage engine is IndexedDB (1000-object scenes exceed localStorage limits). |
| D9 | Scale target 500–1000 objects; rope segments count heavily toward it. |
| D10 | Select/move/rotate, duplicate, delete, undo/redo are core. Group-as-reusable-assembly is post-MVP. |
| D11 | Clean editor aesthetic via the `impeccable` skill — lots of subtle detail: glows, hover lifts, shadows. Not a sketch/storybook look. |
| D12 | Stack: Vite + bun + TypeScript + Rapier2D (`@dimforge/rapier2d-compat`), rendered with plain Canvas2D (no three.js). |
| D13 | Canonical domain `https://physics.pardev.net` via GitHub Pages. |
| D14 | Full-depth local gate (`make checkall` / `make checkall-ci`); CI kept light (typecheck + lint + unit only; browser/perf tests run locally). |

## Reference projects

- **`line-run`** (owner-named starting point, examined directly): stack pairing (Vite + bun + TS + `@dimforge/rapier2d-compat` 0.21, biome, Playwright browser/perf configs, Makefile gate, `make dev`/`dev-stop` foreground lifecycle); fixed-step deterministic clock; freehand stroke cleanup (near-shape snap to circle/rectangle/triangle, concave triangulation); provisional safety limits pattern; PRD decision-table style; `?debug=1` deterministic-inspection hooks.
- **House conventions** (`~/.claude/skills/plan-idea/references/reference-projects.md`): phased PRD ladder, `make checkall` baked into Phase 0, GitHub Pages on `*.pardev.net` deploy recipe (DNS-only CNAME → committed `public/CNAME` → explicit Pages domain registration → live-render verification).
- **`the-cube`** (secondary, same family): rapier + Vite + bun + Playwright gate pattern, perf evidence docs under `docs/`.

## Architecture direction

- **Rendering**: single Canvas2D renderer. Shapes pre-rendered to offscreen sprite canvases per (shape, material) where possible; glow/shadow effects applied to selection and hover only — never per-object per-frame — so 1000 objects stay cheap.
- **Physics**: Rapier2D (WASM, compat build) behind a fixed-step accumulator clock in the line-run pattern. Deterministic single-advance debug hooks for tests.
- **Document model**: the scene is a serializable document (bodies, fixtures, materials, joints, camera). Simulation state is rebuildable from the document. This makes undo (snapshots at action boundaries, bounded stack), save/load, and JSON import/export one mechanism.
- **Materials**: data-only entities referenced by objects; custom materials live in the document so scenes carry their definitions.
- **Joints**: thin wrappers over Rapier joints plus a small custom-constraint seam reserved for post-MVP gears/pulleys.
- **UI**: DOM overlay panels (toolbar, material editor, sim controls) over the canvas; styled through the `impeccable` skill.
- **Tooling**: bun + Vite + TypeScript strict, biome, Bun unit tests, Playwright (hardware Chromium, platform GPU flags per house rules) for browser and perf configs. Makefile with `build/test/lint/fmt/typecheck/checkall/checkall-ci/clean/dev/dev-stop`. CI (GitHub Actions) runs typecheck + lint + unit only.

**Ports**: dev 8113, browser-test 8114 (registered in `~/.claude/used_ports.md`).

## Phases

### P0 — Foundation and gate
Scaffold the repo with the full toolchain and CI-light. Nothing playable.
**Acceptance**: `make checkall` and `make checkall-ci` green; CI runs typecheck + lint + unit on push; blank canvas app boots on port 8113; ports registered.

### P1 — World core (the MVP line)
Fixed-step Rapier simulation, camera pan/zoom with grid, static ground, box and circle placement with a default material, drag-to-fling, pause/play/single-step, deterministic debug hooks.
**Acceptance**: browser test places boxes/circles that settle under gravity, drag moves bodies with physics response, pause freezes the world, step advances exactly one tick; perf smoke holds 60fps with 200 bodies; the MVP strawman from D2 is demonstrable in a browser.

### P2 — Drawing tools and editing
Polygon, freehand stroke with line-run-style shape cleanup, line/beam, text/label, terrain painting (static geometry). Select/move/rotate, duplicate, delete, snapshot undo/redo.
**Acceptance**: every tool produces valid colliders (browser-verified); freehand cleanup snaps near-shapes and triangulates concaves; all edit operations work on arbitrary objects and are covered by undo/redo.

### P3 — Materials and simulation controls
Predefined palette (wood, metal, rubber, ice, stone), custom material editor (name, density, friction, restitution, color) with persistence, material application to selection and as default for new objects. Gravity direction/strength and time-scale panel.
**Acceptance**: browser test shows ice sliding where rubber bounces; a custom material survives reload; gravity flip inverts settling; time-scale runs 0.25×–2×.

### P4 — Joints and machines
Joint framework with visible joint rendering and attach UX; pin, weld, rigid rod, slider, motor (speed/torque control UI), spring, rope, pin-to-world; thruster force applicator; a built-in machine demo scene.
**Acceptance**: browser tests build and run a motorized cart (pins + wheels + motor) that drives across ground; a rope pendulum chain swings stably; a thruster pushes a body; deleting or undoing any object removes its joints cleanly; the demo scene loads and runs.

### P5 — Persistence, polish, performance, deployment
IndexedDB named scenes with rename/delete and autosave-restore of the last scene; JSON export/import; `impeccable` polish pass over all UI; perf qualification at 500 typical / 1000 stress objects; deploy to `physics.pardev.net`.
**Acceptance**: scenes save/load/delete and survive reload; an exported JSON re-imports to an equivalent simulation; perf gate green on hardware Chromium with load guards; the live page is verified rendered (not HTTP 200) at `https://physics.pardev.net`.

## Risks

| ID | Risk | Mitigation |
|---|---|---|
| R1 | Rapier2D WASM solver cost at 1000 bodies with many constraints (long rope chains especially) | Sleeping enabled, solver iteration budget measured in P1, perf gate gates P5 with a stress fixture; degrade rope segment counts if needed |
| R2 | Canvas2D glow/shadow effects are per-frame expensive | Pre-rendered sprites per shape/material; glows on selection/hover only; established as an architecture constraint from P0 |
| R3 | Undo correctness across jointed assemblies (deleting a body must remove joints) | Snapshot-based undo removes the whole class of partial-command bugs; explicit browser test in P4 |
| R4 | IndexedDB schema evolution as the document model grows | Versioned store with migration step from first release; document schema versioned in the JSON format |
| R5 | Scope creep: "all the drawing tools" plus joints plus materials is a large surface | Phased ladder keeps each phase independently demonstrable; post-MVP list holds gears, pulleys, extras, assemblies |
| R6 | Rapier2D has no native gear or pulley joint | Explicitly post-MVP; custom-constraint seam reserved in the joint framework design |

## Open Questions

Deferred post-MVP (owner wants, later releases):

1. Gears and pulleys — custom constraint vs emulation approach.
2. Material extras — brittle/breakable, flammable, melting.
3. Assembly format — saving a group of parts as a reusable stamped component.
4. Autonomous character — scope and behavior if attempted.
5. Touch/mobile interaction model.

None block the phased plan above.
