# Phase 1 — World core (the MVP line)

Depends on: `plans/phase-0-foundation.md`. Implements PRD P1 (decision D2: the owner-approved MVP strawman).

Install now: `@dimforge/rapier2d-compat@0.21.0`.

## Tasks

### P1-T1 — Fixed-step simulation core
- Rapier2D world behind a fixed-step accumulator clock (line-run pattern): fixed tick (e.g. 60Hz, configurable constant), render interpolation optional but clock structure supports it.
- Ground: static collider line at y=0 spanning a very large extent; kill threshold below which bodies are removed.
- Body registry mapping document IDs → Rapier handles.
- `?debug=1` hooks: `advanceTime(ms)` single-step control for deterministic tests.
- **Verify**: unit tests for the accumulator (exact tick counts, no drift, pause excludes time); browser test using `advanceTime` asserts a dropped box settles on the ground deterministically (position within tolerance across two runs).
- **Depends on**: P0-T2.

### P1-T2 — Camera: pan, zoom, grid, world coordinates
- Camera transform (pan via space-drag/middle-drag or two-finger trackpad, zoom via wheel, unbounded pan, clamped zoom); screen↔world conversion utilities.
- Subtle grid rendered in world space that fades by zoom level (impeccable aesthetic applies even here: soft grid, no harsh lines); ground line rendered distinctly.
- **Verify**: unit tests for coordinate transforms round-trip; browser test pans and zooms and re-queries a world point under the cursor. `make checkall`.
- **Depends on**: P0-T2 (parallel with P1-T1).

### P1-T3 — Box/circle placement with default material, drag-to-fling
- Toolbar skeleton (DOM overlay): Select tool, Box tool, Circle tool.
- Click-drag to size a box/circle with live preview (glow on the preview); release commits a dynamic body with the default material (ink-like: density 1, friction 0.5, restitution 0.1 — provisional, from line-run's values).
- Select + drag a body: mouse joint pulling with physical response while running; escape releases. Objects render filled with their material color, soft shadow, hover lift.
- **Verify**: browser test draws a box and circle, both settle under gravity; drag moves a resting box and it falls again on release. `make checkall`.
- **Depends on**: P1-T1, P1-T2.

### P1-T4 — Pause/play/step + perf smoke
- Sim control cluster in the top bar (D15): pause/play, single-step (advances exactly one tick via the debug advance path), reset world (clears dynamic bodies).
- Perf smoke config (`playwright.perf`-style in the line-run pattern): spawn 200 boxes, measure 1000 frames after warmup, hardware Chromium with platform GPU flags, load guards before/after (host 1-min load ≤ 15).
- **Verify**: browser test pauses mid-fall (positions frozen), steps once (advances exactly one tick); perf smoke reports 60fps at 200 bodies and the gate fails below target. `make checkall`.
- **Depends on**: P1-T1, P1-T3.
