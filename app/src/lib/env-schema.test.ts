import { describe, expect, it } from "vitest";

import {
  DatabaseDriver,
  serverEnvSchema,
  supportsInteractiveTransactions,
} from "./env-schema";

describe("bootstrap DNS environment", () => {
  const { SING_BOX_BOOTSTRAP_DNS_TYPE, SING_BOX_BOOTSTRAP_DNS_SERVER } =
    serverEnvSchema.shape;

  it("defaults to TLS on 8.8.8.8 when unset", () => {
    expect(SING_BOX_BOOTSTRAP_DNS_TYPE.parse(undefined)).toBe("tls");
    expect(SING_BOX_BOOTSTRAP_DNS_SERVER.parse(undefined)).toBe("8.8.8.8");
  });

  it("accepts IPv4 and IPv6 literal servers only", () => {
    expect(SING_BOX_BOOTSTRAP_DNS_SERVER.safeParse("223.5.5.5").success).toBe(
      true,
    );
    expect(
      SING_BOX_BOOTSTRAP_DNS_SERVER.safeParse("2400:3200::1").success,
    ).toBe(true);
    expect(
      SING_BOX_BOOTSTRAP_DNS_SERVER.safeParse("dns.example.com").success,
    ).toBe(false);
  });

  it("accepts only the supported bootstrap types", () => {
    for (const type of ["tls", "udp", "local"]) {
      expect(SING_BOX_BOOTSTRAP_DNS_TYPE.safeParse(type).success).toBe(true);
    }
    expect(SING_BOX_BOOTSTRAP_DNS_TYPE.safeParse("https").success).toBe(false);
  });
});

describe("supportsInteractiveTransactions", () => {
  it("does not call Drizzle transactions for neon-http", () => {
    expect(supportsInteractiveTransactions(DatabaseDriver.NeonHttp)).toBe(
      false,
    );
  });

  it("keeps row-lock transactions for node-postgres", () => {
    expect(supportsInteractiveTransactions(DatabaseDriver.NodePg)).toBe(true);
  });
});

describe("email environment", () => {
  const { EMAIL_PROVIDER, EMAIL_FROM, SMTP_PORT, SMTP_SECURE } =
    serverEnvSchema.shape;

  it("normalizes an empty EMAIL_PROVIDER to unset and accepts only known providers", () => {
    expect(EMAIL_PROVIDER.parse("")).toBeUndefined();
    expect(EMAIL_PROVIDER.parse(undefined)).toBeUndefined();
    for (const provider of ["resend", "smtp", "cloudflare"]) {
      expect(EMAIL_PROVIDER.parse(provider)).toBe(provider);
    }
    expect(EMAIL_PROVIDER.safeParse("mailgun").success).toBe(false);
  });

  it("keeps EMAIL_FROM optional", () => {
    expect(EMAIL_FROM.parse(undefined)).toBeUndefined();
  });

  it("coerces SMTP_PORT and enforces the 1..65535 range", () => {
    expect(SMTP_PORT.parse("")).toBeUndefined();
    expect(SMTP_PORT.parse("465")).toBe(465);
    expect(SMTP_PORT.parse(587)).toBe(587);
    expect(SMTP_PORT.safeParse("0").success).toBe(false);
    expect(SMTP_PORT.safeParse("65536").success).toBe(false);
    expect(SMTP_PORT.safeParse("465.5").success).toBe(false);
    expect(SMTP_PORT.safeParse("smtp").success).toBe(false);
  });

  it("parses SMTP_SECURE safely without treating 'false' as true", () => {
    expect(SMTP_SECURE.parse("")).toBeUndefined();
    expect(SMTP_SECURE.parse(undefined)).toBeUndefined();
    expect(SMTP_SECURE.parse("true")).toBe(true);
    expect(SMTP_SECURE.parse("false")).toBe(false);
    expect(SMTP_SECURE.parse(true)).toBe(true);
    expect(SMTP_SECURE.parse(false)).toBe(false);
    expect(SMTP_SECURE.safeParse("yes").success).toBe(false);
  });
});
