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
import { defineConfig, loadEnv, type Plugin } from "vite";

import { clientEnvSchema, serverEnvSchema } from "./src/lib/env-schema";

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

/**
 * tsyringe (pulled in by @peculiar/x509 v1, which acme-client depends on)
 * throws at module-evaluation time unless a Reflect metadata polyfill is
 * already installed. Bundlers hoist/merge chunks, so an `import
 * "reflect-metadata"` placed in app code (or a dynamic import before the
 * x509 import) cannot guarantee ordering: the chunk that contains x509 is
 * evaluated as soon as any static importer (acme-client) loads. Making the
 * polyfill a real dependency of tsyringe's entry module lets the bundler
 * order it correctly on every deploy target.
 */
function tsyringeReflectMetadata(): Plugin {
  return {
    name: "blossom:tsyringe-reflect-metadata",
    enforce: "pre",
    transform: {
      filter: {
        id: /[\\/]tsyringe[\\/]dist[\\/](esm5|esm2015)[\\/]index\.js$/,
      },
      handler(code) {
        return { code: `import "reflect-metadata";\n${code}`, map: null };
      },
    },
  };
}

const config = defineConfig(({ mode, command }) => {
  const runtimeEnv = loadEnv(mode, import.meta.dirname, "");
  if (
    deployTarget === "cloudflare" &&
    command === "serve" &&
    runtimeEnv.DATABASE_URL &&
    !process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE
  ) {
    process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE =
      runtimeEnv.DATABASE_URL;
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
      tsyringeReflectMetadata(),
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
