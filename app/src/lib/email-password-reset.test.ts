import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as emailModule from "./email";

const FAKE_API_KEY = "re_fake_api_key_for_tests";
const FAKE_SMTP_USER = "mailbox-user";
const FAKE_SMTP_PASSWORD = "fake-smtp-credential";
const FAKE_URL =
  "http://localhost:3000/api/auth/reset-password/fake-secret-token?callbackURL=%2Fauth%2Freset";
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
  EMAIL_FROM: "noreply@example.test",
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

describe("sendPasswordResetEmail", () => {
  const data = { email: RECIPIENT, url: FAKE_URL };

  it("sends through Resend when Resend is configured", async () => {
    state.resendSend.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const { sendPasswordResetEmail } = await loadEmail(RESEND_ENV);

    await expect(sendPasswordResetEmail(data)).resolves.toBeUndefined();

    expect(state.resendSend).toHaveBeenCalledTimes(1);
    const payload = state.resendSend.mock.calls[0]![0];
    expect(payload.from).toBe("noreply@example.test");
    expect(payload.to).toBe(RECIPIENT);
    expect(payload.subject).toContain("Blossom Test");
    expect(payload.html).toContain(FAKE_URL);
    expect(payload.text).toContain(FAKE_URL);
  });

  it("sends through SMTP when SMTP is configured", async () => {
    state.smtpSend.mockResolvedValue(undefined);
    const { sendPasswordResetEmail } = await loadEmail(SMTP_ENV);

    await expect(sendPasswordResetEmail(data)).resolves.toBeUndefined();

    expect(state.smtpSend).toHaveBeenCalledTimes(1);
    const [, message] = state.smtpSend.mock.calls[0]!;
    expect(message.to).toBe(RECIPIENT);
    expect(message.html).toContain(FAKE_URL);
  });

  it("sends through Cloudflare Workers Mail when the binding exists", async () => {
    state.cloudflareSend.mockResolvedValue(undefined);
    const { sendPasswordResetEmail } = await loadEmail(CLOUDFLARE_ENV, {
      hasCloudflareBinding: true,
    });

    await expect(sendPasswordResetEmail(data)).resolves.toBeUndefined();

    expect(state.cloudflareSend).toHaveBeenCalledTimes(1);
    const [message] = state.cloudflareSend.mock.calls[0]!;
    expect(message.to).toBe(RECIPIENT);
    expect(message.html).toContain(FAKE_URL);
  });

  it("fails generically and logs nothing sensitive when unconfigured", async () => {
    const { sendPasswordResetEmail } = await loadEmail({});

    const failure = await sendPasswordResetEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
    expect(state.resendSend).not.toHaveBeenCalled();
    expect(spies[3]).toHaveBeenCalledTimes(1);
    expectNothingSensitive(loggedText());
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
      "SMTP",
      SMTP_ENV,
      () =>
        state.smtpSend.mockRejectedValue(
          new Error(
            `smtp refused ${RECIPIENT} ${FAKE_SMTP_USER} ${FAKE_SMTP_PASSWORD} ${FAKE_URL}`,
          ),
        ),
    ],
    [
      "Cloudflare",
      CLOUDFLARE_ENV,
      () =>
        state.cloudflareSend.mockRejectedValue(
          new Error(`binding rejected ${RECIPIENT} ${FAKE_URL}`),
        ),
    ],
  ])("fails generically when %s fails", async (_name, env, arrange) => {
    arrange();
    const { sendPasswordResetEmail } = await loadEmail(env, {
      hasCloudflareBinding: true,
    });

    const failure = await sendPasswordResetEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({ status: "SERVICE_UNAVAILABLE" });
    expectNothingSensitive(JSON.stringify(failure));
    expectNothingSensitive(loggedText());
    expect(spies[4]).toHaveBeenCalledTimes(1);
  });
});
