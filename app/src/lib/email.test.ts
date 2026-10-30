import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { magicLink } from "better-auth/plugins";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_API_KEY = "re_fake_api_key_for_tests";
const FAKE_URL =
  "http://localhost:3000/api/auth/magic-link/verify?token=fake-secret-token&callbackURL=%2Fdashboard";

const state = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
  send: vi.fn(),
}));

vi.mock("./env", () => ({ getServerEnv: () => state.env }));
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: state.send };
  },
}));

const ENABLED_ENV = {
  APP_NAME: "Blossom Test",
  RESEND_API_KEY: FAKE_API_KEY,
  RESEND_MAIL_FROM: "noreply@example.test",
};

/** Loads `./email` fresh: `isEmailEnabled` is decided when the module loads. */
async function loadEmail(env: Record<string, string | undefined>) {
  state.env = env;
  vi.resetModules();
  return import("./email");
}

let warn: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;
let others: ReturnType<typeof vi.spyOn>[];

/** Everything written through any console method, objects fully expanded. */
function loggedText() {
  return [warn, error, ...others]
    .flatMap((spy) => spy.mock.calls)
    .map((args) =>
      args.map((a: unknown) => inspect(a, { depth: null })).join(" "),
    )
    .join("\n");
}

function expectNothingSensitiveLogged() {
  const text = loggedText();
  expect(text).not.toContain("fake-secret-token");
  expect(text).not.toContain(FAKE_URL);
  expect(text).not.toContain(FAKE_API_KEY);
  expect(text).not.toContain("person@example.test");
}

beforeEach(() => {
  state.send.mockReset();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  error = vi.spyOn(console, "error").mockImplementation(() => {});
  others = (["log", "info", "debug"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendMagicLinkEmail", () => {
  const data = { email: "person@example.test", url: FAKE_URL };

  it("sends the link through the provider when email is configured", async () => {
    state.send.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const { sendMagicLinkEmail } = await loadEmail(ENABLED_ENV);

    await expect(sendMagicLinkEmail(data)).resolves.toBeUndefined();

    expect(state.send).toHaveBeenCalledTimes(1);
    const payload = state.send.mock.calls[0]![0];
    expect(payload.from).toBe("noreply@example.test");
    expect(payload.to).toBe("person@example.test");
    expect(payload.subject).toContain("Blossom Test");
    expect(payload.react.props).toEqual({
      email: "person@example.test",
      link: FAKE_URL,
    });
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    ["no provider settings", {}],
    ["only the API key", { RESEND_API_KEY: FAKE_API_KEY }],
    ["only the sender address", { RESEND_MAIL_FROM: "noreply@example.test" }],
  ])("fails generically and logs no secrets with %s", async (_name, env) => {
    const { sendMagicLinkEmail, MAGIC_LINK_UNAVAILABLE_MESSAGE } =
      await loadEmail({ APP_NAME: "Blossom Test", ...env });

    const failure = await sendMagicLinkEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      statusCode: 503,
      body: { message: MAGIC_LINK_UNAVAILABLE_MESSAGE },
    });
    expect(state.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expectNothingSensitiveLogged();
  });

  it("fails generically when the provider returns an error result", async () => {
    // Resend reports most failures as `{ error }` rather than throwing.
    state.send.mockResolvedValue({
      data: null,
      error: {
        name: `${FAKE_URL} person@example.test ${FAKE_API_KEY}`,
        statusCode: 422,
        message: `bad request for person@example.test ${FAKE_URL} ${FAKE_API_KEY}`,
      },
    });
    const { sendMagicLinkEmail, MAGIC_LINK_UNAVAILABLE_MESSAGE } =
      await loadEmail(ENABLED_ENV);

    const failure = await sendMagicLinkEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      body: { message: MAGIC_LINK_UNAVAILABLE_MESSAGE },
    });
    expect(JSON.stringify(failure)).not.toContain("person@example.test");
    expect(error).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(failure)).not.toContain(FAKE_API_KEY);
    expectNothingSensitiveLogged();
  });

  it("fails generically when the provider call throws", async () => {
    const cause = new Error(
      `network down ${FAKE_URL} ${FAKE_API_KEY} person@example.test`,
    );
    cause.name = `${FAKE_URL} person@example.test ${FAKE_API_KEY}`;
    state.send.mockRejectedValue(cause);
    const { sendMagicLinkEmail, MAGIC_LINK_UNAVAILABLE_MESSAGE } =
      await loadEmail(ENABLED_ENV);

    const failure = await sendMagicLinkEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      body: { message: MAGIC_LINK_UNAVAILABLE_MESSAGE },
    });
    expect(JSON.stringify(failure)).not.toContain(FAKE_API_KEY);
    expect(error).toHaveBeenCalledTimes(1);
    expectNothingSensitiveLogged();
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
  const body = { email: "person@example.test", callbackURL: "/dashboard" };
  const headers = new Headers();

  it("reports success only when the email was delivered", async () => {
    state.send.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const { sendMagicLinkEmail } = await loadEmail(ENABLED_ENV);
    const auth = makeAuth(sendMagicLinkEmail);

    await expect(auth.api.signInMagicLink({ body, headers })).resolves.toEqual({
      status: true,
    });
    expect(state.send).toHaveBeenCalledTimes(1);
  });

  it("rejects the request instead of claiming success when email is not configured", async () => {
    const { sendMagicLinkEmail } = await loadEmail({
      APP_NAME: "Blossom Test",
    });
    const auth = makeAuth(sendMagicLinkEmail);

    const apiFailure = await auth.api
      .signInMagicLink({ body, headers })
      .catch((e: unknown) => e);
    expect(apiFailure).toMatchObject({ statusCode: 503 });

    // The public HTTP endpoint fails the same way, with nothing sensitive.
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
    expectNothingSensitiveLogged();
  });

  it("gives an unknown address the same outcome as a known one", async () => {
    const { sendMagicLinkEmail } = await loadEmail({
      APP_NAME: "Blossom Test",
    });
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
