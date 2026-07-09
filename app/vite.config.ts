import { cloudflare } from "@cloudflare/vite-plugin";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import netlify from "@netlify/vite-plugin-tanstack-start";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import Icons from "unplugin-icons/vite";
import { defineConfig, loadEnv } from "vite";

import { clientEnvSchema, serverEnvSchema } from "./src/lib/env-schema";

const DEPLOY_TARGETS = ["cloudflare", "netlify", "vercel", "node"] as const;
type DeployTarget = (typeof DEPLOY_TARGETS)[number];

const deployTarget = (process.env.DEPLOY_TARGET ??
  "cloudflare") as DeployTarget;
if (!DEPLOY_TARGETS.includes(deployTarget)) {
  throw new Error(`Unknown DEPLOY_TARGET: ${process.env.DEPLOY_TARGET}`);
}

const config = defineConfig(({ mode, command }) => {
  const runtimeEnv = loadEnv(mode, import.meta.dirname, "");
  clientEnvSchema.parse(runtimeEnv); // client VITE_* vars are baked into the bundle -> validate at build
  if (command === "serve" && !process.env.SKIP_ENV_VALIDATION) {
    // dev-only fail-fast; production validates server env at runtime via getServerEnv() (src/lib/env.ts)
    serverEnvSchema.parse(runtimeEnv);
  }

  return {
    clearScreen: false,
    resolve: {
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
        router: {
          generatedRouteTree: `route-tree.gen.ts`,
          routeTreeFileHeader: [`/* oxlint-disable */`],
          routeFileIgnorePattern: "_modules",
        },
      }),
      // netlify / nitro plugins go AFTER tanstackStart per their docs
      ...(deployTarget === "netlify" ? [netlify()] : []),
      ...(deployTarget === "vercel" || deployTarget === "node"
        ? [
            nitro({
              preset: deployTarget === "vercel" ? "vercel" : "node-server",
            }),
          ]
        : []),
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
