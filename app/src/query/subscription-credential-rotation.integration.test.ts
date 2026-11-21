/**
 * Integration tests for credential rotation against a REAL, DISPOSABLE
 * PostgreSQL. They are skipped unless BLOSSOM_TEST_PG_URL is set, so
 * `pnpm test` and CI need no database.
 *
 *   BLOSSOM_TEST_PG_URL            postgres://… on a loopback host, database
 *                                  name starting with `blossom_disposable_`.
 *                                  The public schema is DROPPED and rebuilt
 *                                  from app/drizzle/*, and tables are emptied
 *                                  between tests. Never point it at real data.
 *   BLOSSOM_TEST_NEON_HTTP_URL     optional: the `/sql` endpoint of a local
 *                                  Neon HTTP proxy (local-neon-http-proxy)
 *                                  that fronts the SAME disposable database.
 *                                  Enables the neon-http suite.
 *   BLOSSOM_TEST_NEON_CONNECTION_URL matching database credentials using
 *                                  db.localtest.me as the host.
 *
 * What the neon-http suite does and does not show: it runs the app's real
 * `drizzle-orm/neon-http` + `@neondatabase/serverless` driver stack, where each
 * query is one HTTP request with no interactive transaction, against a local
 * proxy in front of PostgreSQL. It is NOT a test against Neon's hosted service.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { eq } from "drizzle-orm";
import { drizzle as drizzleNeon } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { user } from "@/db/auth-schema";
import { plan, planGroup, subscription } from "@/db/plan-schema";
import { node, nodeGroup, proxyGroup, server } from "@/db/proxy-schema";

const holder = vi.hoisted(() => ({
  db: undefined as unknown as Record<PropertyKey, unknown>,
  session: null as { user: { id: string } } | null,
}));

vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: (_target, key) => {
        const value = Reflect.get(holder.db, key);
        return typeof value === "function" ? value.bind(holder.db) : value;
      },
    },
  ),
}));

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
    if (!holder.session) {
      throw new Error("Unauthorized");
    }
    return holder.session;
  },
}));
vi.mock("@/lib/ensure-admin", () => ({
  ensureAdmin: async () => ({ user: { id: "admin", role: "admin" } }),
}));
vi.mock("@/lib/admin-audit-middleware", () => ({ adminAudit: () => ({}) }));

import {
  listServerIdsForSubscriptionId,
  recordConfigChange,
} from "@/query/config-change";
import {
  findSubscriptionByToken,
  getGatedSubscriptionView,
  getNodeActiveSubscriptions,
  getSubscriptionAccessibleNodes,
} from "@/query/subscription-access";

import {
  rotateOwnSubscriptionCredentials,
  rotateOwnSubscriptionToken,
} from "./subscription-self-service";
import {
  rotateSubscriptionCredentials,
  rotateSubscriptionToken,
} from "./subscription-write";
import { resetSubscriptionCredentials } from "./subscriptions";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;
const NEON_URL = process.env.BLOSSOM_TEST_NEON_HTTP_URL;
const NEON_CONNECTION_URL = process.env.BLOSSOM_TEST_NEON_CONNECTION_URL;

function assertDisposable(raw: string) {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (
    !loopback.includes(url.hostname) ||
    !dbName.startsWith("blossom_disposable_")
  ) {
    throw new Error(
      "BLOSSOM_TEST_PG_URL must be a loopback database named blossom_disposable_*",
    );
  }
}

function assertLocalNeon(pgUrl: string) {
  if (!NEON_URL || !NEON_CONNECTION_URL) {
    throw new Error("Both Neon test URLs are required");
  }
  const endpoint = new URL(NEON_URL);
  const connection = new URL(NEON_CONNECTION_URL);
  const postgres = new URL(pgUrl);
  if (
    endpoint.protocol !== "http:" ||
    !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
    connection.hostname !== "db.localtest.me" ||
    connection.pathname !== postgres.pathname ||
    connection.username !== postgres.username
  ) {
    throw new Error(
      "Neon tests require a loopback proxy and matching disposable database",
    );
  }
}

const ALICE = {
  uuid: "00000000-0000-4000-8000-0000000000a1",
  password: "fake-alice-password-v0",
};
const BOB = {
  uuid: "00000000-0000-4000-8000-0000000000b1",
  password: "fake-bob-password-v0",
};
const FUTURE = new Date("2099-01-01T00:00:00.000Z");

type Db = Record<PropertyKey, unknown>;

interface Fixture {
  admin: Pool;
  adminDb: ReturnType<typeof drizzleNodePg>;
}

let fx: Fixture;

async function resetAndSeed() {
  const { admin, adminDb } = fx;
  await admin.query(
    `TRUNCATE "user", plan, proxy_group, server, config_change CASCADE`,
  );
  await adminDb.insert(user).values([
    { id: "alice", name: "Alice", email: "alice@example.test" },
    { id: "bob", name: "Bob", email: "bob@example.test" },
  ]);
  await adminDb.insert(plan).values([
    { id: "p1", name: "P1", priceCents: 0, durationDays: 30, trafficBytes: 0 },
    // A plan whose groups have no nodes.
    {
      id: "p-empty",
      name: "Empty",
      priceCents: 0,
      durationDays: 30,
      trafficBytes: 0,
    },
  ]);
  await adminDb.insert(proxyGroup).values([
    { id: "g1", name: "G1" },
    { id: "g-empty", name: "G-empty" },
  ]);
  await adminDb.insert(planGroup).values([
    { planId: "p1", groupId: "g1" },
    { planId: "p-empty", groupId: "g-empty" },
  ]);
  await adminDb.insert(server).values(
    ["srv-a", "srv-b", "srv-c", "srv-d"].map((id) => ({
      id,
      name: id,
      address: `${id}.example.test`,
      agentTokenHash: `fake-hash-${id}`,
      agentTokenPrefix: id,
    })),
  );
  const base = { protocol: "trojan" as const, settings: {} };
  await adminDb.insert(node).values([
    { ...base, id: "n-a", name: "n-a", serverId: "srv-a", listenPort: 10001 },
    { ...base, id: "n-b", name: "n-b", serverId: "srv-b", listenPort: 10002 },
    // srv-c hosts a node outside the plan's group: never affected.
    { ...base, id: "n-c", name: "n-c", serverId: "srv-c", listenPort: 10003 },
    // srv-d hosts a DISABLED node in the group: never affected.
    {
      ...base,
      id: "n-d",
      name: "n-d",
      serverId: "srv-d",
      listenPort: 10004,
      enabled: false,
    },
  ]);
  await adminDb.insert(nodeGroup).values([
    { nodeId: "n-a", groupId: "g1", position: 0 },
    { nodeId: "n-b", groupId: "g1", position: 1 },
    { nodeId: "n-d", groupId: "g1", position: 2 },
  ]);
  const sub = (
    id: string,
    userId: string,
    planId: string,
    c: typeof ALICE,
  ) => ({
    id,
    userId,
    planId,
    expiresAt: FUTURE,
    trafficQuotaBytes: 0,
    deviceLimit: 0,
    credentialUuid: c.uuid,
    credentialPassword: c.password,
    token: `fake-token-${id}`,
  });
  await adminDb.insert(subscription).values([
    sub("sub-alice", "alice", "p1", ALICE),
    sub("sub-bob", "bob", "p1", BOB),
    sub("sub-alice-empty", "alice", "p-empty", {
      uuid: "00000000-0000-4000-8000-0000000000a2",
      password: "fake-alice-empty",
    }),
  ]);
}

async function snapshot() {
  const q = (text: string) => fx.admin.query(text).then((r) => r.rows);
  return {
    servers: await q(
      `SELECT id, desired_revision_seq, applied_revision_seq FROM server ORDER BY id`,
    ),
    changes: await q(
      `SELECT kind, subject_id, prev_row FROM config_change ORDER BY subject_id, kind`,
    ),
    links: await q(
      `SELECT server_id, revision_seq FROM config_change_server ORDER BY server_id, revision_seq`,
    ),
  };
}

async function creds(id: string) {
  const { rows } = await fx.admin.query(
    `SELECT credential_uuid AS uuid, credential_password AS password, token FROM subscription WHERE id = $1`,
    [id],
  );
  return rows[0] as { uuid: string; password: string; token: string };
}

const call = (fn: unknown, id: string) =>
  (fn as (arg: { data: unknown }) => Promise<any>)({ data: { id } });

/** The pre-fix implementation, kept only to characterize the race it had. */
async function legacyRotate(
  id: string,
  between: () => Promise<void> = async () => {},
) {
  const { db } = await import("@/db");
  const [existing] = await db
    .select()
    .from(subscription)
    .where(eq(subscription.id, id));
  await db
    .update(subscription)
    .set({
      credentialUuid: crypto.randomUUID(),
      credentialPassword: "legacy-new",
    })
    .where(eq(subscription.id, id));
  await between();
  await recordConfigChange(db, {
    kind: "credential",
    subjectId: id,
    prevRow: {
      credentialUuid: existing!.credentialUuid,
      credentialPassword: existing!.credentialPassword,
    },
    serverIds: await listServerIdsForSubscriptionId(db, id),
  });
}

/** What GET /api/sub/$token does, in its order: row → nodes → pending gate. */
async function fetchSubscription(token: string) {
  const found = await findSubscriptionByToken(token);
  if (!found) throw new Error("token rejected");
  const nodes = await getSubscriptionAccessibleNodes(found.subscription.id);
  const gate = await getGatedSubscriptionView({ ...found, nodes });
  return nodes.map((resolved) => ({
    serverId: resolved.server.id,
    uuid:
      gate.credentialsByNodeId.get(resolved.node.id)?.uuid ??
      found.subscription.credentialUuid,
  }));
}

async function appliedSeq(serverId: string) {
  const { rows } = await fx.admin.query(
    `SELECT applied_revision_seq AS s FROM server WHERE id = $1`,
    [serverId],
  );
  return rows[0].s as number;
}

const agentApplyAll = () =>
  fx.admin.query(
    `UPDATE server SET applied_revision_seq = desired_revision_seq`,
  );

function installFailureTrigger(
  table: "config_change" | "config_change_server",
) {
  return fx.admin.query(`
    CREATE OR REPLACE FUNCTION blossom_test_fail() RETURNS trigger LANGUAGE plpgsql
    AS $$ BEGIN RAISE EXCEPTION 'injected gate failure'; END $$;
    CREATE TRIGGER blossom_test_fail BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION blossom_test_fail();
  `);
}
function removeFailureTrigger(table: "config_change" | "config_change_server") {
  return fx.admin.query(`DROP TRIGGER IF EXISTS blossom_test_fail ON ${table}`);
}

describe.skipIf(!PG_URL)("credential rotation on disposable PostgreSQL", () => {
  let neonCalls = 0;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    if (NEON_URL || NEON_CONNECTION_URL) assertLocalNeon(PG_URL!);
    const admin = new Pool({ connectionString: PG_URL, max: 40 });
    fx = { admin, adminDb: drizzleNodePg({ client: admin }) };
    await admin.query(
      `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`,
    );
    const dir = fileURLToPath(new URL("../../drizzle/", import.meta.url));
    for (const name of readdirSync(dir)
      .filter((n) => !n.endsWith(".json"))
      .sort()) {
      const sqlText = readFileSync(`${dir}${name}/migration.sql`, "utf8");
      for (const statement of sqlText.split("--> statement-breakpoint")) {
        if (statement.trim()) await admin.query(statement);
      }
    }
  });
  afterAll(async () => {
    await fx?.admin.end();
  });
  beforeEach(async () => {
    holder.session = { user: { id: "alice" } };
    await resetAndSeed();
  });

  const drivers: { name: string; enabled: boolean; make: () => Db }[] = [
    {
      name: "node-postgres (PostgreSQL)",
      enabled: true,
      make: () =>
        drizzleNodePg({
          client: new Pool({ connectionString: PG_URL, max: 40 }),
        }) as unknown as Db,
    },
    {
      name: "neon-http (local Neon HTTP proxy → PostgreSQL)",
      enabled: Boolean(NEON_URL),
      make: () => {
        neonConfig.fetchEndpoint = () => NEON_URL!;
        neonConfig.useSecureWebSocket = false;
        neonConfig.poolQueryViaFetch = true;
        neonConfig.fetchFunction = (...args: Parameters<typeof fetch>) => {
          neonCalls += 1;
          return fetch(...args);
        };
        return drizzleNeon({
          client: neon(NEON_CONNECTION_URL!),
        }) as unknown as Db;
      },
    },
  ];

  for (const driver of drivers) {
    describe.skipIf(!driver.enabled)(driver.name, () => {
      beforeAll(() => {
        holder.db = driver.make();
      });

      describe("authorization and gate records", () => {
        it("owner rotation changes credentials, keeps the URL, and records exactly the affected servers", async () => {
          const result = await call(
            rotateOwnSubscriptionCredentials,
            "sub-alice",
          );
          expect(result).toEqual({ id: "sub-alice", pendingServerCount: 2 });

          const now = await creds("sub-alice");
          expect(now.uuid).not.toBe(ALICE.uuid);
          expect(now.password).not.toBe(ALICE.password);
          expect(now.token).toBe("fake-token-sub-alice");
          expect(JSON.stringify(result)).not.toContain(now.uuid);
          expect(JSON.stringify(result)).not.toContain(ALICE.password);

          const snap = await snapshot();
          // srv-a, srv-b hosts enabled group nodes; srv-c (other group) and
          // srv-d (disabled node) are untouched.
          expect(
            snap.servers.map((s) => [s.id, s.desired_revision_seq]),
          ).toEqual([
            ["srv-a", 1],
            ["srv-b", 1],
            ["srv-c", 0],
            ["srv-d", 0],
          ]);
          expect(snap.changes).toEqual([
            {
              kind: "credential",
              subject_id: "sub-alice",
              prev_row: {
                credentialUuid: ALICE.uuid,
                credentialPassword: ALICE.password,
              },
            },
          ]);
          expect(snap.links).toEqual([
            { server_id: "srv-a", revision_seq: 1 },
            { server_id: "srv-b", revision_seq: 1 },
          ]);
        });

        it("rejects another user's subscription and leaves everything untouched", async () => {
          const before = await snapshot();
          await expect(
            call(rotateOwnSubscriptionCredentials, "sub-bob"),
          ).rejects.toThrow("Not found");
          await expect(
            call(rotateOwnSubscriptionToken, "sub-bob"),
          ).rejects.toThrow("Not found");
          await expect(
            call(rotateOwnSubscriptionCredentials, "nope"),
          ).rejects.toThrow("Not found");
          expect(await creds("sub-bob")).toEqual({
            uuid: BOB.uuid,
            password: BOB.password,
            token: "fake-token-sub-bob",
          });
          expect(await snapshot()).toEqual(before);
        });

        it("token-only rotation changes the URL, not the credentials, and records no gate change", async () => {
          const result = await call(rotateOwnSubscriptionToken, "sub-alice");
          const now = await creds("sub-alice");
          expect(result).toEqual({ id: "sub-alice", token: now.token });
          expect(now.token).not.toBe("fake-token-sub-alice");
          expect({ uuid: now.uuid, password: now.password }).toEqual(ALICE);
          expect(
            await findSubscriptionByToken("fake-token-sub-alice"),
          ).toBeNull();
          expect(await findSubscriptionByToken(now.token)).not.toBeNull();
          const snap = await snapshot();
          expect(snap.changes).toEqual([]);
          expect(snap.servers.every((s) => s.desired_revision_seq === 0)).toBe(
            true,
          );
        });

        it("keeps the admin path: any user, full row returned, same gate records", async () => {
          const row = await call(resetSubscriptionCredentials, "sub-bob");
          const now = await creds("sub-bob");
          expect(row).toMatchObject({
            id: "sub-bob",
            userId: "bob",
            credentialUuid: now.uuid,
            credentialPassword: now.password,
            token: "fake-token-sub-bob",
          });
          expect(row.expiresAt).toEqual(FUTURE);
          expect(now.uuid).not.toBe(BOB.uuid);
          expect((await snapshot()).changes).toEqual([
            {
              kind: "credential",
              subject_id: "sub-bob",
              prev_row: {
                credentialUuid: BOB.uuid,
                credentialPassword: BOB.password,
              },
            },
          ]);
          await expect(
            call(resetSubscriptionCredentials, "nope"),
          ).rejects.toThrow("Not found");
          const tokenRow = await rotateSubscriptionToken("sub-bob");
          expect(tokenRow.token).not.toBe("fake-token-sub-bob");
        });

        it("writes the same records as recordConfigChange (the non-atomic reference)", async () => {
          await rotateSubscriptionCredentials("sub-alice");
          const atomic = await snapshot();

          await resetAndSeed();
          const { db } = await import("@/db");
          await recordConfigChange(db, {
            kind: "credential",
            subjectId: "sub-alice",
            prevRow: {
              credentialUuid: ALICE.uuid,
              credentialPassword: ALICE.password,
            },
            serverIds: await listServerIdsForSubscriptionId(db, "sub-alice"),
          });
          expect(atomic).toEqual(await snapshot());
        });

        it("records nothing when the plan reaches no enabled node", async () => {
          const result = await call(
            rotateOwnSubscriptionCredentials,
            "sub-alice-empty",
          );
          expect(result).toEqual({
            id: "sub-alice-empty",
            pendingServerCount: 0,
          });
          expect((await creds("sub-alice-empty")).password).not.toBe(
            "fake-alice-empty",
          );
          const snap = await snapshot();
          expect(snap.changes).toEqual([]);
          expect(snap.links).toEqual([]);
        });
      });

      describe("atomicity under failure injection", () => {
        for (const table of [
          "config_change",
          "config_change_server",
        ] as const) {
          it(`a failing ${table} insert rolls back credentials and server revisions`, async () => {
            const before = await snapshot();
            await installFailureTrigger(table);
            try {
              await expect(
                call(rotateOwnSubscriptionCredentials, "sub-alice"),
              ).rejects.toThrow();
              await expect(
                rotateSubscriptionCredentials("sub-alice"),
              ).rejects.toThrow();
            } finally {
              await removeFailureTrigger(table);
            }
            expect(await creds("sub-alice")).toEqual({
              ...ALICE,
              token: "fake-token-sub-alice",
            });
            expect(await snapshot()).toEqual(before);
            // And the same call succeeds once the fault is gone.
            await call(rotateOwnSubscriptionCredentials, "sub-alice");
            expect((await creds("sub-alice")).uuid).not.toBe(ALICE.uuid);
          });
        }

        it("characterization: the previous read/update/record sequence strands new credentials with no gate record", async () => {
          await installFailureTrigger("config_change_server");
          try {
            await expect(legacyRotate("sub-alice")).rejects.toThrow();
          } finally {
            await removeFailureTrigger("config_change_server");
          }
          // New credentials are live, the gate never heard of them.
          expect((await creds("sub-alice")).uuid).not.toBe(ALICE.uuid);
          expect((await snapshot()).links).toEqual([]);
        });
      });

      describe("concurrent rotations", () => {
        /** Every rotation's prev_row is the credentials the previous one wrote. */
        async function expectChain(
          subscriptionId: string,
          initial: typeof ALICE,
          results: {
            row: { credentialUuid: string; credentialPassword: string };
            changeId: string | null;
          }[],
        ) {
          for (const serverId of ["srv-a", "srv-b"]) {
            const { rows } = await fx.admin.query(
              `SELECT cs.revision_seq, c.id, c.prev_row
                 FROM config_change_server cs JOIN config_change c ON c.id = cs.change_id
                WHERE cs.server_id = $1 AND c.subject_id = $2 AND c.kind = 'credential'
                ORDER BY cs.revision_seq`,
              [serverId, subscriptionId],
            );
            expect(rows).toHaveLength(results.length);
            const byChange = new Map(results.map((r) => [r.changeId, r.row]));
            let expected = {
              credentialUuid: initial.uuid,
              credentialPassword: initial.password,
            };
            rows.forEach((link, i) => {
              expect(link.revision_seq).toBe(i + 1);
              expect(link.prev_row).toEqual(expected);
              const written = byChange.get(link.id);
              expect(written, "link refers to a rotation we ran").toBeDefined();
              expected = {
                credentialUuid: written!.credentialUuid,
                credentialPassword: written!.credentialPassword,
              };
            });
            const final = await creds(subscriptionId);
            expect({
              credentialUuid: final.uuid,
              credentialPassword: final.password,
            }).toEqual(expected);
          }
        }

        it("two concurrent rotations (admin + owner) form a chain: no lost or duplicated previous credentials", async () => {
          for (let round = 0; round < 15; round += 1) {
            await resetAndSeed();
            const results = await Promise.all([
              rotateSubscriptionCredentials("sub-alice"),
              rotateSubscriptionCredentials("sub-alice", {
                ownerUserId: "alice",
              }),
            ]);
            await expectChain("sub-alice", ALICE, results);
          }
        });

        it("many concurrent rotations of one subscription still chain exactly", async () => {
          const results = await Promise.all(
            Array.from({ length: 12 }, (_, i) =>
              i % 2
                ? rotateSubscriptionCredentials("sub-alice")
                : rotateSubscriptionCredentials("sub-alice", {
                    ownerUserId: "alice",
                  }),
            ),
          );
          expect(new Set(results.map((r) => r.row.credentialUuid)).size).toBe(
            12,
          );
          await expectChain("sub-alice", ALICE, results);
          expect(
            (await snapshot()).servers.map((s) => s.desired_revision_seq),
          ).toEqual([12, 12, 0, 0]);
        });

        it("rotations of different subscriptions sharing servers neither deadlock nor lose revision bumps", async () => {
          for (let round = 0; round < 10; round += 1) {
            await Promise.all([
              rotateSubscriptionCredentials("sub-alice"),
              rotateSubscriptionCredentials("sub-bob"),
              rotateSubscriptionCredentials("sub-alice", {
                ownerUserId: "alice",
              }),
              rotateSubscriptionCredentials("sub-bob", { ownerUserId: "bob" }),
            ]);
          }
          const snap = await snapshot();
          expect(snap.servers.map((s) => s.desired_revision_seq)).toEqual([
            40, 40, 0, 0,
          ]);
          // Per-server sequences are unique and gap-free.
          const seqs = snap.links
            .filter((l) => l.server_id === "srv-a")
            .map((l) => l.revision_seq);
          expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
        });

        it("a concurrent cross-user attempt cannot interfere with the owner's rotation", async () => {
          const [owner, attacker] = await Promise.allSettled([
            rotateSubscriptionCredentials("sub-alice", {
              ownerUserId: "alice",
            }),
            rotateSubscriptionCredentials("sub-alice", { ownerUserId: "bob" }),
          ]);
          expect(owner.status).toBe("fulfilled");
          expect(attacker.status).toBe("rejected");
          expect((await snapshot()).changes).toHaveLength(1);
        });
      });

      describe("fetch / apply interleaving", () => {
        it("a fetch can never observe new credentials before their gate record (deterministic)", async () => {
          // Hold srv-b's row lock so the rotation statement is blocked mid-way.
          const holdLock = await fx.admin.connect();
          await holdLock.query("BEGIN");
          await holdLock.query(
            `SELECT 1 FROM server WHERE id = 'srv-b' FOR UPDATE`,
          );
          const rotation = rotateSubscriptionCredentials("sub-alice");
          await new Promise((resolve) => setTimeout(resolve, 400));

          // While the rotation is blocked, subscribers see the old state only.
          expect(
            (await fetchSubscription("fake-token-sub-alice")).map(
              (n) => n.uuid,
            ),
          ).toEqual([ALICE.uuid, ALICE.uuid]);
          expect((await creds("sub-alice")).uuid).toBe(ALICE.uuid);

          await holdLock.query("COMMIT");
          holdLock.release();
          const { row } = await rotation;

          // Rotation committed, no server applied: new creds, change pending →
          // subscribers still get the previous credentials on both servers.
          expect(
            (await fetchSubscription("fake-token-sub-alice")).map(
              (n) => n.uuid,
            ),
          ).toEqual([ALICE.uuid, ALICE.uuid]);
          // srv-a applies: only its node switches to the new credentials.
          await fx.admin.query(
            `UPDATE server SET applied_revision_seq = desired_revision_seq WHERE id = 'srv-a'`,
          );
          const afterA = await fetchSubscription("fake-token-sub-alice");
          expect(afterA.find((n) => n.serverId === "srv-a")!.uuid).toBe(
            row.credentialUuid,
          );
          expect(afterA.find((n) => n.serverId === "srv-b")!.uuid).toBe(
            ALICE.uuid,
          );
          await agentApplyAll();
          expect(
            (await fetchSubscription("fake-token-sub-alice")).map(
              (n) => n.uuid,
            ),
          ).toEqual([row.credentialUuid, row.credentialUuid]);
        });

        it("characterization: the previous sequence exposed new credentials with no pending change", async () => {
          let observed: string[] = [];
          await legacyRotate("sub-alice", async () => {
            observed = (await fetchSubscription("fake-token-sub-alice")).map(
              (n) => n.uuid,
            );
          });
          // Mid-rotation a subscriber was handed credentials no agent serves.
          expect(observed).toHaveLength(2);
          expect(observed.every((uuid) => uuid !== ALICE.uuid)).toBe(true);
        });

        it("under load, a fetch never emits credentials newer than what its server has applied", async () => {
          const ROTATIONS = driver.name.startsWith("neon") ? 10 : 25;
          const rotations: { uuid: string; changeId: string | null }[] = [];
          const fetches: {
            serverId: string;
            uuid: string;
            appliedAfter: number;
          }[] = [];
          let rotating = true;

          const rotator = async (ownerScoped: boolean) => {
            for (let i = 0; i < ROTATIONS / 2; i += 1) {
              const r = await rotateSubscriptionCredentials(
                "sub-alice",
                ownerScoped ? { ownerUserId: "alice" } : {},
              );
              rotations.push({
                uuid: r.row.credentialUuid,
                changeId: r.changeId,
              });
            }
          };
          const reader = async () => {
            while (rotating) {
              const emitted = await fetchSubscription("fake-token-sub-alice");
              for (const n of emitted) {
                fetches.push({
                  ...n,
                  appliedAfter: await appliedSeq(n.serverId),
                });
              }
            }
          };
          const agent = async () => {
            while (rotating) {
              await agentApplyAll();
              await new Promise((resolve) => setTimeout(resolve, 3));
            }
          };

          const background = [reader(), reader(), agent()];
          await Promise.all([rotator(false), rotator(true)]);
          rotating = false;
          await Promise.all(background);

          // version of a credential = revision seq of the rotation that wrote it
          const { rows } = await fx.admin.query(
            `SELECT c.id, cs.revision_seq FROM config_change c
               JOIN config_change_server cs ON cs.change_id = c.id AND cs.server_id = 'srv-a'`,
          );
          const seqByChange = new Map(
            rows.map((r) => [r.id as string, r.revision_seq as number]),
          );
          const versionByUuid = new Map<string, number>([[ALICE.uuid, 0]]);
          for (const r of rotations)
            versionByUuid.set(r.uuid, seqByChange.get(r.changeId!)!);

          expect(fetches.length).toBeGreaterThan(0);
          for (const f of fetches) {
            const version = versionByUuid.get(f.uuid);
            expect(
              version,
              "emitted credentials are known versions",
            ).toBeDefined();
            expect(version!).toBeLessThanOrEqual(f.appliedAfter);
          }
        }, 60_000);

        describe("agent config reads", () => {
          // `agent.getConfigV3` resolves the server row (and so its
          // desiredRevisionSeq) in the auth middleware, then compiles the
          // inbound users (credentials) from the subscription rows. The agent
          // reports that seq as applied, and the gate then starts emitting the
          // credentials recorded at or below it.
          const readSeq = async () => {
            const db = holder.db as unknown as ReturnType<typeof drizzleNodePg>;
            const [r] = await db
              .select({ seq: server.desiredRevisionSeq })
              .from(server)
              .where(eq(server.id, "srv-a"));
            return r!.seq;
          };
          const readServedUuid = async () => {
            const users = await getNodeActiveSubscriptions("n-a");
            return users.find((s) => s.id === "sub-alice")!.credentialUuid;
          };

          it("revision-then-credentials never pairs a revision with older credentials, under concurrent rotation", async () => {
            const ROTATIONS = driver.name.startsWith("neon") ? 10 : 25;
            const uuids = [ALICE.uuid]; // index = revision seq on srv-a
            const observed: { seq: number; uuid: string }[] = [];
            let rotating = true;

            const agent = async () => {
              while (rotating) {
                const seq = await readSeq();
                observed.push({ seq, uuid: await readServedUuid() });
              }
            };
            const rotator = async () => {
              for (let i = 0; i < ROTATIONS; i += 1) {
                const r = await rotateSubscriptionCredentials(
                  "sub-alice",
                  i % 2 ? { ownerUserId: "alice" } : {},
                );
                uuids.push(r.row.credentialUuid);
              }
              rotating = false;
            };
            try {
              await Promise.all([agent(), agent(), rotator()]);
            } finally {
              rotating = false;
            }

            expect(observed.length).toBeGreaterThan(0);
            for (const { seq, uuid } of observed) {
              // Served credentials are at least as new as the reported revision.
              expect(
                uuids.indexOf(uuid),
                "served credentials are a known version",
              ).toBeGreaterThanOrEqual(seq);
            }
          }, 60_000);

          it("characterization: credentials-then-revision WOULD break the gate, which is why the order above matters", async () => {
            const servedBefore = await readServedUuid();
            await rotateSubscriptionCredentials("sub-alice");
            const seqAfter = await readSeq();
            // The agent would report revision 1 while still serving revision 0.
            expect(seqAfter).toBe(1);
            expect(servedBefore).toBe(ALICE.uuid);
          });
        });
      });

      if (driver.name.startsWith("neon")) {
        describe("neon-http statement count", () => {
          it("a credential rotation is exactly one HTTP query (one implicit transaction)", async () => {
            neonCalls = 0;
            await rotateSubscriptionCredentials("sub-alice");
            expect(neonCalls).toBe(1);
            neonCalls = 0;
            await call(rotateOwnSubscriptionCredentials, "sub-bob").catch(
              () => {},
            );
            expect(neonCalls).toBe(1);
          });
        });
      }
    });
  }
});
