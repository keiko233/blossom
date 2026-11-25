import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as emailModule from "./email";

const FAKE_API_KEY = "re_fake_api_key_for_tests";
const FAKE_SMTP_USER = "mailbox-user";
const FAKE_SMTP_PASSWORD = "fake-smtp-credential";
const FAKE_URL =
  "http://localhost:3000/api/auth/magic-link/verify?token=fake-secret-token";
const RECIPIENT = "person@example.test";

const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  hasCloudflareBinding: false,
  resendSend: vi.fn(),
  smtpSend: vi.fn(),
  cloudflareSend: vi.fn(),
}));

vi.mock("./env", () => ({
  getServerEnv: () => ({ APP_NAME: "Blossom Test", ...state.env }),
}));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: state.resendSend };
  },
}));
vi.mock("@/lib/email-transport", () => ({
  hasCloudflareSendEmailBinding: () => state.hasCloudflareBinding,
  sendSmtpEmail: state.smtpSend,
  sendCloudflareEmail: state.cloudflareSend,
}));

const RESEND_ENV = {
  EMAIL_FROM: "Blossom <noreply@example.test>",
  RESEND_API_KEY: FAKE_API_KEY,
};
const SMTP_ENV = {
  EMAIL_FROM: "noreply@example.test",
  SMTP_HOST: "smtp.example.test",
  SMTP_USER: FAKE_SMTP_USER,
  SMTP_PASSWORD: FAKE_SMTP_PASSWORD,
};
const CLOUDFLARE_ENV = { EMAIL_FROM: "noreply@example.test" };

/** Provider resolution is dynamic, so only the env and binding need swapping. */
function loadEmail(
  env: Record<string, unknown>,
  options: { hasCloudflareBinding?: boolean } = {},
) {
  state.env = env;
  state.hasCloudflareBinding = options.hasCloudflareBinding ?? false;
  return emailModule;
}

let spies: ReturnType<typeof vi.spyOn>[];

function loggedText() {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) =>
      args.map((a: unknown) => inspect(a, { depth: null })).join(" "),
    )
    .join("\n");
}

function expectNothingSensitive(text: string) {
  expect(text).not.toContain("fake-secret-token");
  expect(text).not.toContain(FAKE_URL);
  expect(text).not.toContain(FAKE_API_KEY);
  expect(text).not.toContain(FAKE_SMTP_PASSWORD);
  expect(text).not.toContain(FAKE_SMTP_USER);
  expect(text).not.toContain("smtp.example.test");
  expect(text).not.toContain(RECIPIENT);
}

beforeEach(() => {
  state.resendSend.mockReset();
  state.smtpSend.mockReset();
  state.cloudflareSend.mockReset();
  spies = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendMagicLinkEmail", () => {
  const data = { email: RECIPIENT, url: FAKE_URL };

  it("sends through Resend when Resend is configured", async () => {
    state.resendSend.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const { sendMagicLinkEmail } = await loadEmail(RESEND_ENV);

    await expect(sendMagicLinkEmail(data)).resolves.toBeUndefined();

    expect(state.resendSend).toHaveBeenCalledTimes(1);
    const payload = state.resendSend.mock.calls[0]![0];
    expect(payload.from).toBe("Blossom <noreply@example.test>");
    expect(payload.to).toBe(RECIPIENT);
    expect(payload.subject).toContain("Blossom Test");
    expect(payload.html).toContain(FAKE_URL);
    expect(payload.text).toContain(FAKE_URL);
    expect(state.smtpSend).not.toHaveBeenCalled();
  });

  it("sends through SMTP when SMTP is configured", async () => {
    state.smtpSend.mockResolvedValue(undefined);
    const { sendMagicLinkEmail } = await loadEmail(SMTP_ENV);

    await expect(sendMagicLinkEmail(data)).resolves.toBeUndefined();

    expect(state.smtpSend).toHaveBeenCalledTimes(1);
    const [config, message] = state.smtpSend.mock.calls[0]!;
    expect(config).toMatchObject({
      host: "smtp.example.test",
      port: 587,
      secure: false,
    });
    expect(config.auth).toEqual({
      username: FAKE_SMTP_USER,
      password: FAKE_SMTP_PASSWORD,
    });
    expect(message.to).toBe(RECIPIENT);
    expect(message.html).toContain(FAKE_URL);
    expect(state.resendSend).not.toHaveBeenCalled();
  });

  it("sends through Cloudflare Workers Mail when the binding exists", async () => {
    state.cloudflareSend.mockResolvedValue(undefined);
    const { sendMagicLinkEmail } = await loadEmail(CLOUDFLARE_ENV, {
      hasCloudflareBinding: true,
    });

    await expect(sendMagicLinkEmail(data)).resolves.toBeUndefined();

    expect(state.cloudflareSend).toHaveBeenCalledTimes(1);
    const [message] = state.cloudflareSend.mock.calls[0]!;
    expect(message.from).toBe("noreply@example.test");
    expect(message.to).toBe(RECIPIENT);
    expect(message.html).toContain(FAKE_URL);
  });

  it.each([
    ["no provider settings", {}],
    ["only the Resend API key", { RESEND_API_KEY: FAKE_API_KEY }],
    ["only the sender address", { EMAIL_FROM: "noreply@example.test" }],
    ["only an SMTP host", { SMTP_HOST: "smtp.example.test" }],
  ])("fails generically and logs no secrets with %s", async (_name, env) => {
    const { sendMagicLinkEmail, MAGIC_LINK_UNAVAILABLE_MESSAGE } =
      await loadEmail(env);

    const failure = await sendMagicLinkEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      statusCode: 503,
      body: { message: MAGIC_LINK_UNAVAILABLE_MESSAGE },
    });
    expect(state.resendSend).not.toHaveBeenCalled();
    expect(state.smtpSend).not.toHaveBeenCalled();
    expect(spies[3]).toHaveBeenCalledTimes(1);
    expectNothingSensitive(loggedText());
  });

  it("does not fall back from an incomplete explicit provider", async () => {
    const { sendMagicLinkEmail } = await loadEmail({
      EMAIL_PROVIDER: "smtp",
      EMAIL_FROM: "noreply@example.test",
      RESEND_API_KEY: FAKE_API_KEY,
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: FAKE_SMTP_USER,
    });

    await expect(sendMagicLinkEmail(data)).rejects.toMatchObject({
      statusCode: 503,
    });
    expect(state.resendSend).not.toHaveBeenCalled();
  });

  it.each([
    [
      "Resend",
      RESEND_ENV,
      () =>
        state.resendSend.mockResolvedValue({
          data: null,
          error: {
            name: `${FAKE_URL} ${RECIPIENT} ${FAKE_API_KEY}`,
            statusCode: 422,
            message: `bad request for ${RECIPIENT} ${FAKE_URL} ${FAKE_API_KEY}`,
          },
        }),
    ],
    [
      "Resend throws",
      RESEND_ENV,
      () =>
        state.resendSend.mockRejectedValue(
          new Error(`network down ${FAKE_URL} ${RECIPIENT} ${FAKE_API_KEY}`),
        ),
    ],
    [
      "SMTP throws",
      SMTP_ENV,
      () =>
        state.smtpSend.mockRejectedValue(
          new Error(
            `smtp refused ${RECIPIENT} ${FAKE_SMTP_USER} ${FAKE_SMTP_PASSWORD} ${FAKE_URL}`,
          ),
        ),
    ],
    [
      "Cloudflare throws",
      CLOUDFLARE_ENV,
      () =>
        state.cloudflareSend.mockRejectedValue(
          new Error(`binding rejected ${RECIPIENT} ${FAKE_URL}`),
        ),
    ],
  ])("fails generically when %s fails", async (_name, env, arrange) => {
    arrange();
    const { sendMagicLinkEmail, MAGIC_LINK_UNAVAILABLE_MESSAGE } =
      await loadEmail(env, { hasCloudflareBinding: true });

    const failure = await sendMagicLinkEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      body: { message: MAGIC_LINK_UNAVAILABLE_MESSAGE },
    });
    expectNothingSensitive(JSON.stringify(failure));
    expectNothingSensitive(loggedText());
    expect(spies[4]).toHaveBeenCalledTimes(1);
  });
});

describe("provider introspection", () => {
  it("reports the configured provider dynamically", async () => {
    const email = await loadEmail(RESEND_ENV);
    expect(email.isEmailEnabled()).toBe(true);
    expect(email.getConfiguredEmailProvider()).toBe("resend");

    state.env = {};
    expect(email.isEmailEnabled()).toBe(false);
    expect(email.getConfiguredEmailProvider()).toBeNull();
  });
});

describe("magic-link sign-in with the real better-auth", () => {
  function makeAuth(
    sendMagicLink: (d: { email: string; url: string }) => Promise<void>,
  ) {
    return betterAuth({
      baseURL: "http://localhost:3000",
      secret: "test-secret-test-secret-test-secret-123",
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
      }),
      plugins: [magicLink({ sendMagicLink })],
    });
  }
  const body = { email: RECIPIENT, callbackURL: "/dashboard" };
  const headers = new Headers();

  it("reports success only when the email was delivered", async () => {
    state.resendSend.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const { sendMagicLinkEmail } = await loadEmail(RESEND_ENV);
    const auth = makeAuth(sendMagicLinkEmail);

    await expect(auth.api.signInMagicLink({ body, headers })).resolves.toEqual({
      status: true,
    });
    expect(state.resendSend).toHaveBeenCalledTimes(1);
  });

  it("rejects the request instead of claiming success when email is not configured", async () => {
    const { sendMagicLinkEmail } = await loadEmail({});
    const auth = makeAuth(sendMagicLinkEmail);

    const apiFailure = await auth.api
      .signInMagicLink({ body, headers })
      .catch((e: unknown) => e);
    expect(apiFailure).toMatchObject({ statusCode: 503 });

    const response = await auth.handler(
      new Request("http://localhost:3000/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://localhost:3000",
        },
        body: JSON.stringify(body),
      }),
    );
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(text).toContain("Email sign-in is currently unavailable");
    expect(text).not.toContain("token=");
    expectNothingSensitive(loggedText());
  });

  it("gives an unknown address the same outcome as a known one", async () => {
    const { sendMagicLinkEmail } = await loadEmail({});
    const auth = makeAuth(sendMagicLinkEmail);

    const outcomes = await Promise.all(
      ["a@example.test", "b@example.test"].map((email) =>
        auth.api
          .signInMagicLink({ body: { email }, headers })
          .catch((e: { statusCode: number }) => e.statusCode),
      ),
    );
    expect(outcomes).toEqual([503, 503]);
  });
});
