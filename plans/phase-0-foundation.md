# Phase 0 — Foundation and gate

Depends on: none. Implements PRD P0.

Pinned versions (from line-run, verified pairing): bun (runtime), `typescript@7.0.2`, `vite@8.3.5`, `@biomejs/biome@2.6.2`, `@playwright/test@1.64.1`, `@types/bun@1.4.3`, `@dimforge/rapier2d-compat@0.21.0` (installed in P1, not now). No three.js anywhere.

Ports: dev 8113, browser-test 8114 (already registered in `~/.claude/used_ports.md`).

## Tasks

### P0-T1 — Repo scaffold, Makefile gate, CI light
- `package.json` (type module, private) with scripts: `dev` (vite `--host 127.0.0.1 --port 8113 --strictPort`), `build`, `test` (bun unit), `typecheck` (tsc --noEmit), `lint` (biome check), `format` (biome format --write). Dependency versions pinned above in devDependencies; no runtime deps yet.
- `tsconfig.json` strict, `vite.config.ts` minimal, `index.html`, `biome.json`.
- Makefile targets: `build`, `test`, `lint`, `fmt`, `typecheck`, `checkall` (typecheck + lint + test), `checkall-ci` (checkall + `vite build`), `clean`, `dev`, `dev-stop` (foreground lifecycle in the line-run pattern with PID identity check and port release wait).
- GitHub Actions workflow (`.github/workflows/ci.yml`): typecheck + lint + unit only. No browser tests in CI (D14).
- Unit test example (one trivial test) so the `test` script is real.
- **Verify**: `make checkall` exit 0 and `make checkall-ci` exit 0 (capture real exit codes, no pipelines without pipefail); CI green on first push (verify in Actions UI).
- **Depends on**: none.

### P0-T2 — Canvas app skeleton, HUD placeholder, debug hooks seam
- `src/main.ts` boots a full-viewport Canvas2D canvas with devicePixelRatio handling and a resize observer; a DOM HUD placeholder (top bar) rendering "Par Physics Playground".
- Renderer module with a clear frame loop (rAF) that only clears and draws a placeholder; no simulation yet.
- `?debug=1` flag parsed and stored (hooks added in P1).
- **Verify**: `make dev` serves on 8113; Playwright smoke test loads the page headless-hardware and asserts the canvas element and HUD text; `make checkall` green.
- **Depends on**: P0-T1.
