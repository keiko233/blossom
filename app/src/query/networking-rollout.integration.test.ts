/**
 * Task 09 Apply admission on a REAL, DISPOSABLE PostgreSQL, on node-postgres
 * and (optionally) neon-http. Skipped unless BLOSSOM_TEST_PG_URL is set; the
 * public schema is DROPPED and rebuilt.
 *
 * The default build must refuse admission. The explicit
 * `activationEnabled: true` option here is the canary/service-boundary fixture
 * opt-in; it does not change `MANAGED_NETWORKING_ACTIVATION_ENABLED`.
 */
import type { ManagedIntentRouteRule } from "@blossom/contracts/agent-config-v3";
import { managedStageIntentSchema } from "@blossom/contracts/agent-config-v3";
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

vi.mock("@/db", () => ({ db: {}, getDatabaseDriver: () => "node-postgres" }));
vi.hoisted(() => {
  process.env.DATABASE_URL ??= process.env.BLOSSOM_TEST_PG_URL;
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.CERTIFICATE_MASTER_KEY ??=
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
});

import {
  computeManagedStageIntentDigest,
  computeManagedStateFingerprint,
} from "@/orpc/proxy/singbox";
import { admitManagedRollout } from "@/query/managed-topology-write";
import {
  applyNetworkingRollout,
  planNetworkingRollout,
} from "@/query/networking-rollout";

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

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function applyMigrations(pool: Pool) {
  await pool.query(
    `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`,
  );
  for (const folder of readdirSync(migrationsDir)
    .filter((entry) => !entry.endsWith(".json"))
    .sort()) {
    const text = readFileSync(
      `${migrationsDir}${folder}/migration.sql`,
      "utf8",
    );
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  }
}

function rule(
  partial: Partial<ManagedIntentRouteRule> & { ruleId: string },
): ManagedIntentRouteRule {
  return {
    ruleId: partial.ruleId,
    inboundTags: partial.inboundTags ?? ["node-node-a"],
    sniff: partial.sniff ?? false,
    resolveStrategy: partial.resolveStrategy ?? null,
    network: partial.network ?? "tcp",
    domains: partial.domains ?? [],
    domainSuffixes: partial.domainSuffixes ?? [],
    domainKeywords: partial.domainKeywords ?? [],
    ipCidrs: partial.ipCidrs ?? [],
    ports: partial.ports ?? [],
    ruleSetTags: partial.ruleSetTags ?? [],
    action: partial.action ?? "route",
    outboundTag: partial.outboundTag ?? "direct",
  };
}

const ROLLOUT_INPUT = {
  serverIds: ["srv-a", "srv-b"],
  expectedTopologyGeneration: 0,
};

describe.skipIf(!PG_URL)("networking rollout admission", () => {
  let admin: Pool;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    admin = new Pool({ connectionString: PG_URL, max: 10 });
    await applyMigrations(admin);
  });

  afterAll(async () => {
    await admin?.end();
  });

  beforeEach(async () => {
    await admin.query(`
      TRUNCATE server, managed_certificate, managed_config_version,
               managed_rollout, managed_rule_set_asset, config_change,
               proxy_group CASCADE;
      UPDATE managed_topology SET generation = 0;
      INSERT INTO server
        (id, name, address, enabled, agent_capabilities, ws_session_id,
         sing_box_version, runtime_state, config_state,
         desired_revision_seq, applied_revision_seq)
      VALUES
        ('srv-a', 'Alpha', 'a.example.test', true,
         '["managed-networking-v1","managed-link-probe-v1"]',
         'session-a', '1.14.4', 'running', 'applied', 0, 0),
        ('srv-b', 'Beta', 'b.example.test', true,
         '["managed-networking-v1","managed-link-probe-v1"]',
         'session-b', '1.14.4', 'running', 'applied', 0, 0);
      INSERT INTO node
        (id, name, server_id, listen_port, protocol, settings, enabled)
      VALUES ('node-a', 'A ingress', 'srv-a', 10001, 'trojan', '{}', true);
      INSERT INTO managed_certificate
        (id, name, kind, domains, active_material_version, state)
      VALUES ('cert-b', 'B peer cert', 'self_signed',
              '["b.example.test"]', 1, 'active');
      INSERT INTO certificate_material
        (id, certificate_id, version, certificate_ciphertext,
         private_key_ciphertext, domains, not_before, not_after,
         fingerprint_sha256)
      VALUES ('cert-material-b', 'cert-b', 1, 'ciphertext', 'ciphertext',
              '["b.example.test"]', now() - interval '1 day',
              now() + interval '30 days', 'abcdef0123456789');
      INSERT INTO peer_inbound
        (id, server_id, name, runtime_tag, protocol, listen_address,
         listen_port, advertised_address, advertised_port, tls_server_name,
         certificate_id)
      VALUES ('pi-b', 'srv-b', 'B peer', 'peer-in-pi-b', 'vless', '0.0.0.0',
              20001, 'b.example.test', 20001, 'b.example.test', 'cert-b');
      INSERT INTO peer_link (id, source_server_id, destination_inbound_id)
      VALUES ('link-1', 'srv-a', 'pi-b');
      INSERT INTO managed_outbound
        (id, server_id, kind, name, runtime_tag, link_id)
      VALUES ('out-a-b', 'srv-a', 'peer_link', 'A to B', 'peer-out-out-a-b',
              'link-1');
      INSERT INTO peer_link_credential
        (link_id, generation, state, credential_ciphertext)
      VALUES ('link-1', 1, 'active', 'not-a-real-secret');
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

      it("refuses admission while the default activation gate is off", async () => {
        const result = await applyNetworkingRollout(ROLLOUT_INPUT, {
          database,
        });
        expect(result).toMatchObject({
          ok: false,
          reason: "activation_disabled",
          plan: null,
          rolloutId: null,
        });
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_rollout`,
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_config_version`,
            )
          ).rows[0].count,
        ).toBe(0);
      });

      it("blocks admission when an affected agent is not ready", async () => {
        await admin.query(
          `UPDATE server SET agent_capabilities = '[]' WHERE id = 'srv-b'`,
        );
        const plan = await planNetworkingRollout(ROLLOUT_INPUT, {
          database,
          activationEnabled: true,
        });
        expect(plan.ok).toBe(true);
        expect(plan.admissionReady).toBe(false);
        expect(
          plan.servers.find((server) => server.serverId === "srv-b")?.readiness,
        ).toMatchObject({ ready: false, reasons: ["capability_missing"] });

        const result = await applyNetworkingRollout(ROLLOUT_INPUT, {
          database,
          activationEnabled: true,
        });
        expect(result).toMatchObject({
          ok: false,
          reason: "readiness",
        });
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_rollout`,
            )
          ).rows[0].count,
        ).toBe(0);
      });

      it("freezes receiver-first stages and admits config versions, stages and claims atomically", async () => {
        const plan = await planNetworkingRollout(ROLLOUT_INPUT, {
          database,
          activationEnabled: true,
        });
        expect(plan).toMatchObject({
          ok: true,
          admissionReady: true,
          direction: "apply",
          topologyGeneration: 0,
          reason: null,
        });
        expect(plan.stages.map((stage) => stage.serverId)).toEqual([
          "srv-b",
          "srv-a",
        ]);
        expect(plan.stages[0]).toMatchObject({
          roles: ["receiver"],
          probeLinkId: null,
          previousConfigVersionId: null,
        });
        expect(plan.stages[1]).toMatchObject({
          roles: ["sender"],
          probeLinkId: "link-1",
          previousConfigVersionId: null,
        });

        const result = await applyNetworkingRollout(ROLLOUT_INPUT, {
          database,
          activationEnabled: true,
        });
        expect(result.ok).toBe(true);
        expect(result.reason).toBeNull();
        expect(result.rolloutId).toMatch(/[0-9a-f-]{36}/);
        expect(result.admissionTopologyGeneration).toBe(1);
        expect(result.plan?.ok).toBe(true);

        const rollout = await admin.query(
          `SELECT state, topology_generation, stage_count, current_ordinal
           FROM managed_rollout`,
        );
        expect(rollout.rows).toEqual([
          {
            state: "applying",
            topology_generation: 1,
            stage_count: 2,
            current_ordinal: 0,
          },
        ]);
        const stages = await admin.query(
          `SELECT ordinal, server_id, config_version_id,
                  previous_config_version_id, managed_fingerprint, probe_link_id,
                  state
           FROM managed_rollout_stage ORDER BY ordinal`,
        );
        expect(stages.rows.map((row) => ({ ...row }))).toMatchObject([
          {
            ordinal: 1,
            server_id: "srv-b",
            previous_config_version_id: null,
            probe_link_id: null,
            state: "pending",
          },
          {
            ordinal: 2,
            server_id: "srv-a",
            previous_config_version_id: null,
            probe_link_id: "link-1",
            state: "pending",
          },
        ]);
        const claims = await admin.query(
          `SELECT server_id, rollout_id FROM managed_rollout_claim
           ORDER BY server_id`,
        );
        expect(claims.rows).toEqual([
          { server_id: "srv-a", rollout_id: result.rolloutId },
          { server_id: "srv-b", rollout_id: result.rolloutId },
        ]);
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_server_state`,
            )
          ).rows[0].count,
        ).toBe(0);

        const configs = await admin.query(
          `SELECT id, server_id, version, intent, intent_digest
           FROM managed_config_version ORDER BY server_id`,
        );
        expect(configs.rows).toHaveLength(2);
        for (const row of configs.rows) {
          const stage = stages.rows.find(
            (candidate) => candidate.config_version_id === row.id,
          );
          expect(stage).toBeDefined();
          const parsed = managedStageIntentSchema.parse(row.intent);
          expect(computeManagedStageIntentDigest(parsed)).toBe(
            row.intent_digest,
          );
          expect(computeManagedStateFingerprint(parsed)).toBe(
            stage.managed_fingerprint,
          );
          expect(parsed.topologyGeneration).toBe(0);
        }
      });

      it("reports a stale topology without writing config versions or claims", async () => {
        await admin.query(`UPDATE managed_topology SET generation = 4`);
        const result = await applyNetworkingRollout(ROLLOUT_INPUT, {
          database,
          activationEnabled: true,
        });
        expect(result).toMatchObject({
          ok: false,
          reason: "topology_conflict",
          currentTopologyGeneration: 4,
        });
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_rollout`,
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_config_version`,
            )
          ).rows[0].count,
        ).toBe(0);
      });

      it("reports an active rollout claim without admitting a second rollout", async () => {
        await admin.query(`
          INSERT INTO managed_rollout
            (id, state, topology_generation, stage_count)
          VALUES ('rollout-existing', 'applying', 0, 1);
          INSERT INTO managed_rollout_claim (server_id, rollout_id)
          VALUES ('srv-b', 'rollout-existing');
        `);
        const result = await applyNetworkingRollout(ROLLOUT_INPUT, {
          database,
          activationEnabled: true,
        });
        expect(result).toMatchObject({
          ok: false,
          reason: "claim_conflict",
          conflict: {
            serverId: "srv-b",
            rolloutId: "rollout-existing",
          },
        });
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_rollout`,
            )
          ).rows[0].count,
        ).toBe(1);
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_config_version`,
            )
          ).rows[0].count,
        ).toBe(0);
      });

      it("rejects over-budget frozen intents before writing", async () => {
        await admin.query(`
          INSERT INTO managed_rule_set_asset
            (rule_set_id, version, format, source, content_base64,
             size_bytes, sha256)
          SELECT 'rs-' || n, 'v1', 'binary', 'test', 'x', 524288,
                 repeat('a', 64)
          FROM generate_series(1, 5) AS n;
        `);
        const input = {
          ...ROLLOUT_INPUT,
          draft: {
            serverId: "srv-a",
            finalOutboundTag: "direct",
            rules: [
              rule({
                ruleId: "rule-over-budget",
                ruleSetTags: [
                  "rule-set-rs-1",
                  "rule-set-rs-2",
                  "rule-set-rs-3",
                  "rule-set-rs-4",
                  "rule-set-rs-5",
                ],
              }),
            ],
            expectedTopologyGeneration: 0,
          },
        };
        const plan = await planNetworkingRollout(input, {
          database,
          activationEnabled: true,
        });
        expect(plan.ok).toBe(true);
        expect(plan.admissionReady).toBe(false);
        expect(
          plan.servers.find((server) => server.serverId === "srv-a")?.budget,
        ).toMatchObject({ ok: false });
        expect(
          plan.servers
            .find((server) => server.serverId === "srv-a")
            ?.budget.violations.map((violation) => violation.code),
        ).toContain("rule_set_aggregate_too_large");

        const result = await applyNetworkingRollout(input, {
          database,
          activationEnabled: true,
        });
        expect(result).toMatchObject({
          ok: false,
          reason: "budget",
        });
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_rollout`,
            )
          ).rows[0].count,
        ).toBe(0);
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_config_version`,
            )
          ).rows[0].count,
        ).toBe(0);
      });

      it("rejects a changed applied pointer before admission", async () => {
        await admin.query(`
          INSERT INTO managed_config_version
            (id, server_id, version, schema_version, intent, intent_digest,
             subscriber_node_ids)
          VALUES ('cfg-old-b', 'srv-b', 1, 1, '{}', 'sha256:old', '[]'::jsonb);
          INSERT INTO managed_server_state
            (server_id, applied_config_version_id)
          VALUES ('srv-b', 'cfg-old-b');
        `);
        const result = await admitManagedRollout(
          {
            rolloutId: "rollout-state-guard",
            expectedTopologyGeneration: 0,
            stageCount: 2,
            serverIds: ["srv-a", "srv-b"],
            serverStates: [
              { serverId: "srv-b", appliedConfigVersionId: null },
              { serverId: "srv-a", appliedConfigVersionId: null },
            ],
          },
          { database, activationEnabled: true },
        );
        expect(result).toMatchObject({
          ok: false,
          reason: "state_conflict",
          serverId: "srv-b",
          expectedAppliedConfigVersionId: null,
          currentAppliedConfigVersionId: "cfg-old-b",
        });
        expect(
          (
            await admin.query(
              `SELECT count(*)::int AS count FROM managed_rollout
               WHERE id = 'rollout-state-guard'`,
            )
          ).rows[0].count,
        ).toBe(0);
      });
    });
  }
});
