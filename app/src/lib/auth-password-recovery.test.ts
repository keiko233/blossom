import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { admin } from "better-auth/plugins";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PASSWORD_RESET_TOKEN_TTL_SECONDS,
  PASSWORD_RESET_UNAVAILABLE_MESSAGE,
  createPasswordRecovery,
} from "./auth-password-recovery";

/**
 * These run the real better-auth against an in-memory database with the real
 * recovery module wired the way `lib/auth.tsx` wires it. Only the mail
 * provider is fake: it records what would have been sent.
 */

const BASE_URL = "http://localhost:3000";
const REDIRECT = "/auth/reset";
const OLD_PASSWORD = "old-password-0001";
const NEW_PASSWORD = "new-password-0002";
const FAKE_PROVIDER_SECRET = "re_fake_provider_secret_for_tests";

type Row = Record<string, unknown>;
type Mail = { email: string; url: string };

function makeEnvironment(
  options: {
    emailEnabled?: boolean;
    sendFails?: boolean;
    rateLimit?: boolean;
    oauthModels?: boolean;
  } = {},
) {
  const {
    emailEnabled = true,
    sendFails = false,
    rateLimit = false,
    oauthModels = false,
  } = options;
  const mails: Mail[] = [];
  const store: Record<string, Row[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    ...(oauthModels ? { oauthRefreshToken: [], oauthAccessToken: [] } : {}),
  };

  const recovery = createPasswordRecovery({
    isEmailEnabled: () => emailEnabled,
    sendPasswordResetEmail: async (data) => {
      if (sendFails) {
        // Providers echo the request back in their errors.
        throw new Error(
          `provider rejected ${data.email} ${data.url} ${FAKE_PROVIDER_SECRET}`,
        );
      }
      mails.push(data);
    },
  });

  const auth = betterAuth({
    baseURL: BASE_URL,
    secret: "test-secret-test-secret-test-secret-0123456789",
    database: memoryAdapter(store),
    emailAndPassword: { enabled: true, ...recovery.emailAndPassword },
    rateLimit: { enabled: rateLimit, storage: "memory" },
    plugins: [
      admin(),
      recovery.plugin,
      ...(oauthModels
        ? [
            {
              id: "oauth-stand-in",
              schema: {
                oauthRefreshToken: {
                  fields: {
                    userId: { type: "string" as const },
                    token: { type: "string" as const },
                  },
                },
                oauthAccessToken: {
                  fields: {
                    userId: { type: "string" as const },
                    token: { type: "string" as const },
                  },
                },
              },
            },
          ]
        : []),
    ],
  });

  const post = (path: string, body: unknown, ip = "203.0.113.7") =>
    auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify(body),
      }),
    );

  /** `redirectTo: null` omits the field. */
  const requestReset = (email: string, redirectTo: string | null = REDIRECT) =>
    post("/request-password-reset", {
      email,
      redirectTo: redirectTo ?? undefined,
    });

  /** Follows the emailed link the way a browser does; returns the token. */
  const openLink = async (url: string) => {
    const response = await auth.handler(
      new Request(url, { redirect: "manual" }),
    );
    const location = response.headers.get("location");
    return {
      status: response.status,
      location,
      token: location
        ? new URL(location, BASE_URL).searchParams.get("token")
        : null,
      error: location
        ? new URL(location, BASE_URL).searchParams.get("error")
        : null,
    };
  };

  const reset = (token: string | null, newPassword = NEW_PASSWORD) =>
    post("/reset-password", { token: token ?? undefined, newPassword });

  const signUp = async (email: string) => {
    await auth.api.signUpEmail({
      body: { email, password: OLD_PASSWORD, name: "Test User" },
    });
    const ctx = await auth.$context;
    return (await ctx.internalAdapter.findUserByEmail(email))!.user;
  };

  const canSignIn = (email: string, password: string) =>
    auth.api
      .signInEmail({ body: { email, password } })
      .then(() => true)
      .catch(() => false);

  const latestToken = async () => {
    const mail = mails.at(-1)!;
    const opened = await openLink(mail.url);
    return opened.token;
  };

  return {
    auth,
    store,
    mails,
    post,
    requestReset,
    openLink,
    reset,
    signUp,
    canSignIn,
    latestToken,
  };
}

let spies: ReturnType<typeof vi.spyOn>[];

/** Everything written through any console method, objects fully expanded. */
function loggedText() {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) =>
      args.map((a: unknown) => inspect(a, { depth: null })).join(" "),
    )
    .join("\n");
}

beforeEach(() => {
  spies = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("requesting a reset", () => {
  it("answers a known and an unknown address identically", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");

    const known = await env.requestReset("known@example.test");
    const unknown = await env.requestReset("nobody@example.test");

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(known.status);
    expect(await unknown.text()).toBe(await known.text());
    // Only the real account was mailed, and only at its own address.
    expect(env.mails.map((m) => m.email)).toEqual(["known@example.test"]);
  });

  it("does not put the token in the response, only in the emailed link", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");

    const response = await env.requestReset("known@example.test");
    const text = await response.text();
    const token = await env.latestToken();

    expect(token).toBeTruthy();
    expect(text).not.toContain(token!);
    expect(JSON.stringify([...response.headers])).not.toContain(token!);
    expect(env.mails[0]!.url).toContain(token!);
  });

  it("stores only an expiring token that belongs to the account", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = makeEnvironment();
    const user = await env.signUp("known@example.test");

    await env.requestReset("known@example.test");

    const rows = env.store.verification!;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.value).toBe(user.id);
    const ttl = (rows[0]!.expiresAt as Date).getTime() - Date.now();
    expect(ttl).toBe(PASSWORD_RESET_TOKEN_TTL_SECONDS * 1000);
    expect(PASSWORD_RESET_TOKEN_TTL_SECONDS).toBeLessThanOrEqual(60 * 60);
  });

  it("requires a same-origin reset page path and mails nothing otherwise", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");

    for (const redirectTo of [
      null,
      "https://evil.example/steal",
      "//evil.example/steal",
      "/\\evil.example/steal",
      "/auth/reset?next=https://evil.example",
      "javascript:alert(1)",
    ]) {
      const response = await env.requestReset("known@example.test", redirectTo);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(env.mails).toHaveLength(0);
    expect(env.store.verification).toHaveLength(0);
  });

  it("rate-limits requests per client", async () => {
    const env = makeEnvironment({ rateLimit: true });
    await env.signUp("known@example.test");

    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await env.requestReset("known@example.test")).status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect(env.mails).toHaveLength(3);
    // Another client is unaffected.
    const other = await env.post(
      "/request-password-reset",
      { email: "known@example.test", redirectTo: REDIRECT },
      "198.51.100.9",
    );
    expect(other.status).toBe(200);
  });
});

describe("when email is not configured", () => {
  it("refuses every address the same way instead of claiming success", async () => {
    const env = makeEnvironment({ emailEnabled: false });
    await env.signUp("known@example.test");

    const known = await env.requestReset("known@example.test");
    const unknown = await env.requestReset("nobody@example.test");

    expect(known.status).toBe(503);
    expect(unknown.status).toBe(503);
    const knownBody = await known.text();
    expect(await unknown.text()).toBe(knownBody);
    expect(JSON.parse(knownBody)).toMatchObject({
      message: PASSWORD_RESET_UNAVAILABLE_MESSAGE,
      code: "EMAIL_UNAVAILABLE",
    });
    expect(env.mails).toHaveLength(0);
    // No token was minted for a mail that cannot be sent.
    expect(env.store.verification).toHaveLength(0);
    expect(loggedText()).not.toContain("known@example.test");
  });
});

describe("when delivery fails", () => {
  it("looks the same as an unknown address and leaks nothing", async () => {
    const env = makeEnvironment({ sendFails: true });
    await env.signUp("known@example.test");

    const known = await env.requestReset("known@example.test");
    const unknown = await env.requestReset("nobody@example.test");

    expect(known.status).toBe(200);
    expect(unknown.status).toBe(200);
    expect(await known.text()).toBe(await unknown.text());

    const token = env.store.verification![0]!.identifier as string;
    const logs = loggedText();
    expect(logs).toContain("Password reset email was not delivered");
    expect(logs).not.toContain("known@example.test");
    expect(logs).not.toContain(FAKE_PROVIDER_SECRET);
    expect(logs).not.toContain(token.replace("reset-password:", ""));
    expect(logs).not.toContain("/reset-password/");
  });
});

describe("completing a reset", () => {
  it("sets the new password and drops the old one", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    await env.requestReset("known@example.test");

    const opened = await env.openLink(env.mails[0]!.url);
    expect(opened.status).toBe(302);
    expect(opened.location).toContain(REDIRECT);
    expect(opened.token).toBeTruthy();

    const response = await env.reset(opened.token);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    // Completing a reset does not sign anyone in.
    expect(response.headers.get("set-cookie")).toBeNull();

    expect(await env.canSignIn("known@example.test", NEW_PASSWORD)).toBe(true);
    expect(await env.canSignIn("known@example.test", OLD_PASSWORD)).toBe(false);
  });

  it("rejects a replayed token and keeps the first password", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    await env.requestReset("known@example.test");
    const token = await env.latestToken();

    expect((await env.reset(token, NEW_PASSWORD)).status).toBe(200);
    const replay = await env.reset(token, "attacker-password-9999");

    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "INVALID_TOKEN" });
    expect(await env.canSignIn("known@example.test", NEW_PASSWORD)).toBe(true);
    expect(
      await env.canSignIn("known@example.test", "attacker-password-9999"),
    ).toBe(false);
    // The emailed link no longer opens the reset page either.
    expect((await env.openLink(env.mails[0]!.url)).error).toBe("INVALID_TOKEN");
  });

  it("lets only one of two concurrent uses of a token win", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    await env.requestReset("known@example.test");
    const token = await env.latestToken();

    const [a, b] = await Promise.all([
      env.reset(token, "first-password-0001"),
      env.reset(token, "second-password-0002"),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 400]);
    const winner =
      a.status === 200 ? "first-password-0001" : "second-password-0002";
    const loser =
      a.status === 200 ? "second-password-0002" : "first-password-0001";
    expect(await env.canSignIn("known@example.test", winner)).toBe(true);
    expect(await env.canSignIn("known@example.test", loser)).toBe(false);
  });

  it("accepts a token just inside its lifetime and refuses it just after", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = makeEnvironment();
    await env.signUp("known@example.test");

    await env.requestReset("known@example.test");
    const early = await env.latestToken();
    vi.setSystemTime(
      Date.now() + (PASSWORD_RESET_TOKEN_TTL_SECONDS - 5) * 1000,
    );
    expect((await env.reset(early)).status).toBe(200);

    await env.requestReset("known@example.test");
    const late = await env.latestToken();
    vi.setSystemTime(
      Date.now() + (PASSWORD_RESET_TOKEN_TTL_SECONDS + 5) * 1000,
    );
    const expired = await env.reset(late, "another-password-0003");
    expect(expired.status).toBe(400);
    expect(await expired.json()).toMatchObject({ code: "INVALID_TOKEN" });
    expect((await env.openLink(env.mails[1]!.url)).error).toBe("INVALID_TOKEN");
    expect(
      await env.canSignIn("known@example.test", "another-password-0003"),
    ).toBe(false);
  });

  it("gives expired, used, forged and missing tokens the same error", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    await env.requestReset("known@example.test");
    const used = await env.latestToken();
    await env.reset(used);
    await env.requestReset("known@example.test");
    const expired = await env.latestToken();
    vi.setSystemTime(
      Date.now() + (PASSWORD_RESET_TOKEN_TTL_SECONDS + 5) * 1000,
    );

    const bodies = await Promise.all(
      [used, expired, "forged-token-value", null].map(async (token) => {
        const response = await env.reset(token, "another-password-0003");
        expect(response.status).toBe(400);
        const t = await response.text();
        return t;
      }),
    );
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain("known@example.test");
  });

  it("enforces password length without spending the token", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    await env.requestReset("known@example.test");
    const token = await env.latestToken();

    const tooShort = await env.reset(token, "short");
    expect(tooShort.status).toBe(400);
    expect(await tooShort.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    const tooLong = await env.reset(token, "x".repeat(129));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toMatchObject({ code: "PASSWORD_TOO_LONG" });

    // The user can still finish with a valid password.
    expect((await env.reset(token, NEW_PASSWORD)).status).toBe(200);
  });
});

describe("what a completed reset ends", () => {
  it("revokes every session, including other devices", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    const phone = await env.auth.api.signInEmail({
      body: { email: "known@example.test", password: OLD_PASSWORD },
    });
    const laptop = await env.auth.api.signInEmail({
      body: { email: "known@example.test", password: OLD_PASSWORD },
    });
    expect(env.store.session!.length).toBeGreaterThanOrEqual(2);

    await env.requestReset("known@example.test");
    expect((await env.reset(await env.latestToken())).status).toBe(200);

    expect(env.store.session).toHaveLength(0);
    for (const { token } of [phone, laptop]) {
      const session = await env.auth.api.getSession({
        headers: new Headers({ cookie: `better-auth.session_token=${token}` }),
      });
      expect(session).toBeNull();
    }
  });

  it("leaves other users' sessions alone", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    const other = await env.signUp("other@example.test");

    await env.requestReset("known@example.test");
    await env.reset(await env.latestToken());

    expect(env.store.session!.map((s) => s.userId)).toEqual([other.id]);
  });

  it("invalidates other outstanding reset links for the account", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");
    await env.signUp("other@example.test");
    await env.requestReset("known@example.test");
    await env.requestReset("known@example.test");
    await env.requestReset("other@example.test");
    const [older, newer, othersMail] = await Promise.all(
      env.mails.map((m) => env.openLink(m.url)),
    );

    expect((await env.reset(newer!.token)).status).toBe(200);

    const stale = await env.reset(older!.token, "another-password-0003");
    expect(stale.status).toBe(400);
    expect(
      await env.canSignIn("known@example.test", "another-password-0003"),
    ).toBe(false);
    // Another account's link is untouched.
    expect((await env.reset(othersMail!.token)).status).toBe(200);
  });

  it("revokes the account's OAuth grants, not other users'", async () => {
    // Session deletion does not reach the OAuth provider's tables
    // (`session_id` is `set null`), so reset must. The provider plugin is not
    // loaded here; this stands in for its models, which is all the module
    // relies on.
    const env = makeEnvironment({ oauthModels: true });
    const a = await env.signUp("known@example.test");
    const b = await env.signUp("other@example.test");
    const ctx = await env.auth.$context;
    for (const model of ["oauthRefreshToken", "oauthAccessToken"]) {
      await ctx.adapter.create({
        model,
        data: { userId: a.id, token: `${model}-a` },
      });
      await ctx.adapter.create({
        model,
        data: { userId: b.id, token: `${model}-b` },
      });
    }

    await env.requestReset("known@example.test");
    expect((await env.reset(await env.latestToken())).status).toBe(200);

    expect(env.store.oauthRefreshToken!.map((r) => r.userId)).toEqual([b.id]);
    expect(env.store.oauthAccessToken!.map((r) => r.userId)).toEqual([b.id]);
  });
});

describe("accounts without a password", () => {
  it("lets a magic-link-only user set one through the emailed link", async () => {
    const env = makeEnvironment();
    const ctx = await env.auth.$context;
    await ctx.internalAdapter.createUser(
      {
        email: "linkonly@example.test",
        name: "Link Only",
        emailVerified: true,
      },
      { method: "magic-link" },
    );
    expect(env.store.account).toHaveLength(0);

    await env.requestReset("linkonly@example.test");
    expect(env.mails).toHaveLength(1);
    expect((await env.reset(await env.latestToken())).status).toBe(200);

    expect(await env.canSignIn("linkonly@example.test", NEW_PASSWORD)).toBe(
      true,
    );
  });

  it("keeps a social login linked when its owner sets a password", async () => {
    const env = makeEnvironment();
    const ctx = await env.auth.$context;
    const user = await ctx.internalAdapter.createUser(
      {
        email: "social@example.test",
        name: "Social",
        emailVerified: true,
      },
      { method: "oauth", oauth: { providerId: "github" } },
    );
    await ctx.internalAdapter.createAccount({
      userId: user.id,
      providerId: "github",
      accountId: "12345",
    });

    await env.requestReset("social@example.test");
    expect((await env.reset(await env.latestToken())).status).toBe(200);

    expect(await env.canSignIn("social@example.test", NEW_PASSWORD)).toBe(true);
    expect(env.store.account!.map((a) => a.providerId).sort()).toEqual([
      "credential",
      "github",
    ]);
  });
});

describe("banned accounts", () => {
  it("get the same response but no email", async () => {
    const env = makeEnvironment();
    const user = await env.signUp("banned@example.test");
    const ctx = await env.auth.$context;
    await ctx.internalAdapter.updateUser(user.id, { banned: true });

    const banned = await env.requestReset("banned@example.test");
    const unknown = await env.requestReset("nobody@example.test");

    expect(banned.status).toBe(200);
    expect(await banned.text()).toBe(await unknown.text());
    expect(env.mails).toHaveLength(0);
  });
});

describe("logging", () => {
  it("never writes an address, link or token to the console across a full flow", async () => {
    const env = makeEnvironment();
    await env.signUp("known@example.test");

    await env.requestReset("known@example.test");
    await env.requestReset("nobody@example.test");
    const mail = env.mails[0]!;
    const token = (await env.openLink(mail.url)).token!;
    await env.reset(token, "short");
    await env.reset(token);
    await env.reset(token);
    await env.reset("forged-token-value");

    const logs = loggedText();
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(mail.url);
    expect(logs).not.toContain("known@example.test");
    expect(logs).not.toContain("nobody@example.test");
    expect(logs).not.toContain(NEW_PASSWORD);
  });
});
