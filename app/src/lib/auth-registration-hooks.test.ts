import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin, magicLink } from "better-auth/plugins";
import { beforeEach, describe, expect, it } from "vitest";

import { createRegistrationHooks } from "./auth-registration-hooks";
import type { RegistrationSettings } from "./settings";
import { shouldGrantTrial } from "./trial";

/**
 * These run the real better-auth against an in-memory database, with the real
 * hooks wired the way `lib/auth.tsx` wires them, so what is asserted is what
 * better-auth actually does with the hooks: which creation paths reach them,
 * and what the admin plugin's `createUser` looks like from inside.
 */

const BASE_URL = "http://localhost:3000";

type Row = Record<string, unknown>;

function makeEnvironment(initial?: Partial<RegistrationSettings>) {
  const registration: RegistrationSettings = {
    mode: "open",
    allowedEmailDomains: [],
    requireEmailVerification: false,
    ...initial,
  };
  const grants: { userId: string; method: string }[] = [];
  const magicLinks: { email: string; url: string }[] = [];
  const store: Record<string, Row[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
  };

  const hooks = createRegistrationHooks({
    getRegistration: async () => registration,
    // The real grant decides with `shouldGrantTrial`; record what it would do.
    grantTrial: async (userId, method) => {
      if (shouldGrantTrial({ enabled: true, planId: "trial-plan" }, method)) {
        grants.push({ userId, method });
      }
    },
  });

  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-0123456789",
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true },
    rateLimit: { enabled: false },
    user: { validateUserInfo: hooks.validateUserInfo },
    databaseHooks: hooks.databaseHooks,
    plugins: [
      admin(),
      magicLink({
        sendMagicLink: async ({ email, url }) => {
          magicLinks.push({ email, url });
        },
      }),
    ],
  });

  /** Inserts a user (and optionally a password) behind better-auth's back. */
  async function seedUser(input: {
    email: string;
    role?: string;
    emailVerified?: boolean;
    password?: string;
  }) {
    const context = await auth.$context;
    const id = `seed-${store.user.length + 1}`;
    const now = new Date();
    store.user.push({
      id,
      name: input.email,
      email: input.email,
      emailVerified: input.emailVerified ?? true,
      role: input.role ?? "user",
      banned: false,
      createdAt: now,
      updatedAt: now,
    });
    if (input.password) {
      store.account.push({
        id: `acct-${id}`,
        userId: id,
        accountId: id,
        providerId: "credential",
        password: await context.password.hash(input.password),
        createdAt: now,
        updatedAt: now,
      });
    }
    return id;
  }

  /** Cookie header of a signed-in session for the given seeded user. */
  async function signInAs(email: string, password: string) {
    const { headers } = await auth.api.signInEmail({
      body: { email, password },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    return new Headers({ cookie });
  }

  return {
    auth,
    registration,
    grants,
    magicLinks,
    store,
    seedUser,
    signInAs,
  };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error as { status?: string; body?: { code?: string } };
  }
  throw new Error("expected the call to fail");
}

describe("email and password sign-up", () => {
  let env: ReturnType<typeof makeEnvironment>;
  beforeEach(() => {
    env = makeEnvironment();
  });

  it("works while registration is open, and earns the trial", async () => {
    const { user } = await env.auth.api.signUpEmail({
      body: { email: "a@example.com", password: "password-123", name: "A" },
    });
    expect(user.email).toBe("a@example.com");
    expect(env.grants).toEqual([{ userId: user.id, method: "email-password" }]);
  });

  it("is refused when registration is closed, and creates nothing", async () => {
    env.registration.mode = "closed";
    const error = await failure(
      env.auth.api.signUpEmail({
        body: { email: "a@example.com", password: "password-123", name: "A" },
      }),
    );
    expect(error.status).toBe("FORBIDDEN");
    expect(error.body?.code).toBe("registration_closed");
    expect(env.store.user).toHaveLength(0);
    expect(env.grants).toHaveLength(0);
  });

  it("enforces the domain list, case-insensitively", async () => {
    env.registration.allowedEmailDomains = ["corp.io", "*.edu"];

    const denied = await failure(
      env.auth.api.signUpEmail({
        body: { email: "a@gmail.com", password: "password-123", name: "A" },
      }),
    );
    expect(denied.body?.code).toBe("registration_domain_not_allowed");

    await env.auth.api.signUpEmail({
      body: { email: "B@Corp.IO", password: "password-123", name: "B" },
    });
    await env.auth.api.signUpEmail({
      body: { email: "c@cs.uni.edu", password: "password-123", name: "C" },
    });
    expect(env.store.user).toHaveLength(2);
  });
});

describe("magic-link first sign-in (creates the user)", () => {
  async function verifyLatestLink(env: ReturnType<typeof makeEnvironment>) {
    const link = env.magicLinks.at(-1)!;
    const token = new URL(link.url).searchParams.get("token")!;
    return env.auth.handler(
      new Request(
        `${BASE_URL}/api/auth/magic-link/verify?token=${token}&callbackURL=/dashboard&errorCallbackURL=/auth/login`,
      ),
    );
  }

  it("creates the account and grants the trial while open", async () => {
    const env = makeEnvironment();
    await env.auth.api.signInMagicLink({
      body: { email: "m@example.com" },
      headers: new Headers(),
    });
    const response = await verifyLatestLink(env);
    expect(response.headers.get("location")).toContain("/dashboard");
    expect(env.store.user).toHaveLength(1);
    expect(env.grants).toEqual([
      { userId: env.store.user[0]!.id, method: "magic-link" },
    ]);
  });

  it("redirects to the login page with the error when closed", async () => {
    const env = makeEnvironment({ mode: "closed" });
    await env.auth.api.signInMagicLink({
      body: { email: "m@example.com" },
      headers: new Headers(),
    });
    const response = await verifyLatestLink(env);
    const location = new URL(response.headers.get("location")!, BASE_URL);
    expect(location.pathname).toBe("/auth/login");
    expect(location.searchParams.get("error")).toBe("registration_closed");
    expect(env.store.user).toHaveLength(0);
  });

  it("still lets an existing user in while closed", async () => {
    const env = makeEnvironment({ mode: "closed" });
    await env.seedUser({ email: "old@example.com" });
    await env.auth.api.signInMagicLink({
      body: { email: "old@example.com" },
      headers: new Headers(),
    });
    const response = await verifyLatestLink(env);
    expect(response.headers.get("location")).toContain("/dashboard");
    expect(env.store.session).toHaveLength(1);
    expect(env.grants).toHaveLength(0);
  });
});

describe("social (OAuth) first sign-in", () => {
  // The OAuth callback needs a live provider; what it hands the hook is the
  // same call better-auth makes for any new user, with method "oauth".
  const oauthSource = {
    action: "create-user",
    method: "oauth",
    oauth: { providerId: "github" },
  } as const;
  const context = {} as never;

  it("is gated like the other methods", async () => {
    const env = makeEnvironment({ mode: "closed" });
    const hooks = createRegistrationHooks({
      getRegistration: async () => env.registration,
      grantTrial: async () => {},
    });
    const result = await hooks.validateUserInfo(
      { user: { email: "g@example.com" }, source: oauthSource },
      context,
    );
    expect(result).toMatchObject({ error: "registration_closed" });

    env.registration.mode = "open";
    env.registration.allowedEmailDomains = ["corp.io"];
    expect(
      await hooks.validateUserInfo(
        { user: { email: "g@example.com" }, source: oauthSource },
        context,
      ),
    ).toMatchObject({ error: "registration_domain_not_allowed" });
    expect(
      await hooks.validateUserInfo(
        { user: { email: "G@Corp.io" }, source: oauthSource },
        context,
      ),
    ).toBeUndefined();
  });

  it("leaves returning users and account linking alone", async () => {
    const env = makeEnvironment({ mode: "closed" });
    const hooks = createRegistrationHooks({
      getRegistration: async () => env.registration,
      grantTrial: async () => {},
    });
    for (const action of ["sign-in", "link-account"] as const) {
      expect(
        await hooks.validateUserInfo(
          {
            user: { email: "g@example.com" },
            source: { ...oauthSource, action },
          },
          context,
        ),
      ).toBeUndefined();
    }
  });
});

describe("admin-created users", () => {
  it("bypass a closed registration and a domain list, and get no trial", async () => {
    const env = makeEnvironment({
      mode: "closed",
      allowedEmailDomains: ["corp.io"],
    });
    await env.seedUser({
      email: "boss@corp.io",
      role: "admin",
      password: "admin-password-1",
    });
    const headers = await env.signInAs("boss@corp.io", "admin-password-1");

    const { user } = await env.auth.api.createUser({
      headers,
      body: {
        email: "someone@gmail.com",
        password: "password-123",
        name: "Someone",
        role: "user",
      },
    });

    expect(user.email).toBe("someone@gmail.com");
    expect(env.store.user.map((row) => row.email)).toContain(
      "someone@gmail.com",
    );
    // The hook ran (the grant function was consulted) but, being admin-created,
    // the account earns no trial.
    expect(env.grants).toHaveLength(0);
  });

  it("cannot be impersonated by a non-admin session", async () => {
    const env = makeEnvironment({ mode: "closed" });
    await env.seedUser({
      email: "plain@example.com",
      password: "password-123",
    });
    const headers = await env.signInAs("plain@example.com", "password-123");

    const error = await failure(
      env.auth.api.createUser({
        headers,
        body: {
          email: "x@example.com",
          password: "password-123",
          name: "X",
          role: "user",
        },
      }),
    );
    expect(error.status).toBe("FORBIDDEN");
    expect(env.store.user).toHaveLength(1);
  });
});

describe("requireEmailVerification", () => {
  it("is off by default: unverified accounts sign in as before", async () => {
    const env = makeEnvironment();
    await env.seedUser({
      email: "u@example.com",
      password: "password-123",
      emailVerified: false,
    });
    const result = await env.auth.api.signInEmail({
      body: { email: "u@example.com", password: "password-123" },
    });
    expect(result.token).toBeTruthy();
  });

  it("refuses unverified accounts once on, after the password check", async () => {
    const env = makeEnvironment({ requireEmailVerification: true });
    await env.seedUser({
      email: "u@example.com",
      password: "password-123",
      emailVerified: false,
    });
    await env.seedUser({
      email: "v@example.com",
      password: "password-123",
      emailVerified: true,
    });

    const unverified = await failure(
      env.auth.api.signInEmail({
        body: { email: "u@example.com", password: "password-123" },
      }),
    );
    expect(unverified.status).toBe("FORBIDDEN");
    expect(unverified.body?.code).toBe("EMAIL_NOT_VERIFIED");

    // A wrong password still looks like any other bad login: no account probing.
    const wrong = await failure(
      env.auth.api.signInEmail({
        body: { email: "u@example.com", password: "nope-nope-nope" },
      }),
    );
    expect(wrong.status).toBe("UNAUTHORIZED");

    const verified = await env.auth.api.signInEmail({
      body: { email: "v@example.com", password: "password-123" },
    });
    expect(verified.token).toBeTruthy();
  });
});
