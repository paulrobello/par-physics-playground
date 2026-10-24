import { defineConfig } from "@playwright/test";

/**
 * Local-only perf gate (D14): never part of `make checkall`/CI. Separate from
 * the main Playwright config so its long-running measurement never runs with
 * the regular e2e suite. Run explicitly:
 *
 *   bunx playwright test --config playwright.perf.config.ts
 */
export default defineConfig({
	testDir: "perf",
	testMatch: "**/*.pw.ts",
	workers: 1,
	outputDir: "node_modules/.cache/ppg-playwright-perf-results",
	use: {
		baseURL: "http://127.0.0.1:8114",
		channel: "chromium",
		// Headed: headless Chromium throttles rAF (~14 Hz measured 2026-10-24,
		// while the same page ran 120 fps headed) — a timing harness must not
		// measure the throttle (house browser rule: headed when the
		// measurement requires it).
		headless: false,
		launchOptions: {
			args:
				process.env.PW_GPU === "swiftshader"
					? ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]
					: process.platform === "darwin"
						? ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
						: ["--enable-gpu", "--ignore-gpu-blocklist"],
		},
	},
	webServer: {
		command: "bunx vite --host 127.0.0.1 --port 8114 --strictPort",
		url: "http://127.0.0.1:8114",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
