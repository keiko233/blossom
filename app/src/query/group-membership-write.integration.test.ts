/**
 * Integration tests for ordered group membership writes against a REAL,
 * DISPOSABLE PostgreSQL. They are skipped unless BLOSSOM_TEST_PG_URL is set, so
 * `pnpm test` and CI need no database.
 *
 *   BLOSSOM_TEST_PG_URL            postgres://… on a loopback host, database
 *                                  name starting with `blossom_disposable_`.
 *                                  The public schema is DROPPED and rebuilt
 *                                  from app/drizzle/*, and tables are emptied
 *                                  between tests. Never point it at real data.
 *   BLOSSOM_TEST_NEON_HTTP_URL     optional: the `/sql` endpoint of a local
 *                                  Neon HTTP proxy in front of the same database.
 *   BLOSSOM_TEST_NEON_CONNECTION_URL matching database credentials using
 *                                  db.localtest.me as the host.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
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

import type { Database } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, planGroup, subscription } from "@/db/plan-schema";
import { node, nodeGroup, proxyGroup, server } from "@/db/proxy-schema";

const holder = vi.hoisted(() => ({
  db: undefined as unknown as Database,
  driver: "node-postgres" as "node-postgres" | "neon-http",
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
  getDatabaseDriver: () => holder.driver,
}));

vi.mock("@/lib/agent-notifications", () => ({
  notifyAgentConfigChanged: vi.fn(async () => {}),
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
vi.mock("@/lib/ensure-admin", () => ({
  ensureAdmin: async () => ({ user: { id: "admin", role: "admin" } }),
}));
vi.mock("@/lib/admin-audit-middleware", () => ({ adminAudit: () => ({}) }));

import { previewNodeSelection } from "@/lib/access-impact";
import {
  createGroupWithMembership,
  deleteGroupWithMembership,
  deleteNodeWithMembershipCascade,
  writeGroupMembership,
  withDatabaseTransaction,
} from "@/query/group-membership-write";
import { getGroup } from "@/query/groups";
import { createNodeMCP, deleteNodeMCP, updateNodeMCP } from "@/query/mcp-tools";
import {
  createNode as createNodeFromUi,
  deleteNode as deleteNodeFromUi,
  listNodes,
  updateNode as updateNodeFromUi,
} from "@/query/nodes";
import {
  getGatedSubscriptionView,
  getSubscriptionAccessibleNodes,
  findSubscriptionByToken,
} from "@/query/subscription-access";
import { rotateSubscriptionCredentials } from "@/query/subscription-write";

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

const FUTURE = new Date("2099-01-01T00:00:00.000Z");

type Db = Database;

interface Fixture {
  admin: Pool;
  adminDb: ReturnType<typeof drizzleNodePg>;
}

let fx: Fixture;

async function resetAndSeed() {
  const { admin, adminDb } = fx;
  await admin.query(
    `TRUNCATE "user", plan, proxy_group, server, config_change, managed_rollout CASCADE;
     UPDATE managed_topology SET generation = 0;`,
  );
  await adminDb.insert(user).values([
    { id: "alice", name: "Alice", email: "alice@example.test" },
    {
      id: "admin",
      name: "Admin",
      email: "admin@example.test",
      role: "admin",
    },
  ]);
  await adminDb.insert(plan).values([
    {
      id: "p1",
      name: "P1",
      priceCents: 0,
      durationDays: 30,
      trafficBytes: 0,
    },
  ]);
  await adminDb.insert(proxyGroup).values([
    // g0 sorts before g1 and owns the first occurrence of c.
    { id: "g0", name: "G0", sortOrder: 0 },
    { id: "g1", name: "G1", sortOrder: 10 },
    { id: "g2", name: "G2", sortOrder: 20 },
    { id: "g-swap", name: "Swap", sortOrder: 30 },
    { id: "g-empty", name: "Empty", sortOrder: 40 },
  ]);
  await adminDb.insert(planGroup).values([
    { planId: "p1", groupId: "g0" },
    { planId: "p1", groupId: "g1" },
    { planId: "p1", groupId: "g2" },
  ]);
  await adminDb.insert(server).values(
    ["srv-a", "srv-b", "srv-c"].map((id) => ({
      id,
      name: id,
      address: `${id}.example.test`,
      agentTokenHash: `fake-hash-${id}`,
      agentTokenPrefix: id,
    })),
  );
  const base = { protocol: "trojan" as const, settings: {} };
  await adminDb.insert(node).values([
    { ...base, id: "a", name: "a", serverId: "srv-a", listenPort: 10001 },
    { ...base, id: "b", name: "b", serverId: "srv-b", listenPort: 10002 },
    { ...base, id: "c", name: "c", serverId: "srv-c", listenPort: 10003 },
    {
      ...base,
      id: "d",
      name: "d",
      serverId: "srv-c",
      listenPort: 10004,
      enabled: false,
    },
    { ...base, id: "e", name: "e", serverId: "srv-a", listenPort: 10005 },
  ]);
  await adminDb.insert(nodeGroup).values([
    { nodeId: "c", groupId: "g0", position: 0 },
    { nodeId: "a", groupId: "g0", position: 1 },
    { nodeId: "a", groupId: "g1", position: 0 },
    { nodeId: "b", groupId: "g1", position: 1 },
    { nodeId: "c", groupId: "g1", position: 2 },
    { nodeId: "b", groupId: "g2", position: 0 },
    { nodeId: "c", groupId: "g2", position: 1 },
    { nodeId: "a", groupId: "g-swap", position: 0 },
    { nodeId: "b", groupId: "g-swap", position: 1 },
  ]);
  await adminDb.insert(subscription).values({
    id: "sub-alice",
    userId: "alice",
    planId: "p1",
    expiresAt: FUTURE,
    trafficQuotaBytes: 0,
    deviceLimit: 0,
    credentialUuid: "00000000-0000-4000-8000-0000000000a1",
    credentialPassword: "fake-password",
    token: "fake-token-sub-alice",
  });
}

async function members(groupId: string) {
  const rows = await fx.admin.query(
    `SELECT node_id, position FROM node_group WHERE group_id = $1 ORDER BY position, node_id`,
    [groupId],
  );
  return rows.rows as { node_id: string; position: number }[];
}

async function groupRevision(groupId: string) {
  const { rows } = await fx.admin.query(
    `SELECT revision FROM proxy_group WHERE id = $1`,
    [groupId],
  );
  return rows[0]?.revision as number | undefined;
}

async function snapshot() {
  const q = (text: string) => fx.admin.query(text).then((r) => r.rows);
  return {
    servers: await q(`SELECT id, desired_revision_seq FROM server ORDER BY id`),
    changes: await q(
      `SELECT kind, subject_id, prev_row FROM config_change ORDER BY subject_id`,
    ),
    links: await q(
      `SELECT server_id, revision_seq FROM config_change_server ORDER BY server_id`,
    ),
  };
}

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

async function authorizeAll() {
  await fx.admin.query(
    `UPDATE server SET applied_revision_seq = desired_revision_seq`,
  );
}

describe.skipIf(!PG_URL)(
  "ordered group writes on disposable PostgreSQL",
  () => {
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
        .filter((entry) => !entry.endsWith(".json"))
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
          holder.driver =
            driver.enabled && driver.name.startsWith("neon")
              ? "neon-http"
              : "node-postgres";
        });

        it("ordered edits apply exact positions, bump the group revision, and record one authorization change", async () => {
          const result = await writeGroupMembership(
            {
              groupId: "g1",
              expectedRevision: 1,
              metadata: { name: "G1 renamed" },
              nodeIds: ["c", "a"],
              mode: "ordered",
            },
            { database: holder.db, driver: holder.driver },
          );

          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.group.name).toBe("G1 renamed");
          expect(result.revision).toBe(2);
          expect(result.nodeIds).toEqual(["c", "a"]);
          expect(result.writePlan?.removedNodeIds).toEqual(["b"]);
          expect(result.publishGateRecorded).toBe(true);
          expect(result.affectedServerIds).toEqual(["srv-a", "srv-b", "srv-c"]);

          expect(await members("g1")).toEqual([
            { node_id: "c", position: 0 },
            { node_id: "a", position: 1 },
          ]);
          const snap = await snapshot();
          expect(snap.changes).toEqual([
            {
              kind: "authorization",
              subject_id: "g1",
              prev_row: { nodeIds: ["a", "b", "c"] },
            },
          ]);
          expect(snap.servers).toEqual([
            { id: "srv-a", desired_revision_seq: 1 },
            { id: "srv-b", desired_revision_seq: 1 },
            { id: "srv-c", desired_revision_seq: 1 },
          ]);
          expect(snap.links).toEqual([
            { server_id: "srv-a", revision_seq: 1 },
            { server_id: "srv-b", revision_seq: 1 },
            { server_id: "srv-c", revision_seq: 1 },
          ]);
        });

        it("metadata-only saves leave membership untouched and record no gate", async () => {
          const before = await snapshot();
          const result = await writeGroupMembership(
            {
              groupId: "g1",
              expectedRevision: 1,
              metadata: { name: "G1 metadata only" },
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.group.name).toBe("G1 metadata only");
          expect(result.nodeIds).toEqual(["a", "b", "c"]);
          expect(result.revision).toBe(2);
          expect(result.publishGateRecorded).toBe(false);
          expect(await snapshot()).toEqual(before);
        });

        it("reorder-only saves swap positions in one statement and never touch the publish gate", async () => {
          const before = await snapshot();
          const result = await writeGroupMembership(
            {
              groupId: "g-swap",
              expectedRevision: 1,
              nodeIds: ["b", "a"],
              mode: "ordered",
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.revision).toBe(2);
          expect(result.writePlan?.isReorderOnly).toBe(true);
          expect(result.publishGateRecorded).toBe(false);
          expect(await members("g-swap")).toEqual([
            { node_id: "b", position: 0 },
            { node_id: "a", position: 1 },
          ]);
          expect(await snapshot()).toEqual(before);
        });

        it("rejects a stale ordered edit without writing anything", async () => {
          const before = await snapshot();
          const result = await writeGroupMembership(
            {
              groupId: "g1",
              expectedRevision: 99,
              nodeIds: ["b"],
              mode: "ordered",
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(result).toEqual({
            ok: false,
            reason: "revision_conflict",
            currentRevision: 1,
            currentNodeIds: ["a", "b", "c"],
          });
          expect(await members("g1")).toEqual([
            { node_id: "a", position: 0 },
            { node_id: "b", position: 1 },
            { node_id: "c", position: 2 },
          ]);
          expect(await snapshot()).toEqual(before);
        });

        it("compatibility writers retain surviving order, append additions by stable id, and deduplicate input", async () => {
          const result = await writeGroupMembership(
            {
              groupId: "g1",
              nodeIds: ["c", "a", "c", "d"],
              mode: "compatibility",
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.nodeIds).toEqual(["a", "c", "d"]);
          expect(result.revision).toBe(2);
          expect(await members("g1")).toEqual([
            { node_id: "a", position: 0 },
            { node_id: "c", position: 1 },
            { node_id: "d", position: 2 },
          ]);
          expect(result.writePlan?.removedNodeIds).toEqual(["b"]);
          expect(result.writePlan?.insertedMembers).toEqual([
            { nodeId: "d", position: 2 },
          ]);
        });

        it("rolls back the group, positions and gate when the gate insert fails", async () => {
          const before = await snapshot();
          await installFailureTrigger("config_change");
          try {
            await expect(
              writeGroupMembership(
                {
                  groupId: "g1",
                  expectedRevision: 1,
                  nodeIds: ["c", "a"],
                  mode: "ordered",
                },
                { database: holder.db, driver: holder.driver },
              ),
            ).rejects.toThrow();
          } finally {
            await removeFailureTrigger("config_change");
          }
          expect(await groupRevision("g1")).toBe(1);
          expect(await members("g1")).toEqual([
            { node_id: "a", position: 0 },
            { node_id: "b", position: 1 },
            { node_id: "c", position: 2 },
          ]);
          expect(await snapshot()).toEqual(before);
        });

        it("creates the group and its ordered membership in one atomic statement", async () => {
          const created = await createGroupWithMembership(
            {
              id: "g-new",
              name: "New",
              sortOrder: 50,
              nodeIds: ["c", "a"],
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(created.revision).toBe(1);
          expect(created.nodeIds).toEqual(["c", "a"]);
          expect(await groupRevision("g-new")).toBe(1);
          expect(await members("g-new")).toEqual([
            { node_id: "c", position: 0 },
            { node_id: "a", position: 1 },
          ]);
          expect(await snapshot()).toEqual({
            servers: [
              { id: "srv-a", desired_revision_seq: 0 },
              { id: "srv-b", desired_revision_seq: 0 },
              { id: "srv-c", desired_revision_seq: 0 },
            ],
            changes: [],
            links: [],
          });
        });

        it("rolls a failed create back before any group row is visible", async () => {
          await fx.admin.query(`
          CREATE OR REPLACE FUNCTION blossom_test_fail() RETURNS trigger LANGUAGE plpgsql
          AS $$ BEGIN RAISE EXCEPTION 'injected membership failure'; END $$;
          CREATE TRIGGER blossom_test_fail BEFORE INSERT ON node_group
            FOR EACH ROW EXECUTE FUNCTION blossom_test_fail();
        `);
          try {
            await expect(
              createGroupWithMembership(
                { id: "g-new", name: "New", nodeIds: ["a"] },
                { database: holder.db, driver: holder.driver },
              ),
            ).rejects.toThrow();
          } finally {
            await fx.admin.query(
              `DROP TRIGGER IF EXISTS blossom_test_fail ON node_group`,
            );
          }
          expect(await groupRevision("g-new")).toBeUndefined();
          expect(await members("g-new")).toEqual([]);
        });

        it("serializes concurrent compatibility writers without stale preimages", async () => {
          const results = await Promise.all([
            writeGroupMembership(
              { groupId: "g1", nodeIds: ["c", "a"], mode: "compatibility" },
              { database: holder.db, driver: holder.driver },
            ),
            writeGroupMembership(
              { groupId: "g1", nodeIds: ["c", "a"], mode: "compatibility" },
              { database: holder.db, driver: holder.driver },
            ),
          ]);
          expect(results.every((result) => result.ok)).toBe(true);
          expect(await members("g1")).toEqual([
            { node_id: "a", position: 0 },
            { node_id: "c", position: 1 },
          ]);
          // Each successful save increments the revision; the second is a no-op
          // set change because the first already applied the same target.
          expect(await groupRevision("g1")).toBe(3);
        });

        it("deletes a group and records the previous membership in one atomic write", async () => {
          const result = await deleteGroupWithMembership(
            { groupId: "g1" },
            { database: holder.db, driver: holder.driver },
          );
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.result.previousNodeIds).toEqual(["a", "b", "c"]);
          expect(result.result.affectedServerIds).toEqual([
            "srv-a",
            "srv-b",
            "srv-c",
          ]);
          expect(await groupRevision("g1")).toBeUndefined();
          expect(await members("g1")).toEqual([]);

          const snap = await snapshot();
          expect(snap.changes).toEqual([
            {
              kind: "authorization",
              subject_id: "g1",
              prev_row: { nodeIds: ["a", "b", "c"] },
            },
          ]);
          expect(snap.servers).toEqual([
            { id: "srv-a", desired_revision_seq: 1 },
            { id: "srv-b", desired_revision_seq: 1 },
            { id: "srv-c", desired_revision_seq: 1 },
          ]);
          expect(snap.links).toEqual([
            { server_id: "srv-a", revision_seq: 1 },
            { server_id: "srv-b", revision_seq: 1 },
            { server_id: "srv-c", revision_seq: 1 },
          ]);
        });

        it("rolls a failed group delete and its gate back together", async () => {
          const before = await snapshot();
          await installFailureTrigger("config_change");
          try {
            await expect(
              deleteGroupWithMembership(
                { groupId: "g1" },
                { database: holder.db, driver: holder.driver },
              ),
            ).rejects.toThrow();
          } finally {
            await removeFailureTrigger("config_change");
          }
          expect(await groupRevision("g1")).toBe(1);
          expect(await members("g1")).toEqual([
            { node_id: "a", position: 0 },
            { node_id: "b", position: 1 },
            { node_id: "c", position: 2 },
          ]);
          expect(await snapshot()).toEqual(before);
        });

        it("node deletion compacts affected groups and bumps their revisions", async () => {
          const result = await withDatabaseTransaction(
            holder.db,
            holder.driver,
            (tx) =>
              deleteNodeWithMembershipCascade(
                { nodeId: "b" },
                {
                  database: tx,
                  driver: holder.driver,
                  interactive: holder.driver === "node-postgres",
                },
              ),
          );
          expect(result).not.toBeNull();
          expect(result?.node.id).toBe("b");
          expect(result?.plans.map((entry) => entry.groupId)).toEqual([
            "g-swap",
            "g1",
            "g2",
          ]);

          expect(await groupRevision("g-swap")).toBe(2);
          expect(await groupRevision("g1")).toBe(2);
          expect(await groupRevision("g2")).toBe(2);
          expect(await members("g-swap")).toEqual([
            { node_id: "a", position: 0 },
          ]);
          expect(await members("g1")).toEqual([
            { node_id: "a", position: 0 },
            { node_id: "c", position: 1 },
          ]);
          expect(await members("g2")).toEqual([{ node_id: "c", position: 0 }]);

          const nodeRows = await fx.admin.query(
            `SELECT id FROM node WHERE id = 'b'`,
          );
          expect(nodeRows.rowCount).toBe(0);
        });

        it("UI node deletion uses the shared cascade and records the node change", async () => {
          const call = deleteNodeFromUi as unknown as (arg: {
            data: { id: string };
          }) => Promise<{ id: string }>;
          await expect(call({ data: { id: "b" } })).resolves.toEqual({
            id: "b",
          });
          expect(await groupRevision("g-swap")).toBe(2);
          expect(await groupRevision("g1")).toBe(2);
          expect(await groupRevision("g2")).toBe(2);
          expect(await members("g1")).toEqual([
            { node_id: "a", position: 0 },
            { node_id: "c", position: 1 },
          ]);
          expect((await snapshot()).changes).toEqual([
            { kind: "node", subject_id: "b", prev_row: null },
          ]);
          expect((await snapshot()).servers).toEqual([
            { id: "srv-a", desired_revision_seq: 0 },
            { id: "srv-b", desired_revision_seq: 1 },
            { id: "srv-c", desired_revision_seq: 0 },
          ]);
        });

        it("MCP node deletion uses the shared cascade and records the node change", async () => {
          await expect(deleteNodeMCP("admin", "b")).resolves.toEqual({
            id: "b",
          });
          expect(await groupRevision("g1")).toBe(2);
          expect(await groupRevision("g2")).toBe(2);
          expect(await groupRevision("g-swap")).toBe(2);
          expect(await members("g2")).toEqual([{ node_id: "c", position: 0 }]);
          expect((await snapshot()).changes).toEqual([
            { kind: "node", subject_id: "b", prev_row: null },
          ]);
          expect((await snapshot()).servers).toEqual([
            { id: "srv-a", desired_revision_seq: 0 },
            { id: "srv-b", desired_revision_seq: 1 },
            { id: "srv-c", desired_revision_seq: 0 },
          ]);
        });

        it("UI and MCP structural writers reject active rollout claims", async () => {
          await fx.admin.query(`
            INSERT INTO managed_rollout (id, topology_generation, stage_count)
            VALUES ('r-fence', 0, 1);
            INSERT INTO managed_rollout_claim (server_id, rollout_id)
            VALUES ('srv-b', 'r-fence');
          `);
          const deleteUi = deleteNodeFromUi as unknown as (arg: {
            data: { id: string };
          }) => Promise<unknown>;
          const updateUi = updateNodeFromUi as unknown as (arg: {
            data: Record<string, unknown>;
          }) => Promise<unknown>;
          const createUi = createNodeFromUi as unknown as (arg: {
            data: Record<string, unknown>;
          }) => Promise<unknown>;

          const rejection = {
            ok: false,
            reason: "rollout_in_progress",
            serverId: "srv-b",
            rolloutId: "r-fence",
          };
          await expect(deleteUi({ data: { id: "b" } })).resolves.toEqual(
            rejection,
          );
          await expect(deleteNodeMCP("admin", "b")).resolves.toEqual(rejection);
          await expect(
            updateUi({ data: { id: "b", listenPort: 10007 } }),
          ).resolves.toEqual(rejection);
          await expect(
            updateNodeMCP("admin", "b", { listenPort: 10007 }),
          ).resolves.toEqual(rejection);
          await expect(
            createUi({
              data: {
                name: "fenced",
                serverId: "srv-b",
                listenPort: 10008,
                protocol: "trojan",
                settings: {},
              },
            }),
          ).resolves.toEqual(rejection);
          await expect(
            createNodeMCP("admin", {
              name: "fenced",
              serverId: "srv-b",
              listenPort: 10008,
              protocol: "trojan",
              settings: {},
            }),
          ).resolves.toEqual(rejection);
          expect(
            (await fx.admin.query(`SELECT id FROM node WHERE id = 'b'`)).rows,
          ).toEqual([{ id: "b" }]);

          // An active rollout claim fences subscriber structure, not
          // entitlement revocation or credential rotation.
          const revoked = await writeGroupMembership(
            { groupId: "g-swap", expectedRevision: 1, nodeIds: ["a"] },
            { database: holder.db, driver: holder.driver },
          );
          expect(revoked.ok).toBe(true);
          const rotated = await rotateSubscriptionCredentials("sub-alice");
          expect(rotated.serverIds).toEqual(["srv-a", "srv-b", "srv-c"]);
        });

        it("UI and MCP structural writers reject a pointed managed subscriber ingress", async () => {
          await fx.admin.query(`
            INSERT INTO managed_config_version
              (id, server_id, version, schema_version, intent, intent_digest, subscriber_node_ids)
            VALUES ('cv-ref', 'srv-b', 1, 1, '{}', 'sha256:ref', '["b"]'::jsonb);
            INSERT INTO managed_server_state
              (server_id, desired_config_version_id, applied_config_version_id)
            VALUES ('srv-b', 'cv-ref', 'cv-ref');
          `);
          const deleteUi = deleteNodeFromUi as unknown as (arg: {
            data: { id: string };
          }) => Promise<unknown>;
          const updateUi = updateNodeFromUi as unknown as (arg: {
            data: Record<string, unknown>;
          }) => Promise<unknown>;

          const rejection = {
            ok: false,
            reason: "managed_reference",
            nodeId: "b",
            configVersionIds: ["cv-ref"],
          };
          await expect(deleteUi({ data: { id: "b" } })).resolves.toEqual(
            rejection,
          );
          await expect(deleteNodeMCP("admin", "b")).resolves.toEqual(rejection);
          await expect(
            updateUi({ data: { id: "b", listenPort: 10007 } }),
          ).resolves.toEqual(rejection);
          await expect(
            updateNodeMCP("admin", "b", { listenPort: 10007 }),
          ).resolves.toEqual(rejection);
          expect(
            (await fx.admin.query(`SELECT id FROM node WHERE id = 'b'`)).rows,
          ).toEqual([{ id: "b" }]);
        });

        it("orders exports by group sort/member position with first occurrence winning", async () => {
          const nodes = await getSubscriptionAccessibleNodes("sub-alice");
          expect(nodes.map((entry) => entry.node.id)).toEqual(["c", "a", "b"]);
        });

        it("aligns the group editor preview with the actual ordered export", async () => {
          await fx.adminDb.insert(plan).values({
            id: "p-preview",
            name: "Preview",
            priceCents: 0,
            durationDays: 30,
            trafficBytes: 0,
          });
          await fx.adminDb.insert(planGroup).values({
            planId: "p-preview",
            groupId: "g1",
          });
          // The disabled node stays in the saved group but must not reach the
          // exported subscription. It keeps its position so the preview can
          // flag it without reordering the eligible entrances.
          await fx.adminDb
            .insert(nodeGroup)
            .values({ nodeId: "d", groupId: "g1", position: 3 });
          await fx.adminDb.insert(subscription).values({
            id: "sub-preview",
            userId: "alice",
            planId: "p-preview",
            expiresAt: FUTURE,
            trafficQuotaBytes: 0,
            deviceLimit: 0,
            credentialUuid: "00000000-0000-4000-8000-0000000000a2",
            credentialPassword: "fake-password",
            token: "fake-token-sub-preview",
          });

          const group = await getGroup({ data: { id: "g1" } });
          const nodes = await listNodes();
          const preview = previewNodeSelection({
            nodeIds: group.nodeIds,
            nodes,
            now: Date.now(),
          });
          const exported = await getSubscriptionAccessibleNodes("sub-preview");

          expect(exported.map((entry) => entry.node.id)).toEqual([
            "a",
            "b",
            "c",
          ]);
          expect(preview.nodes.map((entry) => entry.node.id)).toEqual([
            "a",
            "b",
            "c",
            "d",
          ]);
          expect(preview.filteredCount).toBe(1);
          expect(preview.missingNodeIds).toEqual([]);
        });

        it("keeps a pending membership addition out of the gated export, then publishes it after apply", async () => {
          const add = await writeGroupMembership(
            {
              groupId: "g1",
              expectedRevision: 1,
              nodeIds: ["a", "b", "c", "e"],
              mode: "ordered",
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(add.ok).toBe(true);
          if (!add.ok) return;
          expect(add.publishGateRecorded).toBe(true);

          const found = await findSubscriptionByToken("fake-token-sub-alice");
          expect(found).not.toBeNull();
          const nodes = await getSubscriptionAccessibleNodes("sub-alice");
          expect(nodes.map((entry) => entry.node.id)).toEqual([
            "c",
            "a",
            "b",
            "e",
          ]);
          const gated = await getGatedSubscriptionView({
            subscription: found!.subscription,
            user: found!.user,
            nodes,
          });
          // The newly added e is withheld by the pending authorization change;
          // the gate never reorders or resurrects.
          expect(gated.nodes.map((entry) => entry.node.id)).toEqual([
            "c",
            "a",
            "b",
          ]);

          await authorizeAll();
          const afterApply = await getGatedSubscriptionView({
            subscription: found!.subscription,
            user: found!.user,
            nodes,
          });
          expect(afterApply.nodes.map((entry) => entry.node.id)).toEqual([
            "c",
            "a",
            "b",
            "e",
          ]);
        });

        it("immediately drops removed members without waiting for apply", async () => {
          const removeG1 = await writeGroupMembership(
            {
              groupId: "g1",
              expectedRevision: 1,
              nodeIds: ["a", "c"],
              mode: "ordered",
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(removeG1.ok).toBe(true);
          const removeG2 = await writeGroupMembership(
            {
              groupId: "g2",
              expectedRevision: 1,
              nodeIds: ["c"],
              mode: "ordered",
            },
            { database: holder.db, driver: holder.driver },
          );
          expect(removeG2.ok).toBe(true);
          if (!removeG1.ok || !removeG2.ok) return;

          const found = await findSubscriptionByToken("fake-token-sub-alice");
          const nodes = await getSubscriptionAccessibleNodes("sub-alice");
          const gated = await getGatedSubscriptionView({
            subscription: found!.subscription,
            user: found!.user,
            nodes,
          });
          expect(gated.nodes.map((entry) => entry.node.id)).toEqual(["c", "a"]);
        });

        it("two simultaneous ordered edits from the same revision settle with one winner", async () => {
          const results = await Promise.all([
            writeGroupMembership(
              {
                groupId: "g1",
                expectedRevision: 1,
                nodeIds: ["a"],
                mode: "ordered",
              },
              { database: holder.db, driver: holder.driver },
            ),
            writeGroupMembership(
              {
                groupId: "g1",
                expectedRevision: 1,
                nodeIds: ["b"],
                mode: "ordered",
              },
              { database: holder.db, driver: holder.driver },
            ),
          ]);
          const successes = results.filter((result) => result.ok);
          const conflicts = results.filter(
            (result) => !result.ok && result.reason === "revision_conflict",
          );
          expect(successes).toHaveLength(1);
          expect(conflicts).toHaveLength(1);
          const winner = successes[0];
          if (!winner.ok) return;
          expect(await members("g1")).toEqual([
            { node_id: winner.nodeIds[0]!, position: 0 },
          ]);
          expect(await groupRevision("g1")).toBe(2);
        });
      });
    }
  },
);
