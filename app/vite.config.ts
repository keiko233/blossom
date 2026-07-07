import { cloudflare } from "@cloudflare/vite-plugin";
import { paraglideVitePlugin } from "@inlang/paraglide-js";
import babel from "@rolldown/plugin-babel";
import tailwindcss from "@tailwindcss/vite";
import { devtools } from "@tanstack/devtools-vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import Icons from "unplugin-icons/vite";
import { defineConfig, loadEnv } from "vite";

import { clientEnvSchema, serverEnvSchema } from "./src/lib/env-schema";

const config = defineConfig(({ mode }) => {
  const runtimeEnv = loadEnv(mode, import.meta.dirname, "");
  clientEnvSchema.parse(runtimeEnv);
  serverEnvSchema.parse(runtimeEnv);

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
        strategy: ["url", "baseLocale"],
      }),
      cloudflare({
        viteEnvironment: { name: "ssr" },
      }),
      tailwindcss(),
      tanstackStart({
        router: {
          generatedRouteTree: `route-tree.gen.ts`,
          routeTreeFileHeader: [`/* oxlint-disable */`],
          routeFileIgnorePattern: "_modules",
        },
      }),
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
