import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  createTransport: vi.fn(),
  sendMail: vi.fn(),
  close: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: state.createTransport },
}));

import {
  hasCloudflareSendEmailBinding,
  sendSmtpEmail,
} from "./email-transport";

const MESSAGE = {
  from: "Blossom <noreply@example.test>",
  to: "person@example.test",
  subject: "Hello",
  html: "<p>Hello</p>",
  text: "Hello",
};

beforeEach(() => {
  state.createTransport.mockReset();
  state.sendMail.mockReset();
  state.close.mockReset();
  state.createTransport.mockReturnValue({
    sendMail: state.sendMail,
    close: state.close,
  });
});

describe("Node SMTP transport", () => {
  it("has no Cloudflare binding outside Cloudflare", () => {
    expect(hasCloudflareSendEmailBinding()).toBe(false);
  });

  it("maps a secure connection with credentials to nodemailer", async () => {
    state.sendMail.mockResolvedValue({ messageId: "1" });

    await sendSmtpEmail(
      {
        host: "smtp.example.test",
        port: 465,
        secure: true,
        auth: { username: "user", password: "fake-smtp-credential" },
      },
      MESSAGE,
    );

    expect(state.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      auth: { user: "user", pass: "fake-smtp-credential" },
    });
    expect(state.sendMail).toHaveBeenCalledWith({
      from: MESSAGE.from,
      to: MESSAGE.to,
      subject: MESSAGE.subject,
      html: MESSAGE.html,
      text: MESSAGE.text,
    });
    expect(state.close).toHaveBeenCalledTimes(1);
  });

  it("omits auth for an unauthenticated relay and closes on failure", async () => {
    const failure = new Error("smtp refused");
    state.sendMail.mockRejectedValue(failure);

    await expect(
      sendSmtpEmail(
        { host: "smtp.example.test", port: 587, secure: false },
        MESSAGE,
      ),
    ).rejects.toBe(failure);

    expect(state.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: undefined,
    });
    expect(state.close).toHaveBeenCalledTimes(1);
  });
});
