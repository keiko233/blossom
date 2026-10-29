import { describe, expect, it } from "vitest";

import { redact, redactString, redactToJson } from "../redact";

const PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7
-----END PRIVATE KEY-----`;

describe("redactToJson", () => {
  it("scrubs password, token, secret and credential keys at any depth", () => {
    const result = redactToJson({
      name: "alice",
      password: "hunter2hunter2",
      newPassword: "hunter3hunter3",
      token: "abc",
      agentToken: "def",
      clientSecret: "ghi",
      credentialPassword: "jkl",
      nested: { list: [{ apiKey: "k", ok: 1 }] },
    }) as Record<string, any>;
    expect(result.name).toBe("alice");
    expect(result.password).toBe("<redacted>");
    expect(result.newPassword).toBe("<redacted>");
    expect(result.token).toBe("<redacted>");
    expect(result.agentToken).toBe("<redacted>");
    expect(result.clientSecret).toBe("<redacted>");
    expect(result.credentialPassword).toBe("<redacted>");
    expect(result.nested.list[0]).toEqual({ apiKey: "<redacted>", ok: 1 });
  });

  it("scrubs private keys and certificate material by key name", () => {
    const result = redactToJson({
      name: "edge",
      privateKey: "x",
      private_key: "x",
      privateKeyPem: PEM,
      fullchainPem:
        "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----",
      passphrase: "p",
      cookie: "session=abc",
    });
    expect(result).toEqual({
      name: "edge",
      privateKey: "<redacted>",
      private_key: "<redacted>",
      privateKeyPem: "<redacted>",
      fullchainPem: "<redacted>",
      passphrase: "<redacted>",
      cookie: "<redacted>",
    });
  });

  it("scrubs PEM blocks and bearer tokens embedded in free text", () => {
    const text = `failed to parse ${PEM} with Authorization: Bearer abc.def.ghi`;
    const result = redactToJson({ note: text }) as { note: string };
    expect(result.note).not.toContain("MIIEvQ");
    expect(result.note).not.toContain("BEGIN");
    expect(result.note).not.toContain("abc.def.ghi");
    expect(result.note).toContain("<redacted>");
  });

  it("cuts an unterminated PEM block to the end of the text", () => {
    const result = redactString("-----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN");
    expect(result).toBe("<redacted>");
  });

  it("truncates long strings and says how much was dropped", () => {
    const result = redactToJson(
      { body: "a".repeat(2000) },
      { maxStringLength: 100 },
    ) as { body: string };
    expect(result.body.startsWith("a".repeat(100))).toBe(true);
    expect(result.body).toContain("(+1900 chars)");
    expect(result.body.length).toBeLessThan(150);
  });

  it("truncates long arrays and marks the remainder", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `id-${i}`);
    const result = redactToJson({ ids }, { maxArrayItems: 50 }) as {
      ids: string[];
    };
    expect(result.ids).toHaveLength(51);
    expect(result.ids[49]).toBe("id-49");
    expect(result.ids[50]).toBe("…(+30 more)");
  });

  it("collapses an oversized value into a truncated preview", () => {
    const big = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`key${i}`, "v".repeat(20)]),
    );
    const result = redactToJson(big, { maxBytes: 256 }) as {
      _truncated: boolean;
      _preview: string;
    };
    expect(result._truncated).toBe(true);
    expect(
      new TextEncoder().encode(result._preview).length,
    ).toBeLessThanOrEqual(256);
  });

  it("keeps the redaction inside a truncated preview", () => {
    const result = redactToJson(
      { password: "pw-should-not-leak", filler: "x".repeat(400) },
      { maxBytes: 128 },
    );
    expect(JSON.stringify(result)).not.toContain("pw-should-not-leak");
  });

  it("produces JSON-safe output for bigint, dates, functions and cycles", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const result = redactToJson({
      big: 10n,
      at: new Date("2026-01-01T00:00:00Z"),
      fn: () => 1,
      cyclic,
    });
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result).toMatchObject({
      big: "10",
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("maps undefined to null", () => {
    expect(redactToJson(undefined)).toBeNull();
  });
});

describe("redact (MCP, string form)", () => {
  it("also scrubs the newly covered key names", () => {
    const parsed = JSON.parse(
      redact({ privateKeyPem: PEM, passphrase: "p", ok: "fine" }),
    );
    expect(parsed).toEqual({
      privateKeyPem: "<redacted>",
      passphrase: "<redacted>",
      ok: "fine",
    });
  });
});
