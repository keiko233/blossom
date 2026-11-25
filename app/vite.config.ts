import { cloudflare } from "@cloudflare/vite-plugin";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { fileURLToPath } from "node:url";
import Icons from "unplugin-icons/vite";
import { defineConfig, loadEnv } from "vite";

import { clientEnvSchema, serverEnvSchema } from "./src/lib/env-schema.ts";

const DEPLOY_TARGETS = ["cloudflare", "vercel", "node"] as const;
type DeployTarget = (typeof DEPLOY_TARGETS)[number];

/**
 * Every target except Cloudflare is built by Nitro. The preset is pinned per
 * target (instead of relying on Nitro's provider auto-detection) so the same
 * `build:<target>` script gives the same output on a laptop, in CI and on the
 * host. Cloudflare keeps @cloudflare/vite-plugin: see "Cloudflare" in
 * docs/development/architecture.md#runtimes-and-deploy-targets for why.
 */
const NITRO_PRESETS = {
  vercel: "vercel",
  node: "node-server",
} as const satisfies Partial<Record<DeployTarget, string>>;

const deployTarget = (process.env.DEPLOY_TARGET ??
  "cloudflare") as DeployTarget;
if (!DEPLOY_TARGETS.includes(deployTarget)) {
  throw new Error(`Unknown DEPLOY_TARGET: ${process.env.DEPLOY_TARGET}`);
}
const isCloudflare = deployTarget === "cloudflare";

const config = defineConfig(({ mode, command }) => {
  const runtimeEnv = loadEnv(mode, import.meta.dirname, "");
  if (
    deployTarget === "cloudflare" &&
    command === "serve" &&
    runtimeEnv.DATABASE_URL
  ) {
    if (!process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE) {
      process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
        runtimeEnv.DATABASE_URL;
    }
    if (
      !process.env
        .CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH
    ) {
      process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH =
        runtimeEnv.DATABASE_URL;
    }
  }
  clientEnvSchema.parse(runtimeEnv); // client VITE_* vars are baked into the bundle -> validate at build
  if (command === "serve" && !process.env.SKIP_ENV_VALIDATION) {
    // dev-only fail-fast; production validates server env at runtime via getServerEnv() (src/lib/env.ts)
    serverEnvSchema.parse(runtimeEnv);
  }

  return {
    clearScreen: false,
    resolve: {
      alias: {
        "@/lib/database-connection": fileURLToPath(
          new URL(
            isCloudflare
              ? "./src/lib/database-connection.cloudflare.ts"
              : "./src/lib/database-connection.ts",
            import.meta.url,
          ),
        ),
        "@/lib/realtime-hub": fileURLToPath(
          new URL(
            isCloudflare
              ? "./src/lib/realtime-hub.cloudflare.ts"
              : "./src/lib/realtime-hub.ts",
            import.meta.url,
          ),
        ),
        "@/lib/pty-relay": fileURLToPath(
          new URL(
            isCloudflare
              ? "./src/lib/pty-relay.cloudflare.ts"
              : "./src/lib/pty-relay.ts",
            import.meta.url,
          ),
        ),
        "@/lib/admin-metrics-relay": fileURLToPath(
          new URL(
            isCloudflare
              ? "./src/lib/admin-metrics-relay.cloudflare.ts"
              : "./src/lib/admin-metrics-relay.ts",
            import.meta.url,
          ),
        ),
        "@/lib/email-transport": fileURLToPath(
          new URL(
            isCloudflare
              ? "./src/lib/email-transport.cloudflare.ts"
              : "./src/lib/email-transport.ts",
            import.meta.url,
          ),
        ),
        "@/durable-objects/agent-session": fileURLToPath(
          new URL(
            isCloudflare
              ? "./src/durable-objects/agent-session.cloudflare.ts"
              : "./src/durable-objects/agent-session.ts",
            import.meta.url,
          ),
        ),
      },
      tsconfigPaths: true,
    },
    plugins: [
      devtools(),
      paraglideVitePlugin({
        project: "./project.inlang",
        outdir: "./src/paraglide",
        strategy: ["cookie", "baseLocale"],
      }),
      // cloudflare plugin MUST come before tanstackStart (current working order)
      ...(deployTarget === "cloudflare"
        ? [cloudflare({ viteEnvironment: { name: "ssr" } })]
        : []),
      tailwindcss(),
      tanstackStart({
        importProtection: {
          include: [/^src\//, /^\.\.\/packages\//],
          client: { specifiers: ["@blossom/database/server"] },
        },
        router: {
          generatedRouteTree: `route-tree.gen.ts`,
          routeTreeFileHeader: [`/* oxlint-disable */`, `// @ts-nocheck`],
          routeFileIgnorePattern: "_modules",
        },
      }),
      // nitro goes AFTER tanstackStart per its docs
      ...(deployTarget === "cloudflare"
        ? []
        : [
            nitro({
              preset: NITRO_PRESETS[deployTarget],
              features: { websocket: true },
            }),
          ]),
      viteReact(),
      babel({
        presets: [reactCompilerPreset()],
      }),
      Icons({
        compiler: "jsx",
        jsx: "react",
      }),
    ],
  };
});

export default config;
