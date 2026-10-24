# Phase 5 — Persistence, polish, performance, deployment

Depends on: `plans/phase-4-joints-and-machines.md`. Implements PRD P5 / D8, G10, G11.

## Tasks

### P5-T1 — Scene persistence (IndexedDB)
- Named scenes: save (serialize document incl. materials and joints), load, rename, delete; scene list UI; autosave of the working scene and restore on load; schema versioned with a migration step.
- **Verify**: browser test: build mixed scene (bodies, custom material, joint, thruster) → save → reload page → list shows scene → load → document round-trips equal (structural compare) and sim resumes equivalently. `make checkall`.
- **Depends on**: P2-T5, P3-T2, P4-T4.

### P5-T2 — JSON import/export
- Export current document to a `.json` file download; import from file with validation and defensive bounds (coordinate/width limits in the line-run tradition); import errors are visible, never silent.
- **Verify**: browser test exports, wipes, imports, and structurally compares; malformed file import shows a visible error and leaves the world untouched. `make checkall`.
- **Depends on**: P5-T1.

### P5-T3 — Performance qualification: 500 typical / 1000 stress
- Stress fixtures: 500 mixed bodies typical case; 1000-case including 300+ rope segments across chains plus jointed assemblies. Perf harness in the house pattern: production build preview, 1000 frames after warmup, one worker, hardware Chromium with platform GPU flags, host-load guards (≤15) before and after, software renderer rejected.
- Budget: 60fps typical; stress case target 60fps with a documented floor (e.g. 45fps) — measured, not estimated; tuning (sleeping, rope segment caps, solver iterations) until within budget.
- **Verify**: perf gate green with before/after load averages recorded in `docs/verification/perf.md`; failing numbers keep the card open (no estimate-based closure). `make checkall-ci`.
- **Depends on**: P4-T5.

### P5-T4 — Impeccable full-UI polish pass
- `impeccable` skill over the complete product: all tools, panels, scene management, demo loader, empty states, cursors. Conform to the P3-T4 DESIGN.md tokens; extend only within the established direction.
- **Verify**: impeccable finish-reviewer returns no material fixes; visual-regression suite updated and green. `make checkall`.
- **Depends on**: P3-T4, P5-T1, P5-T2.

### P5-T5 — Deploy to physics.pardev.net
- House recipe, in order: (1) DNS-only CNAME `physics.pardev.net` → `paulrobello.github.io` in Cloudflare (token from parvault); (2) then commit `public/CNAME` containing `physics.pardev.net`; (3) explicit domain registration `PUT /repos/paulrobello/par-physics-playground/pages`; (4) no Vite `base` change; (5) verify by live browser render of the page (not HTTP 200); HTTPS may sit in `authorization_pending` briefly.
- Deploy workflow: GitHub Actions builds and publishes on push to main (Actions deploys satisfy the CI/CD preference; no local publish).
- **Verify**: `https://physics.pardev.net` renders the app in a real browser (screenshot evidence); a second push deploys green. `make checkall-ci` before requesting push approval.
- **Depends on**: P5-T1, P5-T2, P5-T3, P5-T4.
