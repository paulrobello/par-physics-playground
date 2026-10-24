# Par Physics Playground

A 2D physics sandbox for the desktop browser: draw shapes into a panable world, apply materials, join objects with pins, motors, springs and ropes, and build machines and Rube Goldberg contraptions.

Read [`PRD.md`](PRD.md) for the product requirements and phased plan; per-phase implementation plans live in [`plans/`](plans/).

## Development

Requires [bun](https://bun.sh) (pinned version: 1.4.4).

```sh
bun install            # bootstrap
make checkall          # fast gate: typecheck + lint + unit tests
make checkall-ci       # CI-parity gate: checkall + production build
make dev               # managed dev server on http://127.0.0.1:8113
make dev-stop          # stop the managed dev server
make clean             # stop the owned dev server, then remove build artifacts
```

Browser smoke tests run locally only (never in CI, per PRD D14). One-time prerequisite: `bunx playwright install chromium`. Then:

```sh
bunx playwright test   # boots its own dev server on port 8114
```

Visual-regression baselines for the HUD chrome (top bar, tool rail, context panel) also run locally only, in their own Playwright project on port 8116 (`DESIGN.md` is the contract they guard):

```sh
make visual           # compare against e2e-visual/__screenshots__/ baselines
make visual-update    # re-capture baselines after an intentional design change
```

CI (GitHub Actions) runs typecheck + lint + unit tests on every push and pull request. The `Deploy` workflow builds and publishes to GitHub Pages on every push to `main`.

Deployment: live at https://physics.pardev.net (DNS-only CNAME → `paulrobello.github.io`, custom domain registered on the repo, Actions-based Pages deploys).
