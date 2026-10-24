# Phase 2 — Drawing tools and editing

Depends on: `plans/phase-1-world-core.md`. Implements PRD P2 / D3, D10 (editing core).

## Tasks

### P2-T1 — Select/move/rotate, delete, duplicate
- Select tool: click to select (glow outline), drag to move (frozen-position move while paused uses kinematic set; while running uses the P1 mouse joint), rotate handle or R-drag; Delete key and toolbar button; Duplicate (offset copy).
- Multi-select via rubber-band rectangle; move/delete/duplicate operate on the selection set.
- **Verify**: browser tests select, move, rotate, duplicate (two bodies, one moved independently), delete (body gone from physics query). `make checkall`.
- **Depends on**: P1-T3.

### P2-T2 — Polygon and line/beam tools
- Polygon: click to place vertices, click near start or Enter to close; live preview; closed polygon becomes one body (convex) or triangulated parts (concave).
- Line/beam: two-click (or drag) straight segment with a width property; becomes a thin capsule/box body. Shift-constraint to horizontal/vertical/45° in the line-run pattern.
- **Verify**: browser test creates a triangle, an L-shaped concave polygon (verifies multi-part triangulation rests stably), and a beam; all collide correctly. `make checkall`.
- **Depends on**: P1-T3 (parallel with P2-T1).

### P2-T3 — Freehand tool with shape cleanup
- Freehand stroke capture (pointer samples, decimation); on release, cleanup in the line-run pattern: snap near-circle / near-rectangle / near-triangle; small closure overlaps and retraces cleaned within visible tolerance; other valid closed shapes keep their freeform silhouette, concaves triangulated. Open strokes behave as chain of rounded segments (beam-like).
- **Verify**: browser tests draw approximate circle/rect/triangle and assert the committed collider is the cleaned primitive (vertex-count/shape assertions); a concave blob rests stably. `make checkall`.
- **Depends on**: P1-T3 (parallel with P2-T1/P2-T2).

### P2-T4 — Text/label and terrain painting
- Text/label: place a non-physical (or optionally static-fixed) label with editable text; renders in world space.
- Terrain paint: rectangle/polygon placement mode producing static (infinite-mass) geometry for building worlds; static bodies render with a distinct ground-like treatment.
- **Verify**: browser test adds a static ramp and asserts a rolling box is deflected; label renders and survives pan/zoom. `make checkall`.
- **Depends on**: P1-T3 (parallel).

### P2-T5 — Snapshot undo/redo
- Snapshot the serializable scene document at action boundaries (shape commit, delete, duplicate, move-end, rotate-end, material apply later in P3); bounded stack (~50). Undo/redo via Cmd+Z / Cmd+Shift+Z and toolbar.
- World rebuild from document snapshot (destroy + recreate Rapier state) — acceptable for a sandbox at this scale; measure rebuild time in tests.
- **Verify**: browser test: draw box → draw circle → undo (circle gone, box present) → redo (circle back); undo after delete restores the body; 60 rapid actions stay within the bound without leaking (body-count assertion). `make checkall`.
- **Depends on**: P2-T1 (needs all mutation actions to route through the snapshot boundary API).
