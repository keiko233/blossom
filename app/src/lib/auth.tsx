import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { oauthProvider } from "@better-auth/oauth-provider";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { betterAuth } from "better-auth";
import { admin, magicLink } from "better-auth/plugins";
import { jwt } from "better-auth/plugins/jwt";
import { tanstackStartCookies } from "better-auth/tanstack-start";

import { db } from "@/db";
import * as schema from "@/db/schema";
import { getSettings } from "@/query/settings-store";
import { grantSignupTrial } from "@/query/trial-grant";
import MagicLinkEmail from "@/templates/emails/magic-link";

import { createRegistrationHooks } from "./auth-registration-hooks";
import { emailSignInSchema, emailSignUpSchema } from "./auth-schema";
import { getEmailClient } from "./email";
import { getServerEnv } from "./env";
import {
  evaluateRegistration,
  type RegistrationDenyReason,
} from "./registration-policy";

const buildSocialProviders = createServerOnlyFn(() => {
  const env = getServerEnv();

  return {
    github: Boolean(env.GITHUB_CLIENT_ID) && Boolean(env.GITHUB_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID) && Boolean(env.GOOGLE_CLIENT_SECRET),
  };
});

const buildAuth = createServerOnlyFn(() => {
  const env = getServerEnv();

  const mcpResourceUrl = `${env.BETTER_AUTH_URL.replace(/\/$/, "")}/api/mcp`;

  const registrationHooks = createRegistrationHooks({
    getRegistration: async () => (await getSettings()).registration,
    grantTrial: grantSignupTrial,
  });

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
    // The single choke point for registration rules: better-auth calls
    // `validateUserInfo` just before it creates a user, whatever the route in
    // (email/password sign-up, first email-link sign-in, first social sign-in,
    // admin plugin). See `createRegistrationHooks`.
    user: { validateUserInfo: registrationHooks.validateUserInfo },
    databaseHooks: registrationHooks.databaseHooks,
    socialProviders: {
      github:
        env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
          ? {
              clientId: env.GITHUB_CLIENT_ID,
              clientSecret: env.GITHUB_CLIENT_SECRET,
            }
          : undefined,
      google:
        env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
          ? {
              clientId: env.GOOGLE_CLIENT_ID,
              clientSecret: env.GOOGLE_CLIENT_SECRET,
            }
          : undefined,
    },
    socialProviderConfig: {
      github: {
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
      },
    },
    plugins: [
      admin(),
      magicLink({
        sendMagicLink: async (data) => {
          const emailClient = getEmailClient();

          if (emailClient) {
            await emailClient.emails.send({
              from: env.RESEND_MAIL_FROM!,
              to: data.email,
              subject: `Welcome to ${env.APP_NAME}! Here's your link`,
              react: <MagicLinkEmail email={data.email} link={data.url} />,
            });
          } else {
            console.warn(
              "Email is not enabled, please configure the RESEND_API_KEY",
              data,
            );
          }
        },
      }),
      jwt({
        jwt: {
          expirationTime: "15m",
        },
      }),
      oauthProvider({
        loginPage: "/auth/login",
        consentPage: "/auth/mcp-consent",
        silenceWarnings: {
          oauthAuthServerConfig: true,
        },
        scopes: ["blossom:mcp:read", "blossom:mcp:write", "offline_access"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientRegistrationDefaultScopes: ["blossom:mcp:read"],
        clientRegistrationAllowedScopes: [
          "blossom:mcp:write",
          "offline_access",
        ],
        accessTokenExpiresIn: 60 * 60 * 24,
        refreshTokenExpiresIn: 60 * 60 * 24 * 30,
        codeExpiresIn: 600,
        grantTypes: ["authorization_code", "refresh_token"],
        disableJwtPlugin: false,
        validAudiences: [mcpResourceUrl],
      }),
      tanstackStartCookies(),
    ],
  });
});

let cachedAuth: ReturnType<typeof buildAuth> | undefined;

export const getAuth = () => {
  cachedAuth ??= buildAuth();
  return cachedAuth;
};

let cachedSocialProviders: ReturnType<typeof buildSocialProviders> | undefined;

/** Which social sign-in providers have credentials configured. Server only. */
export const getEnabledSocialProviders = () => {
  cachedSocialProviders ??= buildSocialProviders();
  return cachedSocialProviders;
};

export const getSocialProviders = createServerFn({
  method: "GET",
}).handler(() => getEnabledSocialProviders());

export type Session = ReturnType<typeof buildAuth>["$Infer"]["Session"];
export type SessionUser = Session["user"];

export const getSession = createServerFn({
  method: "GET",
}).handler(async (): Promise<Session | null> => {
  const headers = getRequestHeaders();
  const session = await getAuth().api.getSession({ headers });
  return session;
});

export const ensureSession = createServerFn({
  method: "GET",
}).handler(async (): Promise<Session> => {
  const headers = getRequestHeaders();
  const session = await getAuth().api.getSession({ headers });
  if (!session) {
    throw new Error("Unauthorized");
  }
  return session;
});

export const emailSignIn = createServerFn({
  method: "POST",
})
  .validator(emailSignInSchema)
  .handler(async ({ data }) => {
    const headers = getRequestHeaders();
    const auth = getAuth();
    const result = await auth.api.signInEmail({
      body: data,
      headers,
    });
    return result;
  });

export const emailSignUp = createServerFn({
  method: "POST",
})
  .validator(emailSignUpSchema)
  .handler(
    async ({
      data,
    }): Promise<{
      status: boolean;
      /** Set when registration rules refused the address; no email was sent. */
      reason: RegistrationDenyReason | null;
    }> => {
      // Refuse up front so nobody is mailed a link that would only fail at the
      // verify step. The create-user gate in `validateUserInfo` remains the
      // authority; this just keeps the sign-up page honest.
      const { registration } = await getSettings();
      const decision = evaluateRegistration(registration, {
        email: data.email,
        method: "magic-link",
      });
      if (!decision.allowed) {
        return { status: false, reason: decision.reason };
      }

      const headers = getRequestHeaders();
      const auth = getAuth();
      const result = await auth.api.signInMagicLink({
        body: {
          ...data,
          callbackURL: "/dashboard",
          newUserCallbackURL: "/welcome",
          errorCallbackURL: "/auth/login",
        },
        headers,
      });
      return { status: result.status, reason: null };
    },
  );

export const signOut = createServerFn({
  method: "POST",
}).handler(async () => {
  const headers = getRequestHeaders();
  const auth = getAuth();
  await auth.api.signOut({ headers });
});
