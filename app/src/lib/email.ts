import { APIError } from "better-auth/api";
import { createElement } from "react";
import type React from "react";
import { render } from "react-email";
import { Resend } from "resend";

import {
  hasCloudflareSendEmailBinding,
  sendCloudflareEmail,
  sendSmtpEmail,
} from "@/lib/email-transport";
import MagicLinkEmail from "@/templates/emails/magic-link";
import PasswordResetEmail from "@/templates/emails/password-reset";

import {
  resolveEmailConfig,
  type EmailConfig,
  type EmailMessage,
  type EmailProvider,
} from "./email-config";
import { getServerEnv } from "./env";

/**
 * Resolves the provider on every call, not at module load: Cloudflare reads the
 * `SEND_EMAIL` binding from the request's `env`, which only exists at runtime.
 */
export function getConfiguredEmailConfig(): EmailConfig | null {
  return resolveEmailConfig(getServerEnv(), {
    hasCloudflareSendEmailBinding: hasCloudflareSendEmailBinding(),
  });
}

export function isEmailEnabled(): boolean {
  return getConfiguredEmailConfig() !== null;
}

export function getConfiguredEmailProvider(): EmailProvider | null {
  return getConfiguredEmailConfig()?.provider ?? null;
}

/** What a caller (and, over HTTP, the client) sees when no link could be sent. */
export const MAGIC_LINK_UNAVAILABLE_MESSAGE =
  "Email sign-in is currently unavailable";

const unavailable = () =>
  new APIError("SERVICE_UNAVAILABLE", {
    message: MAGIC_LINK_UNAVAILABLE_MESSAGE,
    code: "EMAIL_UNAVAILABLE",
  });

async function renderMessage(
  element: React.ReactElement,
): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([
    render(element),
    render(element, { plainText: true }),
  ]);
  return { html, text };
}

/**
 * Delivers one already-rendered message. Failure reasons are not inspected or
 * forwarded: providers can echo the address, the link or credentials in their
 * errors, so the caller only ever sees a generic `APIError`.
 */
async function deliver(
  config: EmailConfig,
  message: EmailMessage,
): Promise<void> {
  switch (config.provider) {
    case "resend": {
      const client = new Resend(config.apiKey);
      const { error } = await client.emails.send({
        from: message.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      if (error) throw new Error("Resend returned an error");
      return;
    }
    case "smtp":
      await sendSmtpEmail(config.smtp, message);
      return;
    case "cloudflare":
      await sendCloudflareEmail(message);
      return;
  }
}

/**
 * Emails a sign-in link, or throws a generic `APIError` so the request fails
 * instead of reporting a send that never happened. Every magic-link entry
 * point goes through better-auth's `sendMagicLink`, so this one function covers
 * them all, including the public `/sign-in/magic-link` endpoint.
 *
 * The link is a bearer credential and everything the provider or its client
 * returns or throws (message, name, status) is untrusted and can echo request
 * details. None of it is logged or put in the thrown error: the log gets only
 * fixed messages.
 */
export async function sendMagicLinkEmail(data: {
  email: string;
  url: string;
}): Promise<void> {
  const config = getConfiguredEmailConfig();

  if (!config) {
    console.warn("Magic-link email not sent: email is not configured");
    throw unavailable();
  }

  const element = createElement(MagicLinkEmail, {
    email: data.email,
    link: data.url,
  });

  try {
    const rendered = await renderMessage(element);
    const subject = `Welcome to ${getServerEnv().APP_NAME}! Here's your link`;
    await deliver(config, {
      from: config.from,
      to: data.email,
      subject,
      ...rendered,
    });
  } catch {
    console.error("Magic-link email delivery failed: the provider call threw");
    throw unavailable();
  }
}

/**
 * Emails a password-reset link, or throws a generic `APIError`. The caller
 * (`createPasswordRecovery`) swallows the failure so a delivery problem cannot
 * tell a requester whether the address has an account; the unconfigured case
 * is refused earlier for every address alike.
 *
 * The link carries a single-use bearer token. Like the magic-link sender, this
 * logs only fixed messages and puts nothing from the provider into the error.
 */
export async function sendPasswordResetEmail(data: {
  email: string;
  url: string;
}): Promise<void> {
  const config = getConfiguredEmailConfig();

  if (!config) {
    console.warn("Password reset email not sent: email is not configured");
    throw unavailable();
  }

  const element = createElement(PasswordResetEmail, { link: data.url });

  try {
    const rendered = await renderMessage(element);
    const subject = `Reset your ${getServerEnv().APP_NAME} password`;
    await deliver(config, {
      from: config.from,
      to: data.email,
      subject,
      ...rendered,
    });
  } catch {
    console.error(
      "Password reset email delivery failed: the provider call threw",
    );
    throw unavailable();
  }
}
