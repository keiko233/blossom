import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import { createServerFn, createServerOnlyFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { betterAuth } from "better-auth";
import { admin, magicLink } from "better-auth/plugins";
import { tanstackStartCookies } from "better-auth/tanstack-start";

import { db } from "@/db";
import * as schema from "@/db/schema";
import MagicLinkEmail from "@/templates/emails/magic-link";

import { emailSignInSchema, emailSignUpSchema } from "./auth-schema";
import { getEmailClient } from "./email";
import { getServerEnv } from "./env";

const buildSocialProviders = createServerOnlyFn(() => {
  const env = getServerEnv();

  return {
    github: Boolean(env.GITHUB_CLIENT_ID) && Boolean(env.GITHUB_CLIENT_SECRET),
    google: Boolean(env.GOOGLE_CLIENT_ID) && Boolean(env.GOOGLE_CLIENT_SECRET),
  };
});

const buildAuth = createServerOnlyFn(() => {
  const env = getServerEnv();

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema,
    }),
    emailAndPassword: {
      enabled: true,
    },
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
      tanstackStartCookies(),
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
    ],
  });
});

let cachedAuth: ReturnType<typeof buildAuth> | undefined;

export const getAuth = () => {
  cachedAuth ??= buildAuth();
  return cachedAuth;
};

let cachedSocialProviders: ReturnType<typeof buildSocialProviders> | undefined;

export const getSocialProviders = createServerFn({
  method: "GET",
}).handler(() => {
  cachedSocialProviders ??= buildSocialProviders();
  return cachedSocialProviders;
});

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
  .handler(async ({ data }) => {
    const headers = getRequestHeaders();
    const auth = getAuth();
    const result = await auth.api.signInMagicLink({
      body: {
        ...data,
        callbackURL: "/dashboard",
        newUserCallbackURL: "/welcome",
      },
      headers,
    });
    return result;
  });
