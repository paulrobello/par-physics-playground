.PHONY: build test fmt lint typecheck checkall checkall-ci visual visual-update clean dev dev-stop

build:
	bun run build

test:
	bun run test

fmt:
	bunx biome format --write src tests scripts *.ts

lint:
	bun run lint

typecheck:
	bun run typecheck

checkall: typecheck lint test

checkall-ci: checkall build

# Visual-regression baselines for the HUD chrome — local-only (D14).
visual:
	bunx playwright test --config playwright.visual.config.ts

visual-update:
	bunx playwright test --config playwright.visual.config.ts --update-snapshots

clean:
	@test ! -f .par-physics-playground-dev.pid || bun run dev-stop
	rm -rf dist node_modules .par-physics-playground-dev.pid

dev:
	bun run dev-managed

dev-stop:
	bun run dev-stop
