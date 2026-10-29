import type { BetterAuthOptions } from "better-auth";
import { APIError } from "better-auth/api";

import {
  evaluateRegistration,
  REGISTRATION_ERROR_CODES,
  REGISTRATION_ERROR_DESCRIPTIONS,
} from "./registration-policy";
import type { RegistrationSettings } from "./settings";

type ValidateUserInfo = NonNullable<
  NonNullable<BetterAuthOptions["user"]>["validateUserInfo"]
>;
type DatabaseHooks = NonNullable<BetterAuthOptions["databaseHooks"]>;

export interface RegistrationHookDeps {
  /** The registration settings in force right now (per-request memoized). */
  getRegistration: () => Promise<
    Pick<
      RegistrationSettings,
      "mode" | "allowedEmailDomains" | "requireEmailVerification"
    >
  >;
  /**
   * Grants the new-user trial. Must be idempotent and decide for itself
   * whether a trial applies; `method` is how the account was created.
   */
  grantTrial: (userId: string, method: string) => Promise<unknown>;
}

/**
 * The better-auth hooks that enforce the registration settings and hand out
 * the new-user trial. Wired into `betterAuth({ user, databaseHooks })`.
 *
 * Telling admin-created accounts apart: better-auth passes the provisioning
 * `source.method` to `validateUserInfo` just before it creates a user. It is
 * `"admin"` only when the admin plugin's `createUser` endpoint made the call,
 * and that endpoint refuses callers who are not admins. The value is set by
 * better-auth's own code from the endpoint being served, never read from
 * request input, so a client cannot claim it. `evaluateRegistration` lets that
 * method through unconditionally and `shouldGrantTrial` never trials it.
 */
export function createRegistrationHooks(deps: RegistrationHookDeps): {
  validateUserInfo: ValidateUserInfo;
  databaseHooks: DatabaseHooks;
} {
  /**
   * How each account creation in flight was provisioned. `validateUserInfo`
   * learns the method; the later `create.after` hook does not. Both run with
   * the same endpoint context object, so the method is parked here keyed by
   * it, and goes away with the request.
   */
  const creationMethodByContext = new WeakMap<object, string>();

  const validateUserInfo: ValidateUserInfo = async (
    { user, source },
    context,
  ) => {
    // Only gate creating accounts. Existing users keep signing in (and linking
    // providers) whatever the registration settings say.
    if (source.action !== "create-user") return;
    creationMethodByContext.set(context, source.method);

    const registration = await deps.getRegistration();
    const decision = evaluateRegistration(registration, {
      email: typeof user.email === "string" ? user.email : "",
      method: source.method,
    });
    if (decision.allowed) return;
    return {
      error: REGISTRATION_ERROR_CODES[decision.reason],
      errorDescription: REGISTRATION_ERROR_DESCRIPTIONS[decision.reason],
    };
  };

  const databaseHooks: DatabaseHooks = {
    user: {
      create: {
        after: async (created, context) => {
          const method = context
            ? creationMethodByContext.get(context)
            : undefined;
          // Unknown provenance (no endpoint context, e.g. a script) never
          // earns a trial.
          if (!method) return;
          try {
            await deps.grantTrial(created.id, method);
          } catch (error) {
            // A failed grant must never fail the sign-up itself.
            console.error(
              `[trial] could not grant the trial to user ${created.id}`,
              error,
            );
          }
        },
      },
    },
    session: {
      create: {
        before: async (session, context) => {
          const registration = await deps.getRegistration();
          if (!registration.requireEmailVerification) return;
          // An admin viewing the app as a user is not that user signing in.
          if ((session as { impersonatedBy?: string | null }).impersonatedBy) {
            return;
          }
          const owner = await context?.context.internalAdapter.findUserById(
            session.userId,
          );
          if (owner && !owner.emailVerified) {
            throw new APIError("FORBIDDEN", {
              code: "EMAIL_NOT_VERIFIED",
              message: "Email not verified",
            });
          }
        },
      },
    },
  };

  return { validateUserInfo, databaseHooks };
}
