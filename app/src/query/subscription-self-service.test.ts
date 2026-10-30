import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyPublishGate } from "@/lib/publish-gate";
import type { ResolvedNode } from "@/query/subscription-access";

interface Row {
  id: string;
  userId: string;
  planId: string;
  status: "active";
  expiresAt: Date;
  credentialUuid: string;
  credentialPassword: string;
  token: string;
}

const mocks = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  session: null as { user: { id: string } } | null,
  rotateCredentials: vi.fn(),
  execute: vi.fn(),
  listServerIdsForSubscriptionId: vi.fn(),
  listPendingConfigChanges: vi.fn(),
}));

// Minimal createServerFn: runs the validator, then the handler, so the test
// exercises the same input parsing a real call would.
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => {
    let validate = (input: unknown) => input;
    const builder = {
      middleware: () => builder,
      validator: (schema: { parse: (input: unknown) => unknown }) => {
        validate = (input) => schema.parse(input);
        return builder;
      },
      handler:
        (fn: (ctx: { data: unknown }) => unknown) =>
        (arg?: { data: unknown }) =>
          Promise.resolve().then(() => fn({ data: validate(arg?.data) })),
    };
    return builder;
  },
}));

vi.mock("@/lib/auth", () => ({
  ensureSession: async () => {
    if (!mocks.session) {
      throw new Error("Unauthorized");
    }
    return mocks.session;
  },
}));

vi.mock("@/query/config-change", () => ({
  listServerIdsForSubscriptionId: mocks.listServerIdsForSubscriptionId,
  listPendingConfigChanges: mocks.listPendingConfigChanges,
}));

// Credential rotation is one multi-CTE SQL statement whose behaviour (atomicity,
// locking, owner scoping) only a real PostgreSQL can show; that is covered by
// subscription-credential-rotation.integration.test.ts. Here the self-service
// module sees it as a spy, while the token rotation stays the real function over
// the in-memory table below. The real function is still reachable through
// `vi.importActual` for the SQL-shape checks at the bottom.
vi.mock("@/query/subscription-write", async (importActual) => ({
  ...(await importActual<typeof import("./subscription-write")>()),
  rotateSubscriptionCredentials: mocks.rotateCredentials,
}));

// In-memory stand-in for the subscription table. A `where` condition is
// rendered to SQL and every `"subscription"."col" = $n` term must hold for a
// row to match, so a missing owner predicate shows up as a cross-user match.
const dialect = new PgDialect();
function matches(row: Record<string, unknown>, cond: unknown): boolean {
  const { sql, params } = dialect.sqlToQuery(cond as never);
  if (/\bor\b/i.test(sql)) {
    throw new Error(`unsupported condition: ${sql}`);
  }
  const terms = [...sql.matchAll(/"subscription"\."(\w+)" = \$(\d+)/g)];
  if (terms.length === 0) {
    throw new Error(`unsupported condition: ${sql}`);
  }
  return terms.every(([, column, n]) => {
    const field = column!.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());
    return row[field] === params[Number(n) - 1];
  });
}

vi.mock("@/db", () => ({
  db: {
    execute: (query: unknown) => mocks.execute(query),
    select: (projection?: Record<string, unknown>) => ({
      from: () => ({
        where: (cond: unknown) => {
          const found = mocks.rows.filter((r) => matches(r, cond));
          return Promise.resolve(
            projection
              ? found.map((r) =>
                  Object.fromEntries(
                    Object.keys(projection).map((k) => [k, r[k]]),
                  ),
                )
              : found.map((r) => ({ ...r })),
          );
        },
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: (cond: unknown) => ({
          returning: () => {
            const found = mocks.rows.filter((r) => matches(r, cond));
            for (const r of found) {
              Object.assign(r, values);
            }
            return Promise.resolve(found.map((r) => ({ ...r })));
          },
        }),
      }),
    }),
  },
}));

import {
  getOwnCredentialApplyState,
  rotateOwnSubscriptionCredentials,
  rotateOwnSubscriptionToken,
} from "./subscription-self-service";
import { rotateSubscriptionToken } from "./subscription-write";

const FAKE = {
  aliceUuid: "00000000-0000-4000-8000-0000000000a1",
  alicePassword: "fake-alice-password-old",
  aliceToken: "fake-alice-token-old",
  bobUuid: "00000000-0000-4000-8000-0000000000b1",
  bobPassword: "fake-bob-password",
  bobToken: "fake-bob-token",
};

function seed() {
  const base = {
    planId: "plan-1",
    status: "active" as const,
    expiresAt: new Date("2099-01-01T00:00:00Z"),
  };
  mocks.rows = [
    {
      ...base,
      id: "sub-alice",
      userId: "alice",
      credentialUuid: FAKE.aliceUuid,
      credentialPassword: FAKE.alicePassword,
      token: FAKE.aliceToken,
    },
    {
      ...base,
      id: "sub-bob",
      userId: "bob",
      credentialUuid: FAKE.bobUuid,
      credentialPassword: FAKE.bobPassword,
      token: FAKE.bobToken,
    },
  ];
}

const row = (id: string) =>
  mocks.rows.find((r) => r.id === id) as unknown as Row;
const call = (fn: unknown, id: unknown, extra: object = {}) =>
  (fn as (arg: { data: unknown }) => Promise<unknown>)({
    data: { id, ...extra },
  });

beforeEach(() => {
  seed();
  mocks.session = { user: { id: "alice" } };
  mocks.rotateCredentials.mockReset();
  mocks.execute.mockReset();
  mocks.listServerIdsForSubscriptionId
    .mockReset()
    .mockResolvedValue(["srv-a", "srv-b"]);
  mocks.listPendingConfigChanges.mockReset().mockResolvedValue([]);
});

describe("rotateOwnSubscriptionToken", () => {
  it("rotates the caller's own link token and nothing else", async () => {
    const result = await call(rotateOwnSubscriptionToken, "sub-alice");

    const alice = row("sub-alice");
    expect(alice.token).not.toBe(FAKE.aliceToken);
    expect(result).toEqual({ id: "sub-alice", token: alice.token });
    // Old URL is dead: no row answers to the old token any more.
    expect(mocks.rows.some((r) => r.token === FAKE.aliceToken)).toBe(false);
    // Proxy credentials are unchanged, so already-imported clients still work.
    expect(alice.credentialUuid).toBe(FAKE.aliceUuid);
    expect(alice.credentialPassword).toBe(FAKE.alicePassword);
    // Token-only rotation moves no agent state: no publish-gate record.
    expect(mocks.execute).not.toHaveBeenCalled();
    expect(mocks.rotateCredentials).not.toHaveBeenCalled();
    // Other users are untouched.
    expect(row("sub-bob").token).toBe(FAKE.bobToken);
  });

  it("rejects another user's subscription id and changes nothing", async () => {
    await expect(call(rotateOwnSubscriptionToken, "sub-bob")).rejects.toThrow(
      "Not found",
    );
    expect(row("sub-bob").token).toBe(FAKE.bobToken);
    expect(row("sub-alice").token).toBe(FAKE.aliceToken);
  });

  it("answers a foreign id exactly like a missing one", async () => {
    const foreign = await call(rotateOwnSubscriptionToken, "sub-bob").catch(
      (e: Error) => e.message,
    );
    const missing = await call(rotateOwnSubscriptionToken, "nope").catch(
      (e: Error) => e.message,
    );
    expect(foreign).toBe(missing);
  });

  it("ignores an owner supplied in the input; the session decides", async () => {
    await expect(
      call(rotateOwnSubscriptionToken, "sub-bob", { userId: "bob" }),
    ).rejects.toThrow("Not found");
    expect(row("sub-bob").token).toBe(FAKE.bobToken);
  });

  it("requires a session", async () => {
    mocks.session = null;
    await expect(call(rotateOwnSubscriptionToken, "sub-alice")).rejects.toThrow(
      "Unauthorized",
    );
    expect(row("sub-alice").token).toBe(FAKE.aliceToken);
  });

  it("validates the id", async () => {
    await expect(call(rotateOwnSubscriptionToken, "")).rejects.toThrow();
  });
});

describe("rotateOwnSubscriptionCredentials", () => {
  const rotated = (serverIds: string[]) => ({
    row: {
      ...row("sub-alice"),
      credentialUuid: "00000000-0000-4000-8000-0000000000a9",
      credentialPassword: "fake-alice-password-new",
    },
    serverIds,
    changeId: serverIds.length > 0 ? "change-1" : null,
  });

  it("scopes the rotation to the session user and reports pending servers", async () => {
    mocks.rotateCredentials.mockResolvedValue(rotated(["srv-a", "srv-b"]));

    const result = await call(rotateOwnSubscriptionCredentials, "sub-alice");

    expect(mocks.rotateCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.rotateCredentials).toHaveBeenCalledWith("sub-alice", {
      ownerUserId: "alice",
    });
    // Pending agent state is reported back to the caller.
    expect(result).toEqual({ id: "sub-alice", pendingServerCount: 2 });
  });

  it("never returns raw credentials, old or new", async () => {
    const outcome = rotated(["srv-a", "srv-b"]);
    mocks.rotateCredentials.mockResolvedValue(outcome);
    const result = await call(rotateOwnSubscriptionCredentials, "sub-alice");
    const serialized = JSON.stringify(result);
    for (const secret of [
      FAKE.aliceUuid,
      FAKE.alicePassword,
      outcome.row.credentialUuid,
      outcome.row.credentialPassword,
    ]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("reports nothing pending when the plan has no enabled nodes", async () => {
    mocks.rotateCredentials.mockResolvedValue(rotated([]));
    expect(await call(rotateOwnSubscriptionCredentials, "sub-alice")).toEqual({
      id: "sub-alice",
      pendingServerCount: 0,
    });
  });

  it("takes the owner from the session, never from the input", async () => {
    mocks.rotateCredentials.mockRejectedValue(new Error("Not found"));
    await expect(
      call(rotateOwnSubscriptionCredentials, "sub-bob", { userId: "bob" }),
    ).rejects.toThrow("Not found");
    expect(mocks.rotateCredentials).toHaveBeenCalledWith("sub-bob", {
      ownerUserId: "alice",
    });
  });

  it("requires a session", async () => {
    mocks.session = null;
    await expect(
      call(rotateOwnSubscriptionCredentials, "sub-alice"),
    ).rejects.toThrow("Unauthorized");
    expect(mocks.rotateCredentials).not.toHaveBeenCalled();
  });

  it("validates the id", async () => {
    await expect(call(rotateOwnSubscriptionCredentials, "")).rejects.toThrow();
    expect(mocks.rotateCredentials).not.toHaveBeenCalled();
  });

  it("keeps old credentials in the subscription until a server applies the rotation", async () => {
    // What the rotation records for the gate: the credentials before it.
    const change = {
      kind: "credential" as const,
      subjectId: "sub-alice",
      prevRow: {
        credentialUuid: FAKE.aliceUuid,
        credentialPassword: FAKE.alicePassword,
      },
    };
    const alice = {
      ...row("sub-alice"),
      credentialUuid: "00000000-0000-4000-8000-0000000000a9",
      credentialPassword: "fake-alice-password-new",
    };
    const node = (id: string, serverId: string) =>
      ({
        node: { id, serverId },
        server: { id: serverId, name: serverId, address: "example.com" },
        address: "example.com",
        certificateKind: null,
      }) as unknown as ResolvedNode;

    // srv-a has not applied the rotation yet; srv-b has (no pending link).
    const gated = applyPublishGate({
      now: new Date("2026-06-01T00:00:00Z"),
      subscription: alice,
      user: { banned: null, banExpires: null },
      nodes: [node("n-a", "srv-a"), node("n-b", "srv-b")],
      pending: [{ ...change, serverId: "srv-a", revisionSeq: 2 }],
      planGroupIds: new Map(),
      groupNodeIds: new Map(),
    });

    expect(gated.credentialsByNodeId.get("n-a")).toEqual({
      uuid: FAKE.aliceUuid,
      password: FAKE.alicePassword,
    });
    // Applied server: the subscription emits the new (current) credentials.
    expect(gated.credentialsByNodeId.has("n-b")).toBe(false);
    expect(alice.credentialUuid).not.toBe(FAKE.aliceUuid);
  });
});

describe("getOwnCredentialApplyState", () => {
  it("counts distinct servers still pending for this subscription's credential rotation", async () => {
    mocks.listPendingConfigChanges.mockResolvedValue([
      { kind: "credential", subjectId: "sub-alice", serverId: "srv-a" },
      { kind: "credential", subjectId: "sub-alice", serverId: "srv-a" },
      { kind: "node", subjectId: "sub-alice", serverId: "srv-b" },
      { kind: "credential", subjectId: "sub-bob", serverId: "srv-b" },
    ]);
    expect(await call(getOwnCredentialApplyState, "sub-alice")).toEqual({
      id: "sub-alice",
      pendingServerCount: 1,
    });
    expect(mocks.listPendingConfigChanges).toHaveBeenCalledWith([
      "srv-a",
      "srv-b",
    ]);
  });

  it("reports zero once every server has applied", async () => {
    expect(await call(getOwnCredentialApplyState, "sub-alice")).toEqual({
      id: "sub-alice",
      pendingServerCount: 0,
    });
  });

  it("rejects another user's subscription id without looking at servers", async () => {
    await expect(call(getOwnCredentialApplyState, "sub-bob")).rejects.toThrow(
      "Not found",
    );
    expect(mocks.listServerIdsForSubscriptionId).not.toHaveBeenCalled();
    expect(mocks.listPendingConfigChanges).not.toHaveBeenCalled();
  });
});

describe("rotateSubscriptionCredentials statement shape", () => {
  // Not a substitute for the PostgreSQL integration test: it only pins the
  // properties of the SQL that the atomicity argument rests on.
  async function statement(options?: { ownerUserId: string }) {
    const actual = await vi.importActual<typeof import("./subscription-write")>(
      "./subscription-write",
    );
    mocks.execute.mockResolvedValue({ rows: [] });
    await expect(
      actual.rotateSubscriptionCredentials("sub-bob", options),
    ).rejects.toThrow("Not found");
    expect(mocks.execute).toHaveBeenCalledTimes(1);
    return dialect.sqlToQuery(mocks.execute.mock.calls[0]![0] as never);
  }

  it("is one statement that rotates, bumps and records together", async () => {
    const { sql, params } = await statement();
    expect(sql).toMatch(/\bfor update\b/i);
    expect(sql).toMatch(/update "subscription"/i);
    expect(sql).toMatch(/update "server"/i);
    expect(sql).toMatch(/insert into "config_change"/i);
    expect(sql).toMatch(/insert into "config_change_server"/i);
    // Admin scope: the id is bound, no owner predicate.
    expect(params).toContain("sub-bob");
    expect(sql).not.toMatch(/"subscription"\."user_id" = /);
  });

  it("filters on the owner inside the locking select when scoped", async () => {
    const { sql, params } = await statement({ ownerUserId: "alice" });
    expect(params).toContain("alice");
    const target = sql.slice(0, sql.search(/\bfor update\b/i));
    expect(target).toMatch(/"subscription"\."user_id" = \$\d+::text/);
  });
});

describe("shared helpers keep admin behaviour", () => {
  it("rotates any user's token when no owner scope is given", async () => {
    const updated = await rotateSubscriptionToken("sub-bob");
    expect(updated.token).not.toBe(FAKE.bobToken);
    expect(updated.credentialUuid).toBe(FAKE.bobUuid);
  });

  it("still reports a missing id as Not found", async () => {
    await expect(rotateSubscriptionToken("nope")).rejects.toThrow("Not found");
  });
});
