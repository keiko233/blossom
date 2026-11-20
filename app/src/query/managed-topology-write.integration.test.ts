/**
 * Topology fence and listener-claim behaviour on a REAL, DISPOSABLE
 * PostgreSQL, on node-postgres and (optionally) neon-http. Skipped unless
 * BLOSSOM_TEST_PG_URL is set; see group-membership-write.integration.test.ts
 * for the variables. The public schema is DROPPED and rebuilt.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { sql } from "drizzle-orm";
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
import { managedRollout } from "@/db/managed-network-schema";

vi.mock("@/db", () => ({ db: {}, getDatabaseDriver: () => "node-postgres" }));
vi.mock("@/lib/agent-notifications", () => ({
  notifyAgentConfigChanged: vi.fn(async () => {}),
}));

import { deleteNodeWithMembershipCascade } from "@/query/group-membership-write";
import {
  compareAndBumpTopologyGeneration,
  listListenerClaims,
  readTopologyGeneration,
  topologyGenerationCasCte,
} from "@/query/managed-topology-write";

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

/** Admits a rollout only if the topology CAS succeeds, in one statement. */
async function admitRollout(
  database: Database,
  rolloutId: string,
  expectedGeneration: number,
): Promise<number | null> {
  const result = await database.execute<{ generation: number }>(
    sql`WITH ${topologyGenerationCasCte(expectedGeneration)},
      admitted AS (
        INSERT INTO ${managedRollout} (id, topology_generation, stage_count)
        SELECT ${rolloutId}, topology_cas.generation, 1 FROM topology_cas
        RETURNING topology_generation
      )
      SELECT topology_generation AS generation FROM admitted`,
    "objects",
  );
  const rows = Array.isArray(result)
    ? result
    : ((result as unknown as { rows: { generation: number }[] }).rows ?? []);
  return rows[0] ? Number(rows[0].generation) : null;
}

describe.skipIf(!PG_URL)("managed topology boundary", () => {
  let admin: Pool;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    admin = new Pool({ connectionString: PG_URL, max: 10 });
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
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query(`
      TRUNCATE server, proxy_group, managed_rollout CASCADE;
      UPDATE managed_topology SET generation = 0;
      INSERT INTO server (id, name, address) VALUES ('srv-a', 'a', 'a.example.test');
      INSERT INTO node (id, name, server_id, listen_port, protocol, settings)
      VALUES ('n-1', 'one', 'srv-a', 10001, 'trojan', '{}');
      INSERT INTO proxy_group (id, name) VALUES ('g-1', 'G');
      INSERT INTO node_group (node_id, group_id, position) VALUES ('n-1', 'g-1', 0);
    `);
  });

  const drivers: {
    name: "node-postgres" | "neon-http";
    enabled: boolean;
    make: () => Database;
  }[] = [
    {
      name: "node-postgres",
      enabled: true,
      make: () =>
        drizzleNodePg({
          client: new Pool({ connectionString: PG_URL, max: 10 }),
        }) as unknown as Database,
    },
    {
      name: "neon-http",
      enabled: Boolean(NEON_URL && NEON_CONNECTION_URL),
      make: () => {
        neonConfig.fetchEndpoint = () => NEON_URL!;
        neonConfig.useSecureWebSocket = false;
        neonConfig.poolQueryViaFetch = true;
        return drizzleNeon({
          client: neon(NEON_CONNECTION_URL!),
        }) as unknown as Database;
      },
    },
  ];

  for (const driver of drivers) {
    describe.skipIf(!driver.enabled)(driver.name, () => {
      let database: Database;

      beforeAll(() => {
        database = driver.make();
      });

      it("compares and bumps the generation, reporting the current value on conflict", async () => {
        expect(await readTopologyGeneration(database)).toBe(0);
        expect(await compareAndBumpTopologyGeneration(0, database)).toEqual({
          ok: true,
          generation: 1,
        });
        expect(await compareAndBumpTopologyGeneration(0, database)).toEqual({
          ok: false,
          reason: "topology_conflict",
          currentGeneration: 1,
        });
      });

      it("lets exactly one of two racing writers win the same generation", async () => {
        const results = await Promise.all([
          compareAndBumpTopologyGeneration(0, database),
          compareAndBumpTopologyGeneration(0, database),
        ]);
        expect(results.filter((result) => result.ok)).toHaveLength(1);
        expect(await readTopologyGeneration(database)).toBe(1);
      });

      it("admits a rollout only in the statement whose CAS succeeds", async () => {
        expect(await admitRollout(database, "r-1", 0)).toBe(1);
        expect(await admitRollout(database, "r-stale", 0)).toBeNull();
        const rows = await admin.query(
          `SELECT id, topology_generation FROM managed_rollout ORDER BY id`,
        );
        expect(rows.rows).toEqual([{ id: "r-1", topology_generation: 1 }]);
      });

      it("releases a subscriber claim through the task 02 node-delete cascade", async () => {
        expect(
          (await listListenerClaims("srv-a", database)).map(
            ({ port, ownerKind, ownerId }) => ({ port, ownerKind, ownerId }),
          ),
        ).toEqual([
          { port: 10001, ownerKind: "subscriber_inbound", ownerId: "n-1" },
        ]);
        const cascade = await deleteNodeWithMembershipCascade(
          { nodeId: "n-1" },
          { database, driver: driver.name },
        );
        expect(cascade?.node.id).toBe("n-1");
        expect(await listListenerClaims("srv-a", database)).toEqual([]);
      });
    });
  }
});
