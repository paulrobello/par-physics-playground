# par-physics-playground

2D physics playground (Vite + TypeScript + Rapier2D). Live at https://physics.pardev.net via GitHub Actions Pages deploy on push to main.

## Git workflow — standing push approval

**Standing grant (Paul, 2026-10-25):** pushes to this project's own remote (`origin/main`) are pre-approved once the work is verified — no per-batch ask needed. This grant covers only pushes to this project's own origin; publishing to any registry, deleting, and force-pushes still need explicit confirmation, and the verification gate (`make checkall`, `make checkall-ci`, full `bunx playwright test` battery — e2e is NOT in checkall-ci) still applies before any push.
