import type { AuthContext, BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";

/**
 * Password recovery policy on top of better-auth's `/request-password-reset`
 * and `/reset-password` endpoints. `lib/auth.tsx` wires it in; the tests run it
 * against the real better-auth with an in-memory database.
 *
 * What better-auth already does: the reset token is random, stored in the
 * `verification` table with an expiry, and consumed when the password is
 * written, so it is single use. A request for an unknown address returns the
 * same body as a known one. This module closes the gaps around that:
 *
 * - **Mail unavailable is account independent.** A guard runs before the
 *   endpoint and refuses every request with the same 503 when no mail provider
 *   is configured, so a request is never reported as accepted when nothing
 *   could be sent, and the refusal says nothing about any account.
 * - **Delivery failure is not an oracle.** better-auth only calls
 *   `sendResetPassword` for accounts that exist. If a send failure reached the
 *   caller, "502 for this address" would reveal that the address is
 *   registered. The failure is logged (fixed text only) and swallowed, so
 *   known and unknown addresses get the identical response.
 * - **A completed reset ends the old credentials.** All sessions are revoked,
 *   other outstanding reset tokens for the user are deleted, and OAuth
 *   refresh/access tokens (the MCP grants, which survive session deletion) are
 *   deleted, because the usual reason to reset is a password that may be in
 *   someone else's hands.
 *
 * Accounts without a password (magic-link or social-only) receive the same
 * email and may use it to set one: the link proves control of the mailbox,
 * which is already enough to sign in by magic link.
 */

/** How long an emailed reset link stays valid, in seconds. */
export const PASSWORD_RESET_TOKEN_TTL_SECONDS = 30 * 60;

/** What the client sees when no reset email could be sent. */
export const PASSWORD_RESET_UNAVAILABLE_MESSAGE =
  "Password reset is currently unavailable";

const REQUEST_PATH = "/request-password-reset";
const RESET_PATH = "/reset-password";
const RESET_IDENTIFIER_PREFIX = "reset-password:";

export type PasswordRecoveryDeps = {
  /** Whether a mail provider is configured. Evaluated per request. */
  isEmailEnabled: () => boolean;
  /** Delivers the reset link. May throw; the failure never reaches the caller. */
  sendPasswordResetEmail: (data: {
    email: string;
    url: string;
  }) => Promise<void>;
};

/** The only page allowed to receive a password-reset token. */
const RESET_PAGE = "/auth/reset";

export function createPasswordRecovery(deps: PasswordRecoveryDeps) {
  let context: Promise<AuthContext> | undefined;

  /** Deletes every credential an earlier owner of the account could still use. */
  const revokeLingeringCredentials = async (userId: string) => {
    const ctx = await context;
    if (!ctx) {
      // Without the context the revocation cannot run; say so rather than
      // leave a silent hole. No user data in the message.
      console.error("Password reset cleanup skipped: auth context unavailable");
      return;
    }
    await ctx.adapter.deleteMany({
      model: "verification",
      where: [
        { field: "value", value: userId },
        {
          field: "identifier",
          operator: "starts_with",
          value: RESET_IDENTIFIER_PREFIX,
        },
      ],
    });
    // These models exist only with the OAuth provider plugin (MCP access).
    // Their `session_id` is `set null` on session deletion, so deleting the
    // sessions does not end them.
    for (const model of ["oauthRefreshToken", "oauthAccessToken"] as const) {
      if (ctx.tables?.[model]) {
        await ctx.adapter.deleteMany({
          model,
          where: [{ field: "userId", value: userId }],
        });
      }
    }
  };

  const plugin = {
    id: "password-recovery",
    init(ctx) {
      context = Promise.resolve(ctx);
    },
    hooks: {
      before: [
        {
          matcher: (c) => c.path === REQUEST_PATH,
          handler: createAuthMiddleware(async (c) => {
            if (!deps.isEmailEnabled()) {
              console.warn(
                "Password reset request refused: email is not configured (RESEND_API_KEY, RESEND_MAIL_FROM)",
              );
              throw new APIError("SERVICE_UNAVAILABLE", {
                message: PASSWORD_RESET_UNAVAILABLE_MESSAGE,
                code: "EMAIL_UNAVAILABLE",
              });
            }
            // The emailed link redirects to this path with the token; without
            // one it would land on the API origin instead of the reset page.
            if (
              (c.body as { redirectTo?: unknown })?.redirectTo !== RESET_PAGE
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "A reset page path is required",
                code: "INVALID_REDIRECT",
              });
            }
          }),
        },
      ],
    },
    rateLimit: [
      // Each request can send an email; each reset attempt hashes a password.
      { pathMatcher: (p) => p === REQUEST_PATH, window: 60, max: 3 },
      { pathMatcher: (p) => p === RESET_PATH, window: 60, max: 10 },
    ],
  } satisfies BetterAuthPlugin;

  return {
    plugin,
    /** The `emailAndPassword` options that enable recovery. */
    emailAndPassword: {
      resetPasswordTokenExpiresIn: PASSWORD_RESET_TOKEN_TTL_SECONDS,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({
        user,
        url,
      }: {
        user: { email: string; banned?: boolean | null };
        url: string;
      }) => {
        // A banned account cannot sign in whatever its password is, so there
        // is nothing to recover; the response stays identical either way.
        if (user.banned) return;
        try {
          await deps.sendPasswordResetEmail({ email: user.email, url });
        } catch {
          // Deliberately generic: the provider error can echo the address or
          // the link, and surfacing it would reveal that the account exists.
          console.error("Password reset email was not delivered");
        }
      },
      onPasswordReset: async ({ user }: { user: { id: string } }) => {
        try {
          await revokeLingeringCredentials(user.id);
        } catch {
          // The password and sessions are already changed; do not fail the
          // reset the user just completed over cleanup.
          console.error("Password reset cleanup failed");
        }
      },
    },
  };
}
