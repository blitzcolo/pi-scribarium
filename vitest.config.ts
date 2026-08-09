import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		// Integration tests drive real agent sessions against a scripted provider;
		// they are slower than unit tests but must never reach the network.
		testTimeout: 30_000,
	},
});
