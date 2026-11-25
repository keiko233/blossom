import { env } from "cloudflare:workers";
import { WorkerMailer } from "worker-mailer";

import {
  parseEmailAddress,
  type EmailMessage,
  type SmtpConfig,
} from "./email-config";

export function hasCloudflareSendEmailBinding(): boolean {
  return Boolean(env.SEND_EMAIL);
}

export async function sendSmtpEmail(
  config: SmtpConfig,
  message: EmailMessage,
): Promise<void> {
  const mailer = await WorkerMailer.connect({
    host: config.host,
    port: config.port,
    secure: config.secure,
    startTls: !config.secure,
    credentials: config.auth,
    authType: ["plain", "login", "cram-md5"],
  });

  try {
    await mailer.send({
      from: parseEmailAddress(message.from),
      to: parseEmailAddress(message.to),
      subject: message.subject,
      html: message.html,
      text: message.text,
    });
  } finally {
    await mailer.close();
  }
}

/**
 * Cloudflare Email Service structured API. `SEND_EMAIL` is an optional binding
 * declared in `wrangler.jsonc`; the caller has already checked it exists.
 */
export async function sendCloudflareEmail(
  message: EmailMessage,
): Promise<void> {
  const binding = env.SEND_EMAIL;
  if (!binding) {
    throw new Error("Cloudflare Email Service binding is not configured");
  }

  await binding.send({
    from: parseEmailAddress(message.from),
    to: parseEmailAddress(message.to),
    subject: message.subject,
    html: message.html,
    text: message.text,
  });
}
