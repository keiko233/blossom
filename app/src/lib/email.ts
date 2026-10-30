import { APIError } from "better-auth/api";
import { createElement } from "react";
import { Resend } from "resend";

import MagicLinkEmail from "@/templates/emails/magic-link";
import PasswordResetEmail from "@/templates/emails/password-reset";

import { getServerEnv } from "./env";

const serverEnv = getServerEnv();

export const isEmailEnabled =
  Boolean(serverEnv.RESEND_API_KEY) && Boolean(serverEnv.RESEND_MAIL_FROM);

export const getEmailClient = () => {
  if (isEmailEnabled) {
    return new Resend(serverEnv.RESEND_API_KEY!);
  }

  return null;
};

/** What a caller (and, over HTTP, the client) sees when no link could be sent. */
export const MAGIC_LINK_UNAVAILABLE_MESSAGE =
  "Email sign-in is currently unavailable";

const unavailable = () =>
  new APIError("SERVICE_UNAVAILABLE", {
    message: MAGIC_LINK_UNAVAILABLE_MESSAGE,
    code: "EMAIL_UNAVAILABLE",
  });

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
  const emailClient = getEmailClient();

  if (!emailClient) {
    console.warn(
      "Magic-link email not sent: email is not configured (RESEND_API_KEY, RESEND_MAIL_FROM)",
    );
    throw unavailable();
  }

  let failed: boolean;
  try {
    const { error } = await emailClient.emails.send({
      from: serverEnv.RESEND_MAIL_FROM!,
      to: data.email,
      subject: `Welcome to ${serverEnv.APP_NAME}! Here's your link`,
      react: createElement(MagicLinkEmail, {
        email: data.email,
        link: data.url,
      }),
    });
    failed = Boolean(error);
  } catch {
    console.error("Magic-link email delivery failed: the provider call threw");
    throw unavailable();
  }

  if (failed) {
    console.error(
      "Magic-link email delivery failed: the provider returned an error",
    );
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
  const emailClient = getEmailClient();

  if (!emailClient) {
    console.warn(
      "Password reset email not sent: email is not configured (RESEND_API_KEY, RESEND_MAIL_FROM)",
    );
    throw unavailable();
  }

  let failed: boolean;
  try {
    const { error } = await emailClient.emails.send({
      from: serverEnv.RESEND_MAIL_FROM!,
      to: data.email,
      subject: `Reset your ${serverEnv.APP_NAME} password`,
      react: createElement(PasswordResetEmail, { link: data.url }),
    });
    failed = Boolean(error);
  } catch {
    console.error(
      "Password reset email delivery failed: the provider call threw",
    );
    throw unavailable();
  }

  if (failed) {
    console.error(
      "Password reset email delivery failed: the provider returned an error",
    );
    throw unavailable();
  }
}
