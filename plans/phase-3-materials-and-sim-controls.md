# Phase 3 — Materials and simulation controls

Depends on: `plans/phase-2-drawing-and-editing.md`. Implements PRD P3 / D5, D6.

## Tasks

### P3-T1 — Material data model and predefined palette
- Material entity: id, name, color, density, friction, restitution. Palette shipped: wood (0.25/0.7/0.2), stone (2.5/0.9/0.05), metal, rubber (high restitution), ice (near-zero friction), ink default — values provisional in the line-run tradition, tuned in review.
- Objects reference a material id; density × collider area derives mass and inertia (line-run pattern). Renderer colors shapes by material.
- **Verify**: unit tests for mass/inertia derivation from geometry + material; browser test draws two ramps, ice box slides far, rubber box bounces (position/bounce-count assertions). `make checkall`.
- **Depends on**: P1-T3 (parallel with P2 work).

### P3-T2 — Custom material editor
- Material panel: list palette + customs; create/edit (name, color picker, density/friction/restitution sliders with live value readouts); delete custom (objects fall back to ink); set active default material for new objects; "apply to selection" action.
- Custom materials stored in the scene document (survive undo snapshots) and persisted to browser storage for reuse (IndexedDB store, schema-versioned from day one — PRD R4).
- **Verify**: browser test creates a custom lead-like material, applies to a body, asserts it sinks vs a wood float; reload restores custom list; undo of "apply to selection" reverts the material. `make checkall`.
- **Depends on**: P3-T1.

### P3-T3 — Simulation controls panel: gravity and time-scale
- Gravity: direction dial + magnitude slider, presets (down, zero-g, moon), applied to the live world.
- Time-scale: 0.25×–2× slider acting on the accumulator feed rate (fixed tick unchanged).
- **Verify**: browser test flips gravity, resting box falls upward; zero-g box drifts; 0.5× advances half the sim time of 1× over the same wall clock (deterministic hook assertions). `make checkall`.
- **Depends on**: P1-T4.

### P3-T4 — Impeccable pass: toolbar, material panel, sim controls
- Run the `impeccable` skill over the accumulated UI: toolbar, panels, cursors, previews. Direction is fixed (D11): clean dark editor, subtle glows on hover/selection, hover lifts, soft shadows; no cream/italic/pill AI defaults.
- Produce DESIGN.md tokens sidecar per the impeccable workflow; all later UI work conforms.
- **Verify**: screenshot review against the direction contract by the impeccable finish-reviewer flow; browser visual-regression baselines captured for toolbar/panels. `make checkall`.
- **Depends on**: P2-T1, P3-T2, P3-T3 (runs once the UI surface exists).
