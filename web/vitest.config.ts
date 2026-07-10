import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		env: {
			TZ: "America/New_York",
		},
	},
	resolve: {
		alias: {
			"@": path.resolve(__dirname),
		},
	},
});
