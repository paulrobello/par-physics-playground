import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "e2e",
	testMatch: "**/*.pw.ts",
	workers: "50%",
	outputDir: "node_modules/.cache/ppg-playwright-results",
	use: {
		baseURL: "http://127.0.0.1:8114",
		channel: "chromium",
		// Scene JSON export drives a real browser download (e2e/scenes.pw.ts).
		acceptDownloads: true,
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
