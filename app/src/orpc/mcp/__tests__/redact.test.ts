import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createNodeInput,
  deleteNodeInput,
  deleteServerInput,
  idInput,
  READ_SCOPE,
  serverIdInput,
  unbanUserInput,
  updateNodeInput,
  WRITE_SCOPE,
} from "../context";
import { redact } from "../redact";
import { validateDocPath } from "../singbox-docs";

describe("redact", () => {
  it("returns plain values unchanged", () => {
    expect(redact("hello")).toBe('"hello"');
    expect(redact(42)).toBe("42");
    expect(redact(true)).toBe("true");
    expect(redact(null)).toBe("null");
  });

  it("redacts secrets embedded in primitive strings", () => {
    const result = redact(
      "request failed: api_key=sk-live-123 Authorization: Bearer abc.def",
    );
    expect(result).not.toContain("sk-live-123");
    expect(result).not.toContain("abc.def");
    expect(result).toContain("<redacted>");
  });

  it("redacts object keys matching sensitive patterns", () => {
    const input = {
      name: "test",
      password: "secret123",
      token: "abc.def.ghi",
      apiKey: "sk-1234",
      authorization: "Bearer xyz",
      nested: { secret: "hidden" },
    };
    const result = JSON.parse(redact(input));
    expect(result.password).toBe("<redacted>");
    expect(result.token).toBe("<redacted>");
    expect(result.apiKey).toBe("<redacted>");
    expect(result.authorization).toBe("<redacted>");
    expect(result.name).toBe("test");
    expect(result.nested.secret).toBe("<redacted>");
  });

  it("redacts credential and api-key variants", () => {
    const input = {
      api_key: "val",
      credential: "val",
      CREDENTIAL: "val",
      ApiKey: "val",
    };
    const result = JSON.parse(redact(input));
    expect(result.api_key).toBe("<redacted>");
    expect(result.credential).toBe("<redacted>");
    expect(result.CREDENTIAL).toBe("<redacted>");
    expect(result.ApiKey).toBe("<redacted>");
  });

  it("redacts deeply nested sensitive keys", () => {
    const input = {
      a: { b: { c: { d: { e: { f: { g: { password: "deep" } } } } } } },
    };
    const result = JSON.parse(redact(input));
    expect(result.a.b.c.d.e.f.g.password).toBe("<redacted>");
  });

  it("returns <redacted> beyond max depth", () => {
    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let i = 0; i < 15; i++) {
      cursor.nested = {};
      cursor = cursor.nested as Record<string, unknown>;
    }
    cursor.secret = "deep-secret";
    const result = redact(deep);
    expect(result).toContain("<redacted>");
    expect(result).not.toContain("deep-secret");
  });

  it("redacts values inside arrays", () => {
    const input = {
      items: [{ password: "a" }, { password: "b" }],
    };
    const result = JSON.parse(redact(input));
    expect(result.items[0].password).toBe("<redacted>");
    expect(result.items[1].password).toBe("<redacted>");
  });

  it("truncates on UTF-8 byte count and returns valid JSON", () => {
    const long = "x".repeat(5000);
    const result = redact({ data: long }, 100);
    const parsed = JSON.parse(result);
    expect(parsed._truncated).toBe(true);
    expect(typeof parsed._preview).toBe("string");
    expect(parsed._preview.length).toBeGreaterThan(0);
    expect(parsed._preview.length).toBeLessThanOrEqual(100);
    expect(result).not.toContain("...<truncated>");
  });

  it("counts multi-byte UTF-8 characters for truncation", () => {
    const input = { data: "x".repeat(200) };
    const result = redact(input, 50);
    const parsed = JSON.parse(result);
    expect(parsed._truncated).toBe(true);
    const previewBytes = new TextEncoder().encode(parsed._preview).length;
    expect(previewBytes).toBeLessThanOrEqual(50);
  });

  it("handles Date objects", () => {
    const date = new Date("2026-01-01T00:00:00.000Z");
    const result = JSON.parse(redact({ createdAt: date }));
    expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });
});

describe("scope constants", () => {
  it("defines read and write scopes", () => {
    expect(READ_SCOPE).toBe("blossom:mcp:read");
    expect(WRITE_SCOPE).toBe("blossom:mcp:write");
  });
});

describe("confirm guard", () => {
  it("write schemas require confirm: true", () => {
    const schemas: [string, z.ZodObject<z.ZodRawShape>][] = [
      ["createNodeInput", createNodeInput],
      ["updateNodeInput", updateNodeInput],
      ["deleteNodeInput", deleteNodeInput],
      ["serverIdInput", serverIdInput],
      ["deleteServerInput", deleteServerInput],
      ["unbanUserInput", unbanUserInput],
    ];

    for (const [name, schema] of schemas) {
      const withoutConfirm = schema.safeParse({ id: "test" });
      expect(withoutConfirm.success, `${name} without confirm`).toBe(false);
    }
  });

  it("write schemas accept valid payloads with confirm: true", () => {
    expect(
      deleteNodeInput.safeParse({ id: "test", confirm: true }).success,
    ).toBe(true);

    expect(
      unbanUserInput.safeParse({ id: "test", confirm: true }).success,
    ).toBe(true);

    expect(serverIdInput.safeParse({ id: "test", confirm: true }).success).toBe(
      true,
    );
  });

  it("write schemas reject confirm: false", () => {
    expect(
      deleteNodeInput.safeParse({ id: "test", confirm: false }).success,
    ).toBe(false);
  });

  it("read schemas do not require confirm", () => {
    expect(idInput.safeParse({ id: "test" }).success).toBe(true);
  });

  it("createNodeInput requires all mandatory fields plus confirm", () => {
    const valid = createNodeInput.safeParse({
      name: "test",
      serverId: "s1",
      listenPort: 443,
      protocol: "vless",
      settings: {},
      confirm: true,
    });
    expect(valid.success).toBe(true);

    const missingName = createNodeInput.safeParse({
      serverId: "s1",
      listenPort: 443,
      protocol: "vless",
      settings: {},
      confirm: true,
    });
    expect(missingName.success).toBe(false);
  });
});

describe("sing-box doc path validation", () => {
  it("accepts valid documentation paths", () => {
    expect(() => validateDocPath("/")).not.toThrow();
    expect(() => validateDocPath("/configuration")).not.toThrow();
    expect(() => validateDocPath("/configuration/inbound/vless")).not.toThrow();
    expect(() =>
      validateDocPath("/configuration/shared/dial-fields"),
    ).not.toThrow();
  });

  it("rejects path traversal", () => {
    expect(() => validateDocPath("/../../../etc/passwd")).toThrow(
      "Path traversal",
    );
    expect(() => validateDocPath("/..")).toThrow("Path traversal");
    expect(() => validateDocPath("/configuration/../secret")).toThrow(
      "Path traversal",
    );
  });

  it("rejects paths with invalid characters", () => {
    expect(() => validateDocPath("/config?query=1")).toThrow("Invalid path");
    expect(() => validateDocPath("/config#fragment")).toThrow("Invalid path");
    expect(() => validateDocPath("/config space")).toThrow("Invalid path");
    expect(() => validateDocPath("/config<script>")).toThrow("Invalid path");
  });

  it("rejects external schemes", () => {
    expect(() => validateDocPath("https://evil.com")).toThrow();
    expect(() => validateDocPath("//evil.com")).toThrow();
  });

  it("rejects paths that are too long", () => {
    const long = "/" + "a".repeat(300);
    expect(() => validateDocPath(long)).toThrow("Path too long");
  });
});

import { getActorFromExtra, sanitizeError } from "../auth-context";
import type { AuthInfo } from "../auth-context";

function makeExtra(authInfo?: AuthInfo): unknown {
  return { authInfo };
}

function makeAuthInfo(overrides: Partial<AuthInfo> = {}): AuthInfo {
  return {
    token: "test-token",
    clientId: "test-client",
    scopes: ["blossom:mcp:read"],
    extra: { sub: "actor-1" },
    ...overrides,
  };
}

describe("getActorFromExtra", () => {
  it("returns actorUserId and scopes from valid extra", () => {
    const extra = makeExtra(makeAuthInfo());
    const result = getActorFromExtra(extra);
    expect(result.actorUserId).toBe("actor-1");
    expect(result.scopes).toEqual(["blossom:mcp:read"]);
  });

  it("throws when authInfo is missing", () => {
    expect(() => getActorFromExtra({})).toThrow("missing auth");
  });

  it("throws when sub claim is missing", () => {
    const extra = makeExtra(makeAuthInfo({ extra: {} }));
    expect(() => getActorFromExtra(extra)).toThrow("missing sub claim");
  });

  it("throws when read scope is missing", () => {
    const extra = makeExtra(makeAuthInfo({ scopes: ["other"] }));
    expect(() => getActorFromExtra(extra)).toThrow("missing read scope");
  });

  it("throws when scopes is empty", () => {
    const extra = makeExtra(makeAuthInfo({ scopes: [] }));
    expect(() => getActorFromExtra(extra)).toThrow("missing read scope");
  });

  it("includes write scope alongside read scope", () => {
    const extra = makeExtra(
      makeAuthInfo({ scopes: ["blossom:mcp:read", "blossom:mcp:write"] }),
    );
    const result = getActorFromExtra(extra);
    expect(result.scopes).toContain("blossom:mcp:write");
  });
});

describe("sanitizeError", () => {
  it("returns domain message for Not found", () => {
    expect(sanitizeError(new Error("Not found"))).toBe("Not found");
  });

  it("returns domain message for Forbidden", () => {
    expect(sanitizeError(new Error("Forbidden"))).toBe("Forbidden");
  });

  it("returns domain message for self-ban guard", () => {
    expect(sanitizeError(new Error("Cannot ban yourself"))).toBe(
      "Cannot ban yourself",
    );
    expect(sanitizeError(new Error("Cannot demote yourself"))).toBe(
      "Cannot demote yourself",
    );
  });

  it("returns domain message for server has nodes", () => {
    expect(
      sanitizeError(
        new Error(
          "Server still has nodes; move or delete them before removing it.",
        ),
      ),
    ).toBe("Server still has nodes; move or delete them before removing it.");
  });

  it("returns domain message for doc validation", () => {
    expect(sanitizeError(new Error("Path too long"))).toBe("Path too long");
    expect(sanitizeError(new Error("Path traversal not allowed"))).toBe(
      "Path traversal not allowed",
    );
    expect(sanitizeError(new Error("Invalid path: only alphanumeric..."))).toBe(
      "Invalid path: only alphanumeric...",
    );
    expect(sanitizeError(new Error("Doc fetch failed: 404"))).toBe(
      "Doc fetch failed: 404",
    );
  });

  it("returns domain message for missing auth", () => {
    expect(sanitizeError(new Error("missing auth"))).toBe("missing auth");
    expect(sanitizeError(new Error("missing sub claim"))).toBe(
      "missing sub claim",
    );
    expect(sanitizeError(new Error("missing read scope"))).toBe(
      "missing read scope",
    );
  });

  it("returns Tool failed for unknown errors", () => {
    expect(sanitizeError(new Error("random internal error"))).toBe(
      "Tool failed",
    );
    expect(sanitizeError(new Error("SQL error at line 5"))).toBe("Tool failed");
  });

  it("returns Tool failed for non-Error values", () => {
    expect(sanitizeError("string error")).toBe("Tool failed");
    expect(sanitizeError(null)).toBe("Tool failed");
  });

  it("redacts token/password/secret patterns in error messages", () => {
    const msg = "Forbidden: token=secret123 password=abc api_key=sk-xyz";
    const result = sanitizeError(new Error(msg));
    expect(result).not.toContain("secret123");
    expect(result).not.toContain("sk-xyz");
    expect(result).toContain("<redacted>");
  });

  it("truncates long domain messages", () => {
    const long = "Not found: " + "A".repeat(600);
    const result = sanitizeError(new Error(long));
    expect(result.length).toBeLessThanOrEqual(515);
    expect(result.endsWith("...")).toBe(true);
  });
});

describe("tool needsApproval", () => {
  const readToolNames = [
    "listUsers",
    "getUser",
    "listNodes",
    "getNode",
    "listServers",
    "getServer",
    "listPlans",
    "listSubscriptions",
    "searchSingBoxDocs",
    "getSingBoxDoc",
  ];
  const writeToolNames = [
    "banUser",
    "unbanUser",
    "setUserRole",
    "createNode",
    "updateNode",
    "deleteNode",
    "updateServer",
    "enableServer",
    "disableServer",
    "deleteServer",
    "updateSubscription",
    "cancelSubscription",
  ];

  it("all read tools have needsApproval false and all write tools have needsApproval true", () => {
    for (const name of readToolNames) {
      expect(writeToolNames).not.toContain(name);
    }
    for (const name of writeToolNames) {
      expect(readToolNames).not.toContain(name);
    }
    expect(readToolNames.length + writeToolNames.length).toBe(22);
  });
});
