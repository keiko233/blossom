/**
 * Provider selection for transactional email. This module is deliberately
 * pure: the caller passes the environment values and whether the Cloudflare
 * `SEND_EMAIL` binding exists, so the same rules can be tested for every
 * runtime.
 */
export const EMAIL_PROVIDERS = ["resend", "smtp", "cloudflare"] as const;

export type EmailProvider = (typeof EMAIL_PROVIDERS)[number];

export interface EmailEnv {
  EMAIL_PROVIDER?: EmailProvider;
  EMAIL_FROM?: string;
  RESEND_API_KEY?: string;
  RESEND_MAIL_FROM?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: number;
  SMTP_SECURE?: boolean;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
}

export interface SmtpAuth {
  username: string;
  password: string;
}

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: SmtpAuth;
}

export type EmailConfig =
  | { provider: "resend"; from: string; apiKey: string }
  | { provider: "smtp"; from: string; smtp: SmtpConfig }
  | { provider: "cloudflare"; from: string };

export interface EmailAddress {
  email: string;
  name?: string;
}

/** A rendered message, independent of the provider that delivers it. */
export interface EmailMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Default SMTP ports: implicit TLS on 465, STARTTLS on 587. */
export function defaultSmtpPort(secure: boolean): number {
  return secure ? 465 : 587;
}

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Sender shared by every provider, with `RESEND_MAIL_FROM` as the legacy fallback. */
export function resolveEmailFrom(env: EmailEnv): string | undefined {
  return present(env.EMAIL_FROM) ?? present(env.RESEND_MAIL_FROM);
}

/**
 * `none` when auth is intentionally absent (unauthenticated relay), `complete`
 * when both credentials are set, and `incomplete` when only one is.
 */
export function getSmtpAuthStatus(
  env: EmailEnv,
): "none" | "complete" | "incomplete" {
  const username = present(env.SMTP_USER);
  const password = present(env.SMTP_PASSWORD);
  if (username && password) return "complete";
  if (!username && !password) return "none";
  return "incomplete";
}

export function resolveSmtpConfig(env: EmailEnv): SmtpConfig | null {
  const host = present(env.SMTP_HOST);
  if (!host) return null;
  if (getSmtpAuthStatus(env) === "incomplete") return null;

  const secure = env.SMTP_SECURE ?? false;
  const port = env.SMTP_PORT ?? defaultSmtpPort(secure);
  const username = present(env.SMTP_USER);
  const password = present(env.SMTP_PASSWORD);

  return {
    host,
    port,
    secure,
    auth: username && password ? { username, password } : undefined,
  };
}

/**
 * Resolves the active provider. An explicit `EMAIL_PROVIDER` never falls back
 * to another provider: if its own requirements are missing, the result is
 * `null`. Without it, Resend wins over SMTP, which wins over Cloudflare.
 */
export function resolveEmailConfig(
  env: EmailEnv,
  options: { hasCloudflareSendEmailBinding: boolean },
): EmailConfig | null {
  const from = resolveEmailFrom(env);
  if (!from) return null;

  const explicit = env.EMAIL_PROVIDER;
  if (explicit) {
    switch (explicit) {
      case "resend": {
        const apiKey = present(env.RESEND_API_KEY);
        return apiKey ? { provider: "resend", from, apiKey } : null;
      }
      case "smtp": {
        const smtp = resolveSmtpConfig(env);
        return smtp ? { provider: "smtp", from, smtp } : null;
      }
      case "cloudflare":
        return options.hasCloudflareSendEmailBinding
          ? { provider: "cloudflare", from }
          : null;
    }
  }

  const apiKey = present(env.RESEND_API_KEY);
  if (apiKey) return { provider: "resend", from, apiKey };

  const smtp = resolveSmtpConfig(env);
  if (smtp) return { provider: "smtp", from, smtp };

  if (options.hasCloudflareSendEmailBinding) {
    return { provider: "cloudflare", from };
  }

  return null;
}

/**
 * Parses `"Display Name <addr@example.com>"` or `"addr@example.com"` into the
 * structured address Cloudflare Email Service and worker-mailer accept.
 */
export function parseEmailAddress(value: string): EmailAddress {
  const trimmed = value.trim();
  const match = trimmed.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  if (match) {
    const name = match[1]!
      .trim()
      .replace(/^"(.*)"$/, "$1")
      .trim();
    const email = match[2]!.trim();
    return name ? { email, name } : { email };
  }
  return { email: trimmed };
}
