import z from "zod";

export enum DatabaseDriver {
  NeonHttp = "neon-http",
  NodePg = "node-postgres",
}

export const serverEnvSchema = z.object({
  APP_NAME: z.string().optional().default("Blossom"),
  DATABASE_URL: z.string(),
  DATABASE_DRIVER: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.enum(DatabaseDriver).optional(),
  ),
  RESEND_API_KEY: z.string().optional(),
  RESEND_MAIL_FROM: z.string().optional(),
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
  CLOUDFLARE_DNS_API_TOKEN: z.string().optional(),
  CLOUDFLARE_DNS_ZONE_ID: z.string().optional(),
});

export const clientEnvSchema = z.object({
  VITE_APP_NAME: z.string().optional().default("Blossom"),
});
