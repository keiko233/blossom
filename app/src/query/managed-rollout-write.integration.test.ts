/**
 * Rollout transitions and link probes on a REAL, DISPOSABLE PostgreSQL,
 * on node-postgres and (optionally) neon-http. Skipped unless
 * BLOSSOM_TEST_PG_URL is set; see group-membership-write.integration.test.ts
 * for the variables. The public schema is DROPPED and rebuilt.
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

vi.mock("@/db", () => ({ db: {}, getDatabaseDriver: () => "node-postgres" }));

import {
  abortManagedRollout,
  listManagedLinkProbes,
  listManagedRolloutDetails,
  readManagedRolloutDetail,
  recordManagedLinkProbeResult,
  recordManagedStageReport,
  reconcileManagedRollout,
  retryManagedRolloutStage,
} from "@/query/managed-rollout-write";
import { admitManagedRollout } from "@/query/managed-topology-write";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;
const NEON_URL = process.env.BLOSSOM_TEST_NEON_HTTP_URL;
const NEON_CONNECTION_URL = process.env.BLOSSOM_TEST_NEON_CONNECTION_URL;

const FP_B1 = `sha256:${"b".repeat(64)}`;
const FP_A2 = `sha256:${"a".repeat(64)}`;
const FP_A3 = `sha256:${"c".repeat(64)}`;
const FP_R1 = `sha256:${"d".repeat(64)}`;
const FP_R2 = `sha256:${"e".repeat(64)}`;

function assertDisposable(raw: string) {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (
    !loopback.includes(url.hostname) ||
    (!dbName.startsWith("blossom_disposable_") &&
      !dbName.startsWith("blossom_test"))
  ) {
    throw new Error(
      "BLOSSOM_TEST_PG_URL must be a loopback database named blossom_test* or blossom_disposable_*",
    );
  }
}

describe.skipIf(!PG_URL)("managed rollout transitions", () => {
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
      TRUNCATE server, proxy_group, managed_rollout, config_change,
               managed_certificate CASCADE;
      UPDATE managed_topology SET generation = 0;
      INSERT INTO server (id, name, address, agent_capabilities, ws_session_id, desired_revision_seq, applied_revision_seq)
      VALUES ('srv-a', 'a', 'a.example.test',
              '["managed-link-probe-v1"]', 'session-a', 0, 0),
             ('srv-b', 'b', 'b.example.test',
              '["managed-link-probe-v1"]', 'session-b', 0, 0),
             ('srv-c', 'c', 'c.example.test',
              '["managed-link-probe-v1"]', 'session-c', 0, 0);
      INSERT INTO managed_certificate (id, name, kind, domains)
      VALUES ('cert-b', 'b cert', 'self_signed', '["peer.example.test"]');
      INSERT INTO peer_inbound
        (id, server_id, name, runtime_tag, protocol, listen_address, listen_port,
         advertised_address, advertised_port, tls_server_name, certificate_id)
      VALUES ('pi-b', 'srv-b', 'peer b', 'peer-in-pi-b', 'trojan',
              '127.0.0.1', 20001, 'b.example.test', 20001,
              'peer.example.test', 'cert-b');
      INSERT INTO peer_link (id, source_server_id, destination_inbound_id)
      VALUES ('link-1', 'srv-a', 'pi-b');
      INSERT INTO peer_link_credential
        (link_id, generation, state, credential_ciphertext)
      VALUES ('link-1', 1, 'active', 'not-a-real-secret');
    `);
  });

  async function insertConfigVersion(
    id: string,
    serverId: string,
    version: number,
  ) {
    await admin.query(
      `INSERT INTO managed_config_version
       (id, server_id, version, schema_version, intent, intent_digest, subscriber_node_ids)
     VALUES ($1, $2, $3, 1, '{}', $4, '[]'::jsonb)`,
      [id, serverId, version, `sha256:${id}`],
    );
  }

  async function setServerSeq(serverId: string, seq: number) {
    await admin.query(
      `UPDATE server SET desired_revision_seq = $2 WHERE id = $1`,
      [serverId, seq],
    );
  }

  async function stageRow(rolloutId: string, ordinal: number) {
    const { rows } = await admin.query(
      `SELECT state, min_revision_seq, issued_revision_seq, deadline_at,
              confirmed_at, recovery_min_revision_seq,
              recovery_managed_fingerprint, recovery_deadline_at,
              recovery_proven_at
       FROM managed_rollout_stage WHERE rollout_id = $1 AND ordinal = $2`,
      [rolloutId, ordinal],
    );
    return rows[0];
  }

  async function admitReceiverFirstRollout(
    database: Database,
    rolloutId: string,
  ) {
    await insertConfigVersion("cv-b1", "srv-b", 1);
    await insertConfigVersion("cv-a2-base", "srv-a", 1);
    await insertConfigVersion("cv-a2", "srv-a", 2);
    await insertConfigVersion("cv-a3", "srv-a", 3);
    const admitted = await admitManagedRollout(
      {
        rolloutId,
        expectedTopologyGeneration: 0,
        stageCount: 3,
        serverIds: ["srv-b", "srv-a"],
        stages: [
          {
            ordinal: 1,
            serverId: "srv-b",
            configVersionId: "cv-b1",
            previousConfigVersionId: null,
            managedFingerprint: FP_B1,
          },
          {
            ordinal: 2,
            serverId: "srv-a",
            configVersionId: "cv-a2",
            previousConfigVersionId: null,
            managedFingerprint: FP_A2,
            probeLinkId: "link-1",
          },
          {
            ordinal: 3,
            serverId: "srv-a",
            configVersionId: "cv-a3",
            previousConfigVersionId: "cv-a2",
            managedFingerprint: FP_A3,
          },
        ],
      },
      { database, activationEnabled: true },
    );
    expect(admitted.ok).toBe(true);
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

      it("issues only, starts the deadline, and confirms only on an authenticated matching report", async () => {
        await admitReceiverFirstRollout(database, "rollout-proof");
        const before = new Date();

        const issued = await reconcileManagedRollout("rollout-proof", {
          database,
          activationEnabled: true,
          now: before,
        });
        expect(issued).toMatchObject({
          ok: true,
          action: "issued",
          ordinal: 1,
          serverId: "srv-b",
          notifyServerId: "srv-b",
        });
        if (!issued.ok || issued.action !== "issued") return;
        const row = await stageRow("rollout-proof", 1);
        expect(row.state).toBe("issued");
        expect(row.min_revision_seq).toBe(issued.revisionSeq);
        expect(row.issued_revision_seq).toBe(issued.revisionSeq);
        expect(row.confirmed_at).toBeNull();
        expect(new Date(row.deadline_at).getTime()).toBeGreaterThan(
          before.getTime(),
        );

        const replay = await reconcileManagedRollout("rollout-proof", {
          database,
          activationEnabled: true,
          now: before,
        });
        expect(replay).toMatchObject({ ok: true, action: "await_proof" });
        expect((await stageRow("rollout-proof", 1)).issued_revision_seq).toBe(
          issued.revisionSeq,
        );
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-b",
              outcome: "failed",
              desiredRevisionSeq: 0,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "ignored",
          reason: "stale_revision",
        });

        // A timeout never confirms.
        await admin.query(
          `UPDATE managed_rollout_stage SET deadline_at = now() - interval '1 second'
           WHERE rollout_id = 'rollout-proof' AND ordinal = 1`,
        );
        expect(
          await reconcileManagedRollout("rollout-proof", {
            database,
            activationEnabled: true,
            now: new Date(),
          }),
        ).toMatchObject({ ok: true, action: "stalled", ordinal: 1 });
        expect((await stageRow("rollout-proof", 1)).state).toBe("issued");

        // Stale, foreign and replaced-session reports never confirm.
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_B1,
            },
            { database, activationEnabled: true },
          ),
        ).toEqual({ ok: false, reason: "session_fenced" });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_A2,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, action: "ignored" });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-b",
              outcome: "applied",
              desiredRevisionSeq: 0,
              managedFingerprint: FP_B1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "ignored",
          reason: "stale_revision",
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-b",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_A2,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "ignored",
          reason: "fingerprint_mismatch",
        });

        const confirmed = await recordManagedStageReport(
          {
            authenticatedServerId: "srv-b",
            sessionId: "session-b",
            outcome: "applied",
            desiredRevisionSeq: 1,
            managedFingerprint: FP_B1,
          },
          { database, activationEnabled: true },
        );
        expect(confirmed).toMatchObject({
          ok: true,
          action: "confirmed",
          ordinal: 1,
        });
        expect((await stageRow("rollout-proof", 1)).state).toBe("confirmed");
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-b",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_B1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "ignored",
          reason: "already_confirmed",
        });
      });

      it("runs receiver-first activation, pauses on emergency disable, probes and completes", async () => {
        await admitReceiverFirstRollout(database, "rollout-full");
        const now = new Date();
        await reconcileManagedRollout("rollout-full", {
          database,
          activationEnabled: true,
          now,
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-b",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_B1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, action: "confirmed", ordinal: 1 });

        // Emergency disable pauses forward advancement and keeps the claim.
        await admin.query(
          `UPDATE server SET enabled = false WHERE id = 'srv-b'`,
        );
        expect(
          await reconcileManagedRollout("rollout-full", {
            database,
            activationEnabled: true,
            now,
          }),
        ).toMatchObject({
          ok: true,
          action: "paused",
          serverIds: ["srv-b"],
        });
        const paused = await readManagedRolloutDetail(
          "rollout-full",
          now,
          database,
        );
        expect(paused?.paused).toBe(true);
        expect(paused?.view.claimsHeld).toBe(true);
        await admin.query(
          `UPDATE server SET enabled = true WHERE id = 'srv-b'`,
        );

        const senderIssued = await reconcileManagedRollout("rollout-full", {
          database,
          activationEnabled: true,
          now,
        });
        expect(senderIssued).toMatchObject({
          ok: true,
          action: "issued",
          ordinal: 2,
          serverId: "srv-a",
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_A2,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, action: "confirmed", ordinal: 2 });

        const probeIssued = await reconcileManagedRollout("rollout-full", {
          database,
          activationEnabled: true,
          now,
        });
        expect(probeIssued).toMatchObject({
          ok: true,
          action: "probe_issued",
          ordinal: 2,
          linkId: "link-1",
          notifyServerId: "srv-a",
        });
        if (!probeIssued.ok || probeIssued.action !== "probe_issued") return;
        const firstProbe = probeIssued.request;
        expect(firstProbe.source.minRevisionSeq).toBe(1);
        expect(firstProbe.destination.minRevisionSeq).toBe(1);
        expect(firstProbe.credentialGeneration).toBe(1);

        // Wrong source, stale source generation and expiry are all rejected.
        const result = {
          probeId: firstProbe.probeId,
          rolloutId: firstProbe.rolloutId,
          stageOrdinal: firstProbe.stageOrdinal,
          linkId: firstProbe.linkId,
          outcome: "succeeded" as const,
          applied: { desiredRevisionSeq: 1, managedFingerprint: FP_A2 },
          completedAt: now.toISOString(),
        };
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-b",
              result,
            },
            { database, activationEnabled: true, now },
          ),
        ).toEqual({
          ok: true,
          action: "rejected",
          reason: "wrong_server",
        });
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              result: {
                ...result,
                applied: { desiredRevisionSeq: 0, managedFingerprint: FP_A2 },
              },
            },
            { database, activationEnabled: true, now },
          ),
        ).toEqual({
          ok: true,
          action: "rejected",
          reason: "stale_generation",
        });
        const expiredAt = new Date(Date.parse(firstProbe.expiresAt) + 1);
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              result,
            },
            { database, activationEnabled: true, now: expiredAt },
          ),
        ).toEqual({ ok: true, action: "rejected", reason: "expired" });

        // A failed probe blocks advancement; Retry issues a new attempt and
        // invalidates the old result without moving the pointer.
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              result: { ...result, outcome: "timeout" },
            },
            { database, activationEnabled: true, now },
          ),
        ).toMatchObject({ ok: true, action: "recorded", outcome: "timeout" });
        const blocked = await reconcileManagedRollout("rollout-full", {
          database,
          activationEnabled: true,
          now,
        });
        expect(blocked).toMatchObject({
          ok: true,
          action: "probe_blocked",
          state: "failed",
        });
        const retried = await retryManagedRolloutStage("rollout-full", {
          database,
          activationEnabled: true,
          now,
        });
        expect(retried).toMatchObject({
          ok: true,
          action: "probe_issued",
          ordinal: 2,
        });
        if (!retried.ok || retried.action !== "probe_issued") return;
        expect((await stageRow("rollout-full", 2)).min_revision_seq).toBe(1);
        expect((await stageRow("rollout-full", 2)).issued_revision_seq).toBe(1);
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              result: { ...result, completedAt: now.toISOString() },
            },
            { database, activationEnabled: true, now },
          ),
        ).toEqual({
          ok: true,
          action: "rejected",
          reason: "superseded_probe",
        });
        const secondResult = {
          ...result,
          probeId: retried.request.probeId,
        };
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              result: secondResult,
            },
            { database, activationEnabled: true, now },
          ),
        ).toMatchObject({ ok: true, action: "recorded", outcome: "succeeded" });
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              result: secondResult,
            },
            { database, activationEnabled: true, now },
          ),
        ).toMatchObject({
          ok: true,
          action: "recorded",
          duplicate: true,
        });
        expect(
          await listManagedLinkProbes("rollout-full", database),
        ).toHaveLength(2);

        const routingIssued = await reconcileManagedRollout("rollout-full", {
          database,
          activationEnabled: true,
          now,
        });
        expect(routingIssued).toMatchObject({
          ok: true,
          action: "issued",
          ordinal: 3,
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: 2,
              managedFingerprint: FP_A3,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, action: "confirmed", ordinal: 3 });

        const completed = await reconcileManagedRollout("rollout-full", {
          database,
          activationEnabled: true,
          now,
        });
        expect(completed).toMatchObject({
          ok: true,
          action: "completed",
          releasedClaimServerIds: ["srv-a", "srv-b"],
        });
        const detail = await readManagedRolloutDetail(
          "rollout-full",
          now,
          database,
        );
        expect(detail?.view.status).toBe("completed");
        expect(detail?.view.claimsHeld).toBe(false);
        const listed = await listManagedRolloutDetails(
          { serverId: "srv-a" },
          now,
          database,
        );
        expect(listed.map((entry) => entry.rolloutId)).toContain(
          "rollout-full",
        );
        expect(
          await reconcileManagedRollout("rollout-full", {
            database,
            activationEnabled: true,
            now,
          }),
        ).toMatchObject({ ok: true, action: "none" });
      });

      it("retries a stalled stage by moving only its deadline", async () => {
        await insertConfigVersion("cv-r1", "srv-a", 1);
        expect(
          await admitManagedRollout(
            {
              rolloutId: "rollout-retry",
              expectedTopologyGeneration: 0,
              stageCount: 1,
              serverIds: ["srv-a"],
              stages: [
                {
                  ordinal: 1,
                  serverId: "srv-a",
                  configVersionId: "cv-r1",
                  previousConfigVersionId: null,
                  managedFingerprint: FP_R1,
                },
              ],
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true });
        const issued = await reconcileManagedRollout("rollout-retry", {
          database,
          activationEnabled: true,
          now: new Date(),
        });
        expect(issued).toMatchObject({ ok: true, action: "issued" });
        if (!issued.ok || issued.action !== "issued") return;
        const committedSeq = issued.revisionSeq;
        await admin.query(
          `UPDATE managed_rollout_stage SET deadline_at = now() - interval '1 second'
           WHERE rollout_id = 'rollout-retry'`,
        );
        await setServerSeq("srv-a", committedSeq + 7);
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "failed",
              desiredRevisionSeq: committedSeq,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "ignored",
          reason: "not_current_identifier",
        });
        expect(
          await retryManagedRolloutStage("rollout-retry", {
            database,
            activationEnabled: true,
            now: new Date(),
          }),
        ).toEqual({ ok: false, reason: "not_retryable" });
        expect(
          await reconcileManagedRollout("rollout-retry", {
            database,
            activationEnabled: true,
            now: new Date(),
          }),
        ).toMatchObject({ ok: true, action: "stalled", ordinal: 1 });

        const retriedAt = new Date();
        const retried = await retryManagedRolloutStage("rollout-retry", {
          database,
          activationEnabled: true,
          now: retriedAt,
        });
        expect(retried).toMatchObject({
          ok: true,
          action: "deadline_extended",
          ordinal: 1,
          notifyServerId: "srv-a",
        });
        if (!retried.ok || retried.action !== "deadline_extended") return;
        expect(retried.deadlineAt.getTime()).toBeGreaterThan(
          retriedAt.getTime(),
        );
        const after = await stageRow("rollout-retry", 1);
        expect(after.state).toBe("issued");
        expect(after.min_revision_seq).toBe(committedSeq);
        expect(after.issued_revision_seq).toBe(committedSeq);
        const { rows } = await admin.query(
          `SELECT current_ordinal, state FROM managed_rollout WHERE id = 'rollout-retry'`,
        );
        expect(rows[0]).toEqual({ current_ordinal: 1, state: "applying" });
      });

      it("aborts during apply, proves recovery in reverse order and holds claims until every target is proven", async () => {
        await insertConfigVersion("cv-ab1", "srv-a", 1);
        await insertConfigVersion("cv-ab2", "srv-a", 2);
        expect(
          await admitManagedRollout(
            {
              rolloutId: "rollout-abort",
              expectedTopologyGeneration: 0,
              stageCount: 2,
              serverIds: ["srv-a"],
              stages: [
                {
                  ordinal: 1,
                  serverId: "srv-a",
                  configVersionId: "cv-ab1",
                  previousConfigVersionId: null,
                  managedFingerprint: FP_R1,
                },
                {
                  ordinal: 2,
                  serverId: "srv-a",
                  configVersionId: "cv-ab2",
                  previousConfigVersionId: "cv-ab1",
                  managedFingerprint: FP_R2,
                },
              ],
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true });
        await reconcileManagedRollout("rollout-abort", {
          database,
          activationEnabled: true,
          now: new Date(),
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_R1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, action: "confirmed", ordinal: 1 });
        await reconcileManagedRollout("rollout-abort", {
          database,
          activationEnabled: true,
          now: new Date(),
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: 2,
              managedFingerprint: FP_R2,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({ ok: true, action: "confirmed", ordinal: 2 });

        const aborted = await abortManagedRollout("rollout-abort", {
          database,
          activationEnabled: true,
          now: new Date(),
        });
        expect(aborted).toMatchObject({
          ok: true,
          action: "compensated",
          ordinal: 2,
          recoveryManagedFingerprint: FP_R1,
        });
        if (!aborted.ok || aborted.action !== "compensated") return;
        const recoverySeq = aborted.recoveryMinRevisionSeq;
        expect(recoverySeq).toBeGreaterThan(2);
        const stage2 = await stageRow("rollout-abort", 2);
        expect(stage2.state).toBe("failed");
        expect(stage2.recovery_managed_fingerprint).toBe(FP_R1);
        expect(stage2.recovery_proven_at).toBeNull();
        const detail = await readManagedRolloutDetail(
          "rollout-abort",
          new Date(),
          database,
        );
        expect(detail?.view.status).toBe("recovering");
        expect(detail?.view.claimsHeld).toBe(true);

        // The candidate may still be serving; a late candidate ACK proves
        // nothing and must not finish recovery.
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: recoverySeq!,
              managedFingerprint: FP_R2,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "ignored",
          reason: "fingerprint_mismatch",
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: recoverySeq!,
              managedFingerprint: FP_R1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "recovery_proven",
          ordinal: 2,
        });
        expect(
          (
            await readManagedRolloutDetail(
              "rollout-abort",
              new Date(),
              database,
            )
          )?.view.claimsHeld,
        ).toBe(true);

        const receiverCompensation = await reconcileManagedRollout(
          "rollout-abort",
          { database, activationEnabled: true, now: new Date() },
        );
        expect(receiverCompensation).toMatchObject({
          ok: true,
          action: "compensated",
          ordinal: 1,
          recoveryManagedFingerprint: null,
        });
        if (
          !receiverCompensation.ok ||
          receiverCompensation.action !== "compensated"
        ) {
          return;
        }
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: receiverCompensation.recoveryMinRevisionSeq!,
              managedFingerprint: null,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "recovery_proven",
          ordinal: 1,
        });

        const finished = await reconcileManagedRollout("rollout-abort", {
          database,
          activationEnabled: true,
          now: new Date(),
        });
        expect(finished).toMatchObject({
          ok: true,
          action: "recovery_finished",
          finalState: "aborted",
          releasedClaimServerIds: ["srv-a"],
        });
        const final = await readManagedRolloutDetail(
          "rollout-abort",
          new Date(),
          database,
        );
        expect(final?.view.status).toBe("aborted");
        expect(final?.view.claimsHeld).toBe(false);
        expect(
          await abortManagedRollout("rollout-abort", {
            database,
            activationEnabled: true,
            now: new Date(),
          }),
        ).toEqual({ ok: false, reason: "rollout_inactive" });
      });

      it("compensates on an authenticated current-stage failure and recovers to the failed state", async () => {
        await insertConfigVersion("cv-fail", "srv-a", 1);
        await admitManagedRollout(
          {
            rolloutId: "rollout-fail",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-fail",
                previousConfigVersionId: null,
                managedFingerprint: FP_R1,
              },
            ],
          },
          { database, activationEnabled: true },
        );
        await reconcileManagedRollout("rollout-fail", {
          database,
          activationEnabled: true,
          now: new Date(),
        });
        const failed = await recordManagedStageReport(
          {
            authenticatedServerId: "srv-a",
            sessionId: "session-a",
            outcome: "failed",
            desiredRevisionSeq: 1,
          },
          { database, activationEnabled: true },
        );
        expect(failed).toMatchObject({
          ok: true,
          action: "compensated",
          ordinal: 1,
          recoveryManagedFingerprint: null,
        });
        if (!failed.ok || failed.action !== "compensated") return;
        expect(
          (await readManagedRolloutDetail("rollout-fail", new Date(), database))
            ?.view.status,
        ).toBe("recovering");
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: failed.recoveryMinRevisionSeq!,
              managedFingerprint: FP_R1,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "ignored",
          reason: "fingerprint_mismatch",
        });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              outcome: "applied",
              desiredRevisionSeq: failed.recoveryMinRevisionSeq!,
              managedFingerprint: null,
            },
            { database, activationEnabled: true },
          ),
        ).toMatchObject({
          ok: true,
          action: "recovery_proven",
          ordinal: 1,
        });
        expect(
          await reconcileManagedRollout("rollout-fail", {
            database,
            activationEnabled: true,
            now: new Date(),
          }),
        ).toMatchObject({
          ok: true,
          action: "recovery_finished",
          finalState: "failed",
          releasedClaimServerIds: ["srv-a"],
        });
      });

      it("finishes an abort directly when nothing was issued", async () => {
        await insertConfigVersion("cv-empty", "srv-a", 1);
        await admitManagedRollout(
          {
            rolloutId: "rollout-empty-abort",
            expectedTopologyGeneration: 0,
            stageCount: 1,
            serverIds: ["srv-a"],
            stages: [
              {
                ordinal: 1,
                serverId: "srv-a",
                configVersionId: "cv-empty",
                previousConfigVersionId: null,
                managedFingerprint: FP_R1,
              },
            ],
          },
          { database, activationEnabled: true },
        );
        expect(
          await abortManagedRollout("rollout-empty-abort", {
            database,
            activationEnabled: true,
            now: new Date(),
          }),
        ).toMatchObject({
          ok: true,
          action: "finished",
          finalState: "aborted",
          releasedClaimServerIds: ["srv-a"],
        });
      });

      it("keeps managed rollout writes disabled by default", async () => {
        await admitReceiverFirstRollout(database, "rollout-disabled");
        expect(
          await reconcileManagedRollout("rollout-disabled", { database }),
        ).toEqual({ ok: false, reason: "activation_disabled" });
        expect(
          await recordManagedStageReport(
            {
              authenticatedServerId: "srv-b",
              sessionId: "session-b",
              outcome: "applied",
              desiredRevisionSeq: 1,
              managedFingerprint: FP_B1,
            },
            { database },
          ),
        ).toEqual({ ok: false, reason: "activation_disabled" });
        expect(
          await recordManagedLinkProbeResult(
            {
              authenticatedServerId: "srv-a",
              sessionId: "session-a",
              result: {
                probeId: "missing",
                rolloutId: "rollout-disabled",
                stageOrdinal: 1,
                linkId: "link-1",
                outcome: "succeeded",
                applied: {
                  desiredRevisionSeq: 0,
                  managedFingerprint: FP_A2,
                },
                completedAt: new Date().toISOString(),
              },
            },
            { database },
          ),
        ).toEqual({ ok: false, reason: "activation_disabled" });
      });
    });
  }
});
