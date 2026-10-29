export type DeployRuntime =
  | "cloudflare"
  | "vercel"
  | "netlify"
  | "node"
  | "unknown";

/**
 * Best-effort guess of where the server is running. The build-time
 * `DEPLOY_TARGET` is not available at runtime, so this looks at what each host
 * exposes: Workers set `navigator.userAgent`, Vercel and Netlify set marker
 * environment variables. Informational only; never branch behaviour on it.
 */
export function detectRuntime(input: {
  userAgent?: string | null;
  env?: Readonly<Record<string, string | undefined>>;
  hasNodeProcess?: boolean;
}): DeployRuntime {
  if (input.userAgent === "Cloudflare-Workers") return "cloudflare";
  const env = input.env ?? {};
  if (env.VERCEL) return "vercel";
  if (env.NETLIFY) return "netlify";
  return input.hasNodeProcess === false ? "unknown" : "node";
}
