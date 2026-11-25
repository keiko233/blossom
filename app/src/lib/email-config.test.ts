import { describe, expect, it } from "vitest";

import {
  defaultSmtpPort,
  getSmtpAuthStatus,
  parseEmailAddress,
  resolveEmailConfig,
  resolveEmailFrom,
  resolveSmtpConfig,
} from "./email-config";

const FROM = "Blossom <noreply@example.test>";

describe("resolveEmailFrom", () => {
  it("prefers EMAIL_FROM and falls back to RESEND_MAIL_FROM", () => {
    expect(resolveEmailFrom({ EMAIL_FROM: FROM })).toBe(FROM);
    expect(resolveEmailFrom({ RESEND_MAIL_FROM: "legacy@example.test" })).toBe(
      "legacy@example.test",
    );
    expect(
      resolveEmailFrom({
        EMAIL_FROM: FROM,
        RESEND_MAIL_FROM: "legacy@example.test",
      }),
    ).toBe(FROM);
    expect(resolveEmailFrom({})).toBeUndefined();
  });
});

describe("SMTP configuration", () => {
  it("defaults the port to 465 with implicit TLS and 587 with STARTTLS", () => {
    expect(defaultSmtpPort(true)).toBe(465);
    expect(defaultSmtpPort(false)).toBe(587);
  });

  it("allows an unauthenticated relay when neither credential is set", () => {
    const config = resolveSmtpConfig({ SMTP_HOST: "smtp.example.test" });
    expect(config).toEqual({
      host: "smtp.example.test",
      port: 587,
      secure: false,
      auth: undefined,
    });
  });

  it("uses both credentials when they are set", () => {
    const config = resolveSmtpConfig({
      SMTP_HOST: "smtp.example.test",
      SMTP_USER: "user",
      SMTP_PASSWORD: "fake-smtp-password",
      SMTP_SECURE: true,
    });
    expect(config).toMatchObject({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      auth: { username: "user", password: "fake-smtp-password" },
    });
  });

  it.each(["user", "password"])(
    "treats half-configured auth as incomplete",
    (key) => {
      const env =
        key === "user"
          ? { SMTP_USER: "user" }
          : { SMTP_PASSWORD: "fake-smtp-password" };
      expect(getSmtpAuthStatus(env)).toBe("incomplete");
      expect(
        resolveSmtpConfig({ SMTP_HOST: "smtp.example.test", ...env }),
      ).toBeNull();
    },
  );
});

describe("resolveEmailConfig", () => {
  const noCloudflare = { hasCloudflareSendEmailBinding: false };
  const cloudflare = { hasCloudflareSendEmailBinding: true };

  it("returns null when no sender is configured", () => {
    expect(
      resolveEmailConfig({ RESEND_API_KEY: "re_fake" }, cloudflare),
    ).toBeNull();
  });

  it("auto-detects Resend before SMTP and Cloudflare", () => {
    const config = resolveEmailConfig(
      {
        EMAIL_FROM: FROM,
        RESEND_API_KEY: "re_fake",
        SMTP_HOST: "smtp.example.test",
      },
      cloudflare,
    );
    expect(config).toEqual({
      provider: "resend",
      from: FROM,
      apiKey: "re_fake",
    });
  });

  it("auto-detects SMTP before Cloudflare", () => {
    const config = resolveEmailConfig(
      {
        EMAIL_FROM: FROM,
        SMTP_HOST: "smtp.example.test",
        SMTP_USER: "user",
        SMTP_PASSWORD: "fake-smtp-password",
      },
      cloudflare,
    );
    expect(config).toMatchObject({ provider: "smtp", from: FROM });
  });

  it("auto-detects Cloudflare only when the binding exists", () => {
    expect(resolveEmailConfig({ EMAIL_FROM: FROM }, noCloudflare)).toBeNull();
    expect(resolveEmailConfig({ EMAIL_FROM: FROM }, cloudflare)).toEqual({
      provider: "cloudflare",
      from: FROM,
    });
  });

  it("does not fall back when EMAIL_PROVIDER is explicit but incomplete", () => {
    expect(
      resolveEmailConfig(
        { EMAIL_PROVIDER: "resend", EMAIL_FROM: FROM },
        cloudflare,
      ),
    ).toBeNull();
    expect(
      resolveEmailConfig(
        {
          EMAIL_PROVIDER: "smtp",
          EMAIL_FROM: FROM,
          SMTP_HOST: "smtp.example.test",
          SMTP_USER: "user",
        },
        noCloudflare,
      ),
    ).toBeNull();
    expect(
      resolveEmailConfig(
        { EMAIL_PROVIDER: "cloudflare", EMAIL_FROM: FROM },
        noCloudflare,
      ),
    ).toBeNull();
  });

  it("honours each explicit provider when configured", () => {
    expect(
      resolveEmailConfig(
        {
          EMAIL_PROVIDER: "smtp",
          EMAIL_FROM: FROM,
          SMTP_HOST: "smtp.example.test",
          RESEND_API_KEY: "re_fake",
        },
        noCloudflare,
      ),
    ).toMatchObject({ provider: "smtp" });
    expect(
      resolveEmailConfig(
        {
          EMAIL_PROVIDER: "cloudflare",
          EMAIL_FROM: FROM,
          RESEND_API_KEY: "re_fake",
        },
        cloudflare,
      ),
    ).toMatchObject({ provider: "cloudflare" });
  });
});

describe("parseEmailAddress", () => {
  it("parses a display name and address", () => {
    expect(parseEmailAddress('"Blossom" <noreply@example.test>')).toEqual({
      email: "noreply@example.test",
      name: "Blossom",
    });
    expect(parseEmailAddress("Blossom <noreply@example.test>")).toEqual({
      email: "noreply@example.test",
      name: "Blossom",
    });
  });

  it("parses a bare address", () => {
    expect(parseEmailAddress("noreply@example.test")).toEqual({
      email: "noreply@example.test",
    });
  });
});
