# Phase 4 — Joints and machines

Depends on: `plans/phase-3-materials-and-sim-controls.md`. Implements PRD P4 / D4, D7.

Rapier2D mapping (compat 0.21): pin = revolute joint; motor = revolute with configured motor (target velocity + max torque); slider = prismatic (optionally motored); rod = rope joint with min=max=length (or stiff spring — implementer picks, verify stability); spring = spring-damped constraint (generic joint stiffness/damping); weld = fixed joint; rope = segment chain of small bodies joined by rope joints (line-run rope heritage). Gears/pulleys explicitly excluded (post-MVP).

## Tasks

### P4-T1 — Joint framework, rendering, attach UX
- Joint document entities (type, bodyA anchor, bodyB anchor or world point, per-type params) with a registry beside the body registry; Rapier joint creation/rebuild from document (undo/save depend on this).
- Joint tool UX: click first body → click second body (or empty space = world anchor) → joint placed at second click with visible anchor markers; joint params panel on selection.
- Rendering: distinct icon/glyph per joint type at the anchor (subtle glow, impeccable tokens).
- A reserved custom-constraint seam in the framework (interface only) for post-MVP gears/pulleys (PRD R6).
- **Verify**: unit tests for anchor math (local pivots, world anchors); browser test places a pin between two boxes and asserts constrained relative rotation. `make checkall`.
- **Depends on**: P2-T1, P2-T5.

### P4-T2 — Pin, weld, rod, slider
- Implement the four passive joints over the framework with param panels (rod length, slider axis/limits).
- **Verify**: browser tests: pinned box swings as a pendulum from a world anchor; welded pair moves rigidly; rod pair keeps exact distance; slider pair translates only on-axis within limits. `make checkall`.
- **Depends on**: P4-T1.

### P4-T3 — Motor joint and control UI
- Motor (powered revolute): target velocity, max torque, toggle; control UI in the joint params panel plus a per-motor on/off affordance directly on the canvas marker.
- **Verify**: browser test builds a motorized wheel on a static body, asserts sustained rotation at target velocity under load; torque limit stalls the motor when obstructed. `make checkall`.
- **Depends on**: P4-T2.

### P4-T4 — Spring and rope
- Spring: stiffness/damping params, renders as a coil between anchors.
- Rope: freehand stroke placement converted to a segment chain (D18), with shift angle-snaps to horizontal/vertical/45° (anchored at the last freehand point, line-run pattern) and endpoint capture onto bodies/world. Bounded segment count per chain and total (provisional limits per D17); rope rendered as a continuous curve.
- **Verify**: browser test: spring oscillator period scales with stiffness; rope bridge sags under a dropped box and holds it; chain total limits reject excess placement visibly. `make checkall`.
- **Depends on**: P4-T2.

### P4-T5 — Thruster and machine demo scene
- Thruster: attachable force applicator (direction arrow glyph, strength param, on/off) applying continuous force at its anchor.
- Built-in demo scene: a Rube Goldberg starter — ramp, motorized conveyor, dominoes, rope-and-counterweight lift, thruster kick at the end — loadable from the top bar, and preloaded on first run with an obvious "New empty world" action (D16; first-run flag persisted).
- **Verify**: browser test runs the demo scene end-to-end (deterministic hooks): the final object reaches the end marker; deleting any machine part leaves no orphan joints; undo restores the machine. `make checkall`.
- **Depends on**: P4-T3, P4-T4.
