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

import {
  deleteNodeWithMembershipCascade,
  writeGroupMembership,
} from "@/query/group-membership-write";
import {
  admitManagedRollout,
  commitManagedStage,
  compareAndBumpTopologyGeneration,
  compensateManagedStage,
  deleteLegacySubscriberNode,
  listListenerClaims,
  readListenerClaim,
  readLegacyStructuralNodeWriteFence,
  readTopologyGeneration,
  releasePeerListenerClaim,
  reservePeerListenerClaim,
  topologyGenerationCasCte,
  writeLegacySubscriberNode,
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
      TRUNCATE server, proxy_group, managed_rollout, config_change CASCADE;
      UPDATE managed_topology SET generation = 0;
      INSERT INTO server (id, name, address) VALUES
        ('srv-a', 'a', 'a.example.test'),
        ('srv-b', 'b', 'b.example.test'),
        ('srv-c', 'c', 'c.example.test');
      INSERT INTO node (id, name, server_id, listen_port, protocol, settings)
      VALUES ('n-1', 'one', 'srv-a', 10001, 'trojan', '{}'),
             ('n-2', 'two', 'srv-b', 10002, 'trojan', '{}');
      INSERT INTO proxy_group (id, name) VALUES ('g-1', 'G');
      INSERT INTO node_group (node_id, group_id, position) VALUES
        ('n-1', 'g-1', 0), ('n-2', 'g-1', 1);
    `);
  });

  async function insertConfigVersion(
    id: string,
    serverId: string,
    version: number,
    subscriberNodeIds: string[],
  ) {
    await admin.query(
      `INSERT INTO managed_config_version
       (id, server_id, version, schema_version, intent, intent_digest, subscriber_node_ids)
     VALUES ($1, $2, $3, 1, '{}', $4, $5::jsonb)`,
      [
        id,
        serverId,
        version,
        `sha256:${id}`,
        JSON.stringify(subscriberNodeIds),
      ],
    );
  }

  async function pointServerAt(
    serverId: string,
    configVersionId: string | null,
  ) {
    await admin.query(
      `INSERT INTO managed_server_state (server_id, desired_config_version_id, applied_config_version_id)
     VALUES ($1, $2, $2)
     ON CONFLICT (server_id) DO UPDATE SET
       desired_config_version_id = EXCLUDED.desired_config_version_id,
       applied_config_version_id = EXCLUDED.applied_config_version_id`,
      [serverId, configVersionId],
    );
  }

  async function serverSeq(serverId: string) {
    const { rows } = await admin.query(
      `SELECT desired_revision_seq FROM server WHERE id = $1`,
      [serverId],
    );
    return rows[0]?.desired_revision_seq as number;
  }

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

      it("keeps managed writes disabled until the activation flag is set", async () => {
        expect(
          await reservePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30000,
              ownerId: "peer-1",
              expectedTopologyGeneration: 0,
            },
            { database },
          ),
        ).toEqual({ ok: false, reason: "activation_disabled" });
        expect(
          await admitManagedRollout(
            {
              rolloutId: "r-disabled",
              expectedTopologyGeneration: 0,
              stageCount: 1,
              serverIds: ["srv-a"],
            },
            { database },
          ),
        ).toEqual({ ok: false, reason: "activation_disabled" });
        expect(
          await commitManagedStage(
            {
              rolloutId: "r-disabled",
              expectedOrdinal: 0,
              expectedTopologyGeneration: 0,
            },
            { database },
          ),
        ).toEqual({ ok: false, reason: "activation_disabled" });
      });

      it("admits claims in stable server order and maps conflicts without partial writes", async () => {
        const admitted = await admitManagedRollout(
          {
            rolloutId: "r-a",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-b", "srv-a"],
          },
          { database, activationEnabled: true },
        );
        expect(admitted).toEqual({
          ok: true,
          rolloutId: "r-a",
          topologyGeneration: 1,
          serverIds: ["srv-a", "srv-b"],
        });
        const claims = await admin.query(
          `SELECT server_id, rollout_id FROM managed_rollout_claim ORDER BY server_id`,
        );
        expect(claims.rows).toEqual([
          { server_id: "srv-a", rollout_id: "r-a" },
          { server_id: "srv-b", rollout_id: "r-a" },
        ]);

        expect(
          await admitManagedRollout(
            {
              rolloutId: "r-b",
              expectedTopologyGeneration: 1,
              stageCount: 1,
              serverIds: ["srv-a"],
            },
            { database, activationEnabled: true },
          ),
        ).toEqual({
          ok: false,
          reason: "rollout_claim_conflict",
          serverId: "srv-a",
          rolloutId: "r-a",
        });

        expect(
          await admitManagedRollout(
            {
              rolloutId: "r-stale",
              expectedTopologyGeneration: 0,
              stageCount: 1,
              serverIds: ["srv-c"],
            },
            { database, activationEnabled: true },
          ),
        ).toEqual({
          ok: false,
          reason: "topology_conflict",
          currentGeneration: 1,
        });
        expect(await readTopologyGeneration(database)).toBe(1);
        expect(
          (
            await admin.query(
              `SELECT rollout_id FROM managed_rollout_claim ORDER BY server_id`,
            )
          ).rows,
        ).toEqual([{ rollout_id: "r-a" }, { rollout_id: "r-a" }]);
      });

      it("reserves and releases peer listener claims with typed conflicts", async () => {
        expect(
          await reservePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30000,
              ownerId: "peer-1",
              expectedTopologyGeneration: 0,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, generation: 1 });
        expect(
          await reservePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30000,
              ownerId: "peer-1",
              expectedTopologyGeneration: 1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, generation: 1 });

        expect(
          await reservePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30000,
              ownerId: "peer-2",
              expectedTopologyGeneration: 1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: false,
          reason: "listener_claim_conflict",
          ownerKind: "peer_inbound",
          ownerId: "peer-1",
        });
        expect(
          await reservePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 10001,
              ownerId: "peer-subscriber-conflict",
              expectedTopologyGeneration: 1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: false,
          reason: "listener_claim_conflict",
          ownerKind: "subscriber_inbound",
          ownerId: "n-1",
        });

        expect(
          await writeLegacySubscriberNode(
            {
              kind: "create",
              values: {
                id: "n-peer-conflict",
                name: "peer conflict",
                serverId: "srv-a",
                listenPort: 30000,
                protocol: "trojan",
                settings: {},
              },
            },
            { database },
          ),
        ).toMatchObject({
          ok: false,
          reason: "listener_claim_conflict",
          serverId: "srv-a",
          port: 30000,
          ownerKind: "peer_inbound",
          ownerId: "peer-1",
        });
        expect(await readTopologyGeneration(database)).toBe(1);

        expect(
          await reservePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30001,
              ownerId: "peer-3",
              expectedTopologyGeneration: 0,
            },
            { database, activationEnabled: true },
          ),
        ).toEqual({
          ok: false,
          reason: "topology_conflict",
          currentGeneration: 1,
        });
        expect(await readListenerClaim("srv-a", 30001, database)).toBeNull();

        expect(
          await releasePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30000,
              ownerId: "peer-1",
              expectedTopologyGeneration: 0,
            },
            database,
          ),
        ).toEqual({
          ok: false,
          reason: "topology_conflict",
          currentGeneration: 1,
        });
        expect(
          await releasePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30000,
              ownerId: "peer-1",
              expectedTopologyGeneration: 1,
            },
            database,
          ),
        ).toMatchObject({ ok: true, generation: 2 });
        expect(await readListenerClaim("srv-a", 30000, database)).toBeNull();
        expect(
          await releasePeerListenerClaim(
            {
              serverId: "srv-a",
              port: 30000,
              ownerId: "peer-1",
              expectedTopologyGeneration: 2,
            },
            database,
          ),
        ).toEqual({ ok: false, reason: "not_found" });
      });

      it("commits a stage pointer atomically and rejects stale ordinal and topology CAS", async () => {
        await insertConfigVersion("cv-1", "srv-a", 1, []);
        const admitted = await admitManagedRollout(
          {
            rolloutId: "r-pointer",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-1",
                managedFingerprint: "mf:1",
              },
            ],
          },
          { database, activationEnabled: true },
        );
        expect(admitted.ok).toBe(true);
        if (!admitted.ok) return;

        expect(
          await commitManagedStage(
            {
              rolloutId: "r-pointer",
              expectedOrdinal: 0,
              expectedTopologyGeneration: 0,
            },
            { database, activationEnabled: true },
          ),
        ).toEqual({
          ok: false,
          reason: "topology_conflict",
          currentGeneration: 1,
        });
        expect(await serverSeq("srv-a")).toBe(0);
        expect(
          (
            await admin.query(
              `SELECT desired_config_version_id FROM managed_server_state WHERE server_id = 'srv-a'`,
            )
          ).rows,
        ).toEqual([]);

        const committed = await commitManagedStage(
          {
            rolloutId: "r-pointer",
            expectedOrdinal: 0,
            expectedTopologyGeneration: 1,
          },
          { database, activationEnabled: true },
        );
        expect(committed).toMatchObject({
          ok: true,
          ordinal: 1,
          serverId: "srv-a",
          configVersionId: "cv-1",
          revisionSeq: 1,
          changeId: null,
          topologyGeneration: 2,
        });
        expect(await serverSeq("srv-a")).toBe(1);
        expect(
          (
            await admin.query(
              `SELECT current_ordinal FROM managed_rollout WHERE id = 'r-pointer'`,
            )
          ).rows,
        ).toEqual([{ current_ordinal: 1 }]);
        expect(
          (
            await admin.query(
              `SELECT state, min_revision_seq, issued_revision_seq,
                      issued_at IS NOT NULL AS issued, deadline_at IS NOT NULL AS deadline,
                      confirmed_at
               FROM managed_rollout_stage
               WHERE rollout_id = 'r-pointer' AND ordinal = 1`,
            )
          ).rows,
        ).toEqual([
          {
            state: "issued",
            min_revision_seq: 1,
            issued_revision_seq: 1,
            issued: true,
            deadline: true,
            confirmed_at: null,
          },
        ]);
        expect(
          (
            await admin.query(
              `SELECT desired_config_version_id, desired_ordinal::int AS desired_ordinal,
                      desired_min_revision_seq, desired_managed_fingerprint
               FROM managed_server_state WHERE server_id = 'srv-a'`,
            )
          ).rows,
        ).toEqual([
          {
            desired_config_version_id: "cv-1",
            desired_ordinal: 1,
            desired_min_revision_seq: 1,
            desired_managed_fingerprint: "mf:1",
          },
        ]);

        expect(
          await commitManagedStage(
            {
              rolloutId: "r-pointer",
              expectedOrdinal: 1,
              expectedTopologyGeneration: 2,
            },
            { database, activationEnabled: true },
          ),
        ).toEqual({
          ok: false,
          reason: "stage_not_found",
          rolloutId: "r-pointer",
          ordinal: 2,
        });
      });

      it("rolls back the whole stage commit when its publish-gate write fails", async () => {
        await insertConfigVersion("cv-base", "srv-a", 1, []);
        await insertConfigVersion("cv-rollback", "srv-a", 2, ["n-rollback"]);
        await pointServerAt("srv-a", "cv-base");
        await admitManagedRollout(
          {
            rolloutId: "r-rollback",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-rollback",
                previousConfigVersionId: "cv-base",
                managedFingerprint: "mf:rollback",
                subscriberIntent: {
                  kind: "create_node",
                  node: {
                    id: "n-rollback",
                    name: "rollback",
                    serverId: "srv-a",
                    listenPort: 10003,
                    protocol: "trojan",
                    enabled: true,
                    settings: {},
                  },
                },
              },
            ],
          },
          { database, activationEnabled: true },
        );
        await admin.query(`
          CREATE OR REPLACE FUNCTION blossom_stage_fail() RETURNS trigger
          LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected stage failure'; END $$;
          CREATE TRIGGER blossom_stage_fail BEFORE INSERT ON config_change
            FOR EACH ROW EXECUTE FUNCTION blossom_stage_fail();
        `);
        try {
          await expect(
            commitManagedStage(
              {
                rolloutId: "r-rollback",
                expectedOrdinal: 0,
                expectedTopologyGeneration: 1,
              },
              { database, activationEnabled: true },
            ),
          ).rejects.toThrow();
        } finally {
          await admin.query(
            `DROP TRIGGER IF EXISTS blossom_stage_fail ON config_change`,
          );
        }
        expect(
          (await admin.query(`SELECT id FROM node WHERE id = 'n-rollback'`))
            .rows,
        ).toEqual([]);
        expect(await serverSeq("srv-a")).toBe(0);
        expect(
          (
            await admin.query(
              `SELECT current_ordinal FROM managed_rollout WHERE id = 'r-rollback'`,
            )
          ).rows,
        ).toEqual([{ current_ordinal: 0 }]);
        expect(
          (
            await admin.query(
              `SELECT state FROM managed_rollout_stage
               WHERE rollout_id = 'r-rollback' AND ordinal = 1`,
            )
          ).rows,
        ).toEqual([{ state: "pending" }]);
        expect(await readTopologyGeneration(database)).toBe(1);

        const retried = await commitManagedStage(
          {
            rolloutId: "r-rollback",
            expectedOrdinal: 0,
            expectedTopologyGeneration: 1,
          },
          { database, activationEnabled: true },
        );
        expect(retried).toMatchObject({
          ok: true,
          revisionSeq: 1,
          topologyGeneration: 2,
        });
      });

      it("commits and compensates a staged subscriber create", async () => {
        await insertConfigVersion("cv-base", "srv-a", 1, []);
        await insertConfigVersion("cv-create", "srv-a", 2, ["n-new"]);
        await pointServerAt("srv-a", "cv-base");
        await admitManagedRollout(
          {
            rolloutId: "r-create",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-create",
                previousConfigVersionId: "cv-base",
                managedFingerprint: "mf:create",
                subscriberIntent: {
                  kind: "create_node",
                  node: {
                    id: "n-new",
                    name: "new",
                    serverId: "srv-a",
                    listenPort: 10003,
                    protocol: "trojan",
                    enabled: true,
                    settings: {},
                  },
                },
              },
            ],
          },
          { database, activationEnabled: true },
        );

        const committed = await commitManagedStage(
          {
            rolloutId: "r-create",
            expectedOrdinal: 0,
            expectedTopologyGeneration: 1,
          },
          { database, activationEnabled: true },
        );
        expect(committed).toMatchObject({
          ok: true,
          ordinal: 1,
          configVersionId: "cv-create",
          revisionSeq: 1,
          topologyGeneration: 2,
        });
        expect(committed.ok && committed.changeId).toBeTruthy();
        const nodeRow = await admin.query(
          `SELECT id, listen_port FROM node WHERE id = 'n-new'`,
        );
        expect(nodeRow.rows).toEqual([{ id: "n-new", listen_port: 10003 }]);
        expect(await readListenerClaim("srv-a", 10003, database)).toMatchObject(
          { ownerKind: "subscriber_inbound", ownerId: "n-new" },
        );
        expect(
          (
            await admin.query(
              `SELECT prev_row FROM config_change WHERE subject_id = 'n-new'`,
            )
          ).rows,
        ).toEqual([{ prev_row: null }]);
        expect(
          (
            await admin.query(
              `SELECT subscriber_previous->'node' AS previous_node
               FROM managed_rollout_stage
               WHERE rollout_id = 'r-create' AND ordinal = 1`,
            )
          ).rows,
        ).toEqual([{ previous_node: null }]);

        const compensated = await compensateManagedStage(
          {
            rolloutId: "r-create",
            ordinal: 1,
            failureCode: "create_failed",
          },
          { database, activationEnabled: true },
        );
        expect(compensated).toMatchObject({
          ok: true,
          configVersionId: "cv-base",
          revisionSeq: 2,
          topologyGeneration: 3,
        });
        expect(
          (await admin.query(`SELECT id FROM node WHERE id = 'n-new'`)).rows,
        ).toEqual([]);
        expect(await readListenerClaim("srv-a", 10003, database)).toBeNull();
        expect(await serverSeq("srv-a")).toBe(2);
        expect(
          (
            await admin.query(
              `SELECT state, failure_code FROM managed_rollout_stage
               WHERE rollout_id = 'r-create' AND ordinal = 1`,
            )
          ).rows,
        ).toEqual([{ state: "failed", failure_code: "create_failed" }]);
        expect(
          (
            await admin.query(
              `SELECT state, current_ordinal, failure_code, failure_message
               FROM managed_rollout WHERE id = 'r-create'`,
            )
          ).rows,
        ).toEqual([
          {
            state: "recovering",
            current_ordinal: 0,
            failure_code: "create_failed",
            failure_message: "recovery:cv-base",
          },
        ]);
        expect(
          (
            await admin.query(
              `SELECT desired_config_version_id, desired_ordinal::int AS desired_ordinal
               FROM managed_server_state WHERE server_id = 'srv-a'`,
            )
          ).rows,
        ).toEqual([
          { desired_config_version_id: "cv-base", desired_ordinal: 0 },
        ]);
      });

      it("restores a staged subscriber update and its previous publish-gate state", async () => {
        await insertConfigVersion("cv-base", "srv-a", 1, ["n-1"]);
        await insertConfigVersion("cv-update", "srv-a", 2, ["n-1"]);
        await pointServerAt("srv-a", "cv-base");
        await admitManagedRollout(
          {
            rolloutId: "r-update",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-update",
                previousConfigVersionId: "cv-base",
                managedFingerprint: "mf:update",
                subscriberIntent: {
                  kind: "update_node",
                  nodeId: "n-1",
                  patch: {
                    name: "one updated",
                    listenPort: 11001,
                    settings: {},
                  },
                },
              },
            ],
          },
          { database, activationEnabled: true },
        );

        const committed = await commitManagedStage(
          {
            rolloutId: "r-update",
            expectedOrdinal: 0,
            expectedTopologyGeneration: 1,
          },
          { database, activationEnabled: true },
        );
        expect(committed).toMatchObject({
          ok: true,
          revisionSeq: 1,
          topologyGeneration: 2,
        });
        expect(committed.ok && committed.changeId).toBeTruthy();
        expect(
          (
            await admin.query(
              `SELECT name, listen_port FROM node WHERE id = 'n-1'`,
            )
          ).rows,
        ).toEqual([{ name: "one updated", listen_port: 11001 }]);
        expect(
          (
            await admin.query(
              `SELECT prev_row->'node'->>'listenPort' AS old_port
               FROM config_change WHERE subject_id = 'n-1'`,
            )
          ).rows,
        ).toEqual([{ old_port: "10001" }]);
        expect(
          (
            await admin.query(
              `SELECT subscriber_previous->'node'->>'listenPort' AS old_port
               FROM managed_rollout_stage
               WHERE rollout_id = 'r-update' AND ordinal = 1`,
            )
          ).rows,
        ).toEqual([{ old_port: "10001" }]);

        const compensated = await compensateManagedStage(
          {
            rolloutId: "r-update",
            ordinal: 1,
            failureCode: "update_failed",
          },
          { database, activationEnabled: true },
        );
        expect(compensated).toMatchObject({
          ok: true,
          configVersionId: "cv-base",
          revisionSeq: 2,
          topologyGeneration: 3,
        });
        expect(
          (
            await admin.query(
              `SELECT name, listen_port FROM node WHERE id = 'n-1'`,
            )
          ).rows,
        ).toEqual([{ name: "one", listen_port: 10001 }]);
        expect(
          (
            await admin.query(
              `SELECT prev_row->'node'->>'listenPort' AS failed_port
               FROM config_change
               WHERE subject_id = 'n-1'
               ORDER BY created_at DESC, id DESC LIMIT 1`,
            )
          ).rows,
        ).toEqual([{ failed_port: "11001" }]);
        expect(await serverSeq("srv-a")).toBe(2);
      });

      it("restores a staged deletion with the task 02 membership cascade", async () => {
        await insertConfigVersion("cv-base", "srv-a", 1, ["n-1"]);
        await insertConfigVersion("cv-delete", "srv-a", 2, []);
        await pointServerAt("srv-a", "cv-base");
        await admitManagedRollout(
          {
            rolloutId: "r-delete",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-delete",
                previousConfigVersionId: "cv-base",
                managedFingerprint: "mf:delete",
                subscriberIntent: { kind: "delete_node", nodeId: "n-1" },
              },
            ],
          },
          { database, activationEnabled: true },
        );

        const committed = await commitManagedStage(
          {
            rolloutId: "r-delete",
            expectedOrdinal: 0,
            expectedTopologyGeneration: 1,
          },
          { database, activationEnabled: true },
        );
        expect(committed).toMatchObject({
          ok: true,
          revisionSeq: 1,
          topologyGeneration: 2,
        });
        expect(
          (await admin.query(`SELECT id FROM node WHERE id = 'n-1'`)).rows,
        ).toEqual([]);
        expect(
          (
            await admin.query(
              `SELECT revision FROM proxy_group WHERE id = 'g-1'`,
            )
          ).rows,
        ).toEqual([{ revision: 2 }]);
        expect(
          (
            await admin.query(
              `SELECT node_id, position FROM node_group WHERE group_id = 'g-1'
               ORDER BY position, node_id`,
            )
          ).rows,
        ).toEqual([{ node_id: "n-2", position: 0 }]);
        expect(committed.ok && committed.changeId).toBeTruthy();

        const compensated = await compensateManagedStage(
          {
            rolloutId: "r-delete",
            ordinal: 1,
            failureCode: "delete_failed",
          },
          { database, activationEnabled: true },
        );
        expect(compensated).toMatchObject({
          ok: true,
          configVersionId: "cv-base",
          revisionSeq: 2,
          topologyGeneration: 3,
        });
        expect(
          (
            await admin.query(
              `SELECT id, listen_port FROM node WHERE id = 'n-1'`,
            )
          ).rows,
        ).toEqual([{ id: "n-1", listen_port: 10001 }]);
        expect(
          (
            await admin.query(
              `SELECT revision FROM proxy_group WHERE id = 'g-1'`,
            )
          ).rows,
        ).toEqual([{ revision: 3 }]);
        expect(
          (
            await admin.query(
              `SELECT node_id, position FROM node_group WHERE group_id = 'g-1'
               ORDER BY position, node_id`,
            )
          ).rows,
        ).toEqual([
          { node_id: "n-1", position: 0 },
          { node_id: "n-2", position: 1 },
        ]);
      });

      it("preserves a newer entitlement change during deletion compensation", async () => {
        await insertConfigVersion("cv-base", "srv-a", 1, ["n-1"]);
        await insertConfigVersion("cv-delete", "srv-a", 2, []);
        await pointServerAt("srv-a", "cv-base");
        await admitManagedRollout(
          {
            rolloutId: "r-delete-newer",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-delete",
                previousConfigVersionId: "cv-base",
                managedFingerprint: "mf:delete-newer",
                subscriberIntent: { kind: "delete_node", nodeId: "n-1" },
              },
            ],
          },
          { database, activationEnabled: true },
        );
        const committed = await commitManagedStage(
          {
            rolloutId: "r-delete-newer",
            expectedOrdinal: 0,
            expectedTopologyGeneration: 1,
          },
          { database, activationEnabled: true },
        );
        expect(committed.ok).toBe(true);

        await admin.query(`INSERT INTO node
          (id, name, server_id, listen_port, protocol, settings)
          VALUES ('n-3', 'three', 'srv-b', 10003, 'trojan', '{}')`);
        const newer = await writeGroupMembership(
          { groupId: "g-1", expectedRevision: 2, nodeIds: ["n-2", "n-3"] },
          { database, driver: driver.name },
        );
        expect(newer.ok).toBe(true);

        const compensated = await compensateManagedStage(
          {
            rolloutId: "r-delete-newer",
            ordinal: 1,
            failureCode: "delete_newer_failed",
          },
          { database, activationEnabled: true },
        );
        expect(compensated.ok).toBe(true);
        expect(
          (await admin.query(`SELECT id FROM node WHERE id = 'n-1'`)).rows,
        ).toEqual([{ id: "n-1" }]);
        expect(
          (
            await admin.query(
              `SELECT revision FROM proxy_group WHERE id = 'g-1'`,
            )
          ).rows,
        ).toEqual([{ revision: 3 }]);
        expect(
          (
            await admin.query(
              `SELECT node_id, position FROM node_group WHERE group_id = 'g-1'
               ORDER BY position, node_id`,
            )
          ).rows,
        ).toEqual([
          { node_id: "n-2", position: 0 },
          { node_id: "n-3", position: 1 },
        ]);
      });

      it("fences legacy structural writers through claims and pointed versions", async () => {
        const updated = await writeLegacySubscriberNode(
          {
            kind: "update",
            nodeId: "n-1",
            values: { listenPort: 10009, name: "one cas" },
          },
          { database },
        );
        expect(updated).toMatchObject({ ok: true, topologyGeneration: 1 });
        expect(
          (
            await admin.query(
              `SELECT name, listen_port FROM node WHERE id = 'n-1'`,
            )
          ).rows,
        ).toEqual([{ name: "one cas", listen_port: 10009 }]);

        await insertConfigVersion("cv-ref", "srv-a", 1, ["n-1"]);
        await pointServerAt("srv-a", "cv-ref");
        expect(
          await readLegacyStructuralNodeWriteFence(
            { nodeId: "n-1", serverIds: ["srv-a"] },
            database,
          ),
        ).toEqual({
          ok: false,
          reason: "managed_reference",
          nodeId: "n-1",
          configVersionIds: ["cv-ref"],
        });
        expect(
          await deleteLegacySubscriberNode({ nodeId: "n-1" }, { database }),
        ).toEqual({
          ok: false,
          reason: "managed_reference",
          nodeId: "n-1",
          configVersionIds: ["cv-ref"],
        });

        await admitManagedRollout(
          {
            rolloutId: "r-fence",
            expectedTopologyGeneration: 1,
            stageCount: 1,
            serverIds: ["srv-a"],
          },
          { database, activationEnabled: true },
        );
        expect(
          await writeLegacySubscriberNode(
            {
              kind: "update",
              nodeId: "n-1",
              values: { listenPort: 10010 },
            },
            { database },
          ),
        ).toEqual({
          ok: false,
          reason: "rollout_in_progress",
          serverId: "srv-a",
          rolloutId: "r-fence",
        });
        expect(
          await writeLegacySubscriberNode(
            {
              kind: "create",
              values: {
                id: "n-fence",
                name: "fence",
                serverId: "srv-a",
                listenPort: 10011,
                protocol: "trojan",
                settings: {},
              },
            },
            { database },
          ),
        ).toEqual({
          ok: false,
          reason: "rollout_in_progress",
          serverId: "srv-a",
          rolloutId: "r-fence",
        });
      });
    });
  }
});
