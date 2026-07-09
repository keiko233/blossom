import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config: the main vite.config.ts loads the Cloudflare plugin, whose
// worker environments are incompatible with vitest's test environment.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
