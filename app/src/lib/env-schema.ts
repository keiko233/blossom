import { DatabaseDriver } from "@blossom/database/driver";
import z from "zod";
export {
  DatabaseDriver,
  supportsInteractiveTransactions,
} from "@blossom/database/driver";

export const serverEnvSchema = z.object({
  APP_NAME: z.string().optional().default("Blossom"),
  DATABASE_URL: z.string(),
  DATABASE_DRIVER: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.enum(DatabaseDriver).optional(),
  ),
  EMAIL_PROVIDER: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.enum(["resend", "smtp", "cloudflare"]).optional(),
  ),
  EMAIL_FROM: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  RESEND_MAIL_FROM: z.string().optional(),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.coerce.number().int().min(1).max(65535).optional(),
  ),
  SMTP_SECURE: z.preprocess((val) => {
    if (val === "" || val === undefined || val === null) return undefined;
    if (val === true || val === "true") return true;
    if (val === false || val === "false") return false;
    return val;
  }, z.boolean().optional()),
  SMTP_USER: z.string().optional(),
  SMTP_PASSWORD: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  BETTER_AUTH_URL: z
    .string()
    .url()
    .refine(
      (val) => {
        const url = new URL(val);
        if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
          return true;
        }
        return url.protocol === "https:";
      },
      {
        message:
          "BETTER_AUTH_URL must use https:// in production (localhost http is allowed for development)",
      },
    ),
  CERTIFICATE_MASTER_KEY: z.string().optional(),
  ACME_EAB_KID: z.string().optional(),
  ACME_EAB_HMAC_KEY: z.string().optional(),
  CLOUDFLARE_DNS_API_TOKEN: z.string().optional(),
  CLOUDFLARE_DNS_ZONE_ID: z.string().optional(),
  // Bootstrap resolver for server sing-box configs (and peer hostnames). It is
  // an IP literal, since a hostname here would need the resolver it names.
  SING_BOX_BOOTSTRAP_DNS_TYPE: z.enum(["tls", "udp", "local"]).default("tls"),
  SING_BOX_BOOTSTRAP_DNS_SERVER: z
    .union([z.ipv4(), z.ipv6()])
    .default("8.8.8.8"),
  // Optional shared backplane for agent WebSocket fan-out across Node/Vercel
  // instances. Cloudflare uses the AgentSessionDO binding instead.
  REDIS_URL: z.string().url().optional(),
  /** Scheduler-only bearer token for bounded maintenance routes. */
  MAINTENANCE_TOKEN: z.string().min(16).optional(),
});

export const clientEnvSchema = z.object({
  VITE_APP_NAME: z.string().optional().default("Blossom"),
});
