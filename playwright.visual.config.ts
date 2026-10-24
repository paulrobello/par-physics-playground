import { defineConfig } from "@playwright/test";

// Visual-regression suite for the HUD chrome (P3-T4). Local-only per D14 —
// CI stays light (typecheck + lint + unit). Port 8116 is reserved for this
// suite in ~/.claude/used_ports.md. Baselines live beside these tests in
// e2e-visual/__screenshots__/. Update command (documented in README):
//   bunx playwright test --config playwright.visual.config.ts --update-snapshots
export default defineConfig({
	testDir: "e2e-visual",
	testMatch: "**/*.vw.ts",
	workers: 1,
	outputDir: "node_modules/.cache/ppg-playwright-visual-results",
	snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
	use: {
		baseURL: "http://127.0.0.1:8116",
		channel: "chromium",
		viewport: { width: 1440, height: 900 },
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
		command: "bunx vite --host 127.0.0.1 --port 8116 --strictPort",
		url: "http://127.0.0.1:8116",
		reuseExistingServer: false,
		timeout: 30_000,
	},
});
