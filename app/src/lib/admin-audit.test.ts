import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ADMIN_AUDIT_ACTION_FAMILIES,
  ADMIN_AUDIT_ACTIONS,
  ADMIN_AUDIT_TARGET_TYPES,
  buildAdminAuditRow,
  bulkMetadata,
  fromInput,
  fromResult,
  getActionFamily,
  redactAuditError,
  redactAuditInput,
} from "./admin-audit";

const ACTION_RE = /^[a-z]+\.[a-z]+(_[a-z]+)*$/;

describe("ADMIN_AUDIT_ACTIONS", () => {
  it("uses unique dotted snake_case names", () => {
    expect(new Set(ADMIN_AUDIT_ACTIONS).size).toBe(ADMIN_AUDIT_ACTIONS.length);
    for (const action of ADMIN_AUDIT_ACTIONS) {
      expect(action, action).toMatch(ACTION_RE);
    }
  });

  it("belongs to a known family, and every family has an action", () => {
    const families = new Set<string>(ADMIN_AUDIT_ACTION_FAMILIES);
    for (const action of ADMIN_AUDIT_ACTIONS) {
      expect(families.has(getActionFamily(action)), action).toBe(true);
    }
    for (const family of ADMIN_AUDIT_ACTION_FAMILIES) {
      expect(
        ADMIN_AUDIT_ACTIONS.some((a) => getActionFamily(a) === family),
        family,
      ).toBe(true);
    }
  });
});

describe("getActionFamily", () => {
  it("returns the segment before the first dot", () => {
    expect(getActionFamily("user.ban")).toBe("user");
    expect(getActionFamily("subscription.bulk_update")).toBe("subscription");
    expect(getActionFamily("plain")).toBe("plain");
  });
});

/**
 * POST server functions that are deliberately NOT admin actions: they act as
 * the signed-in user on their own data, so recording them in the admin audit
 * trail would be wrong (and `adminAudit` skips non-admin sessions anyway).
 * Keyed `<file in src/query>:<export name>`; the value is the reason.
 *
 * An entry is checked, not trusted: the function must exist, must not carry
 * `adminAudit`, must not call `ensureAdmin` (an admin-gated function belongs
 * in the audited set), and must authenticate through `ensureSession`.
 */
const USER_FACING_POST_FNS: Readonly<Record<string, string>> = {
  "redeem-user.ts:redeemCode":
    "A user redeeming their own code; acts only on the session user's data.",
};

describe("every admin POST server function is audited", () => {
  const queryDir = fileURLToPath(new URL("../query/", import.meta.url));
  const seen: string[] = [];
  const exemptSeen = new Set<string>();
  const POST_FN_RE =
    /export const (\w+) = createServerFn\(\{[^}]*"POST"[^}]*\}\)([\s\S]*?)\.handler\(/g;

  for (const file of readdirSync(queryDir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(`${queryDir}${file}`, "utf8");
    for (const match of source.matchAll(POST_FN_RE)) {
      const [, name, chain] = match;
      const exemptionKey = `${file}:${name}`;
      if (exemptionKey in USER_FACING_POST_FNS) {
        exemptSeen.add(exemptionKey);
        // The handler runs up to the next top-level export.
        const rest = source.slice(match.index + match[0].length);
        const handler = rest.split(/\nexport /)[0]!;
        it(`${exemptionKey} is exempt as a user-facing function`, () => {
          expect(chain, "must not be admin-audited").not.toContain(
            "adminAudit(",
          );
          expect(handler, "must not be admin-gated").not.toContain(
            "ensureAdmin(",
          );
          expect(handler, "must authenticate the user").toContain(
            "ensureSession(",
          );
        });
        continue;
      }
      it(`${file}: ${name}`, () => {
        const audit = /adminAudit\(\s*"([a-z_.]+)"/.exec(chain!);
        expect(audit, `${name} lacks adminAudit()`).not.toBeNull();
        expect(ADMIN_AUDIT_ACTIONS).toContain(audit![1]);
        seen.push(audit![1]!);
      });
    }
  }

  it("only exempts functions that exist", () => {
    expect([...exemptSeen].sort()).toEqual(
      Object.keys(USER_FACING_POST_FNS).sort(),
    );
  });

  it("uses each declared action exactly once", () => {
    expect([...seen].sort()).toEqual([...ADMIN_AUDIT_ACTIONS].sort());
  });
});

describe("target resolvers", () => {
  it("fromInput / fromResult read nested paths and tolerate junk", () => {
    expect(fromInput("userId")({ input: { userId: "u1" }, result: 1 })).toBe(
      "u1",
    );
    expect(
      fromResult(
        "server",
        "id",
      )({
        input: null,
        result: { server: { id: "s" } },
      }),
    ).toBe("s");
    expect(fromInput("a", "b")({ input: { a: 1 }, result: null })).toBe(
      undefined,
    );
    expect(fromInput("a")({ input: undefined, result: null })).toBe(undefined);
  });

  it("bulkMetadata lists ids and outcome counts", () => {
    expect(
      bulkMetadata({
        input: { ids: ["a", "b", "c"], action: { type: "delete" } },
        result: {
          succeeded: 1,
          failed: [{ id: "b", message: "nope" }],
          skipped: ["c"],
        },
      }),
    ).toEqual({
      ids: ["a", "b", "c"],
      succeeded: 1,
      failed: ["b"],
      skipped: ["c"],
    });
    expect(bulkMetadata({ input: {}, result: undefined })).toEqual({ ids: [] });
  });
});

describe("redactAuditInput", () => {
  it("scrubs passwords but keeps ordinary fields", () => {
    expect(
      redactAuditInput({ id: "u1", password: "correct horse battery" }),
    ).toEqual({ id: "u1", password: "<redacted>" });
  });

  it("scrubs certificate import material", () => {
    const stored = JSON.stringify(
      redactAuditInput({
        name: "edge",
        fullchainPem:
          "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----",
        privateKeyPem:
          "-----BEGIN PRIVATE KEY-----\nBBBB\n-----END PRIVATE KEY-----",
      }),
    );
    expect(stored).not.toContain("AAAA");
    expect(stored).not.toContain("BBBB");
    expect(stored).toContain("edge");
  });

  it("truncates long note bodies and long id lists", () => {
    const stored = redactAuditInput({
      body: "n".repeat(5000),
      ids: Array.from({ length: 200 }, (_, i) => `id-${i}`),
    }) as { body: string; ids: string[] };
    expect(stored.body.length).toBeLessThan(600);
    expect(stored.ids).toHaveLength(51);
  });

  it("stores no input as null", () => {
    expect(redactAuditInput(undefined)).toBeNull();
  });
});

describe("redactAuditError", () => {
  it("scrubs secrets and cuts long messages", () => {
    expect(redactAuditError(new Error("bad password=hunter2 here"))).toBe(
      "bad password=<redacted> here",
    );
    expect(redactAuditError(new Error("x".repeat(5000))).length).toBeLessThan(
      1100,
    );
    expect(redactAuditError("plain string")).toBe("plain string");
  });
});

describe("buildAdminAuditRow", () => {
  const base = {
    id: "row-1",
    action: "user.ban" as const,
    input: { userId: "u1", reason: "spam" },
    failed: false,
    actor: { id: "admin-1", email: "root@example.com" },
    ip: "1.2.3.4",
    userAgent: "vitest",
    durationMs: 12.6,
  };

  it("builds a success row with target, actor and context", () => {
    const row = buildAdminAuditRow({
      ...base,
      meta: { targetType: "user", targetId: fromInput("userId") },
      result: { id: "u1" },
    });
    expect(row).toMatchObject({
      id: "row-1",
      actorUserId: "admin-1",
      actorEmail: "root@example.com",
      action: "user.ban",
      targetType: "user",
      targetId: "u1",
      status: "success",
      input: { userId: "u1", reason: "spam" },
      metadata: null,
      error: null,
      ip: "1.2.3.4",
      userAgent: "vitest",
      impersonatedBy: null,
      durationMs: 13,
    });
  });

  it("records the thrown error, redacted", () => {
    const row = buildAdminAuditRow({
      ...base,
      failed: true,
      error: new Error("Forbidden token=abc123"),
    });
    expect(row.status).toBe("error");
    expect(row.error).toBe("Forbidden token=<redacted>");
  });

  it("takes a created record's id from the result, never storing the result", () => {
    const row = buildAdminAuditRow({
      ...base,
      action: "server.create",
      input: { name: "tokyo" },
      meta: { targetType: "server", targetId: fromResult("server", "id") },
      result: { server: { id: "srv-1" }, token: "secret-token" },
    });
    expect(row.targetId).toBe("srv-1");
    expect(JSON.stringify(row)).not.toContain("secret-token");
  });

  it("survives a resolver that throws and non-string ids", () => {
    const row = buildAdminAuditRow({
      ...base,
      meta: {
        targetType: "user",
        targetId: () => {
          throw new Error("boom");
        },
        metadata: () => {
          throw new Error("boom");
        },
      },
    });
    expect(row.targetId).toBeNull();
    expect(row.metadata).toBeNull();
    expect(
      buildAdminAuditRow({ ...base, meta: { targetId: () => ({ x: 1 }) } })
        .targetId,
    ).toBeNull();
    expect(
      buildAdminAuditRow({ ...base, meta: { targetId: () => 42 } }).targetId,
    ).toBe("42");
  });

  it("stores bulk ids in metadata and marks impersonation", () => {
    const row = buildAdminAuditRow({
      ...base,
      action: "user.bulk_update",
      input: { ids: ["a", "b"], action: { type: "unban" } },
      result: { succeeded: 2, failed: [], skipped: [] },
      meta: { targetType: "user", metadata: bulkMetadata },
      impersonatedBy: "admin-2",
    });
    expect(row.targetId).toBeNull();
    expect(row.metadata).toEqual({
      ids: ["a", "b"],
      succeeded: 2,
      failed: [],
      skipped: [],
    });
    expect(row.impersonatedBy).toBe("admin-2");
  });

  it("bounds the user agent and ip", () => {
    const row = buildAdminAuditRow({
      ...base,
      userAgent: "u".repeat(2000),
      ip: "i".repeat(200),
    });
    expect(row.userAgent).toHaveLength(512);
    expect(row.ip).toHaveLength(64);
  });
});

describe("target types", () => {
  it("are unique", () => {
    expect(new Set(ADMIN_AUDIT_TARGET_TYPES).size).toBe(
      ADMIN_AUDIT_TARGET_TYPES.length,
    );
  });
});
