import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const FAKE_API_KEY = "re_fake_api_key_for_tests";
const FAKE_URL =
  "http://localhost:3000/api/auth/reset-password/fake-secret-token?callbackURL=%2Fauth%2Freset";

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
  expect(text).not.toContain("person@example.test");
}

beforeEach(() => {
  state.send.mockReset();
  spies = (["log", "info", "debug", "warn", "error"] as const).map((method) =>
    vi.spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sendPasswordResetEmail", () => {
  const data = { email: "person@example.test", url: FAKE_URL };

  it("sends the reset link to the account address", async () => {
    state.send.mockResolvedValue({ data: { id: "msg_1" }, error: null });
    const { sendPasswordResetEmail } = await loadEmail(ENABLED_ENV);

    await expect(sendPasswordResetEmail(data)).resolves.toBeUndefined();

    expect(state.send).toHaveBeenCalledTimes(1);
    const payload = state.send.mock.calls[0]![0];
    expect(payload.from).toBe("noreply@example.test");
    expect(payload.to).toBe("person@example.test");
    expect(payload.subject).toContain("Blossom Test");
    expect(payload.react.props).toEqual({ link: FAKE_URL });
    expect(loggedText()).toBe("");
  });

  it("fails generically and logs nothing sensitive when email is not configured", async () => {
    const { sendPasswordResetEmail } = await loadEmail({
      APP_NAME: "Blossom Test",
    });

    const failure = await sendPasswordResetEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({
      status: "SERVICE_UNAVAILABLE",
      statusCode: 503,
    });
    expect(state.send).not.toHaveBeenCalled();
    expect(spies[3]).toHaveBeenCalledTimes(1);
    expectNothingSensitive(loggedText());
  });

  it("fails generically when the provider returns an error result", async () => {
    state.send.mockResolvedValue({
      data: null,
      error: {
        name: `${FAKE_URL} person@example.test ${FAKE_API_KEY}`,
        statusCode: 422,
        message: `bad request for person@example.test ${FAKE_URL} ${FAKE_API_KEY}`,
      },
    });
    const { sendPasswordResetEmail } = await loadEmail(ENABLED_ENV);

    const failure = await sendPasswordResetEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({ status: "SERVICE_UNAVAILABLE" });
    expectNothingSensitive(JSON.stringify(failure));
    expectNothingSensitive(loggedText());
    expect(spies[4]).toHaveBeenCalledTimes(1);
  });

  it("fails generically when the provider call throws", async () => {
    const cause = new Error(
      `network down ${FAKE_URL} ${FAKE_API_KEY} person@example.test`,
    );
    cause.name = `${FAKE_URL} person@example.test ${FAKE_API_KEY}`;
    state.send.mockRejectedValue(cause);
    const { sendPasswordResetEmail } = await loadEmail(ENABLED_ENV);

    const failure = await sendPasswordResetEmail(data).catch((e: unknown) => e);

    expect(failure).toMatchObject({ status: "SERVICE_UNAVAILABLE" });
    expectNothingSensitive(JSON.stringify(failure));
    expectNothingSensitive(loggedText());
    expect(spies[4]).toHaveBeenCalledTimes(1);
  });
});
