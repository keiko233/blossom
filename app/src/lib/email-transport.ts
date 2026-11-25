import nodemailer from "nodemailer";

import type { EmailMessage, SmtpConfig } from "./email-config";

/** Node and Vercel have no Cloudflare Email Service binding. */
export function hasCloudflareSendEmailBinding(): boolean {
  return false;
}

export async function sendSmtpEmail(
  config: SmtpConfig,
  message: EmailMessage,
): Promise<void> {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.auth
      ? { user: config.auth.username, pass: config.auth.password }
      : undefined,
  });

  try {
    await transport.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } finally {
    transport.close();
  }
}

/**
 * Cloudflare Workers Mail is unavailable off Cloudflare. The Cloudflare build
 * aliases this module away; this fallback only fails cleanly.
 */
export async function sendCloudflareEmail(
  _message: EmailMessage,
): Promise<void> {
  throw new Error("Cloudflare Email Service is not available on this runtime");
}
