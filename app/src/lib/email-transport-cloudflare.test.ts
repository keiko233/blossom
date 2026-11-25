import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  env: {} as { SEND_EMAIL?: { send: ReturnType<typeof vi.fn> } },
  connect: vi.fn(),
  send: vi.fn(),
  close: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  get env() {
    return state.env;
  },
}));
vi.mock("worker-mailer", () => ({ WorkerMailer: { connect: state.connect } }));

import {
  hasCloudflareSendEmailBinding,
  sendCloudflareEmail,
  sendSmtpEmail,
} from "./email-transport.cloudflare";

const MESSAGE = {
  from: "Blossom <noreply@example.test>",
  to: "person@example.test",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
};

beforeEach(() => {
  state.env = {};
  state.connect.mockReset();
  state.send.mockReset();
  state.close.mockReset();
  state.connect.mockResolvedValue({
    send: state.send,
    close: state.close,
  });
});

describe("Cloudflare Email transport", () => {
  it("reports whether the binding exists", () => {
    expect(hasCloudflareSendEmailBinding()).toBe(false);
    state.env = { SEND_EMAIL: { send: vi.fn() } };
    expect(hasCloudflareSendEmailBinding()).toBe(true);
  });

  it("sends through the structured Email Service binding", async () => {
    state.env = { SEND_EMAIL: { send: state.send } };

    await sendCloudflareEmail(MESSAGE);

    expect(state.send).toHaveBeenCalledWith({
      from: { email: "noreply@example.test", name: "Blossom" },
      to: { email: MESSAGE.to },
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
  });

  it("throws cleanly when invoked without the binding", async () => {
    await expect(sendCloudflareEmail(MESSAGE)).rejects.toThrow(
      "Cloudflare Email Service binding is not configured",
    );
  });

  it("maps implicit TLS and authenticated SMTP to worker-mailer", async () => {
    await sendSmtpEmail(
      {
        host: "smtp.example.test",
        port: 465,
        secure: true,
        auth: { username: "user", password: "fake-smtp-credential" },
      },
      MESSAGE,
    );

    expect(state.connect).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      startTls: false,
      credentials: { username: "user", password: "fake-smtp-credential" },
      authType: ["plain", "login", "cram-md5"],
    });
    expect(state.send).toHaveBeenCalledWith({
      from: { email: "noreply@example.test", name: "Blossom" },
      to: { email: MESSAGE.to },
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("uses STARTTLS for port 587 and closes on failure", async () => {
    state.send.mockRejectedValue(new Error("relay refused"));

    await expect(
      sendSmtpEmail(
        { host: "smtp.example.test", port: 587, secure: false },
        MESSAGE,
      ),
    ).rejects.toThrow("relay refused");

    expect(state.connect).toHaveBeenCalledWith(
      expect.objectContaining({
        secure: false,
        startTls: true,
        credentials: undefined,
      }),
    );
    expect(state.close).toHaveBeenCalledTimes(1);
  });
});
