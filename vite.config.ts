import { defineConfig } from "vite";

export default defineConfig({
	server: { host: "127.0.0.1", port: 8113, strictPort: true },
	preview: { host: "127.0.0.1", port: 8115, strictPort: true },
	build: {
		// Rapier's WASM+JS is ~3 MB and changes rarely — its own long-cached
		// chunk keeps app-code deploys small (P5 pre-deploy finding).
		rollupOptions: {
			output: {
				manualChunks(id: string) {
					return id.includes("@dimforge/rapier2d-compat")
						? "rapier"
						: undefined;
				},
			},
		},
	},
});
