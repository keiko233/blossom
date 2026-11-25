import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config: the main vite.config.ts loads the Cloudflare plugin, whose
// worker environments are incompatible with vitest's test environment.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@/lib/realtime-hub": fileURLToPath(
        new URL("./src/lib/realtime-hub.ts", import.meta.url),
      ),
      "@/lib/email-transport": fileURLToPath(
        new URL("./src/lib/email-transport.ts", import.meta.url),
      ),
      "@/durable-objects/agent-session": fileURLToPath(
        new URL("./src/durable-objects/agent-session.ts", import.meta.url),
      ),
    },
  },
  test: {
    server: { deps: { inline: ["better-auth"] } },
    environment: "node",
    include: ["src/**/*.test.ts", "../packages/*/src/**/*.test.ts"],
  },
});
