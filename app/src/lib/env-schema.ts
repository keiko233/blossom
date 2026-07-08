import z from "zod";

export enum DatabaseDriver {
  NeonHttp = "neon-http",
  NodePg = "node-postgres",
}

export const serverEnvSchema = z.object({
  // APP Name
  APP_NAME: z.string().optional().default("Blossom"),
  // Database URL
  DATABASE_URL: z.string(),
  // Database driver; defaults to neon-http for *.neon.tech URLs, node-postgres otherwise
  DATABASE_DRIVER: z.preprocess(
    (val) => (val === "" ? undefined : val),
    z.enum(DatabaseDriver).optional(),
  ),
  // Resend Email API Key
  RESEND_API_KEY: z.string().optional(),
  RESEND_MAIL_FROM: z.string().optional(),
  // GitHub Authentication
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  // Google Authentication
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
});

// Client-side env vars must be prefixed with VITE_ to be exposed to the client-side code.
export const clientEnvSchema = z.object({
  // APP Name
  VITE_APP_NAME: z.string().optional().default("Blossom"),
});
