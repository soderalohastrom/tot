import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// A CLI: no DOM, no browser layout. Plain node is the right environment
		// (jsdom/happy-dom would only mask real Node fs/os/path behavior we test).
		environment: "node",
		setupFiles: ["./test/setup.ts"],
		include: ["test/**/*.test.ts"],
	},
});
