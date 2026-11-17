import { parseRevisionSeq } from "@blossom/domain/config-revision";
import { and, asc, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { z } from "zod";

import { db } from "@/db";
import { node, type Server, server } from "@/db/proxy-schema";
import { trafficReport } from "@/db/traffic-schema";
import type { heartbeatSchema } from "@/orpc/proxy/schema";
import { pruneAppliedConfigChanges } from "@/query/config-change";

type AgentHeartbeat = z.infer<typeof heartbeatSchema>;

export async function findAgentServerByTokenHash(
  tokenHash: string,
): Promise<Server | null> {
  const [row] = await db
    .select()
    .from(server)
    .where(eq(server.agentTokenHash, tokenHash));
  return row ?? null;
}

export async function listEnabledServerNodes(serverId: string) {
  return db
    .select()
    .from(node)
    .where(and(eq(node.serverId, serverId), eq(node.enabled, true)))
    .orderBy(asc(node.id));
}

export async function updateAgentHeartbeat(
  serverId: string,
  input: AgentHeartbeat,
): Promise<void> {
  const hasStatus =
    input.runtimeState !== undefined ||
    input.configState !== undefined ||
    input.observedRevision !== undefined ||
    input.appliedRevision !== undefined ||
    input.updates !== undefined ||
    input.error !== undefined ||
    input.clearError !== undefined;
  const error = input.error;
  // The applied revision carries the publish-gate sequence as a numeric
  // prefix ("<seq>:<hash>"). It only ever moves forward; legacy hash-only
  // revisions parse to null and leave the seq untouched.
  const appliedSeq = parseRevisionSeq(input.appliedRevision);
  const sanitizeMessage = (message: string) =>
    [...message]
      .filter((character) => {
        const code = character.charCodeAt(0);
        return (
          code === 9 ||
          code === 10 ||
          code === 13 ||
          (code >= 32 && code !== 127)
        );
      })
      .join("")
      .replace(/\/tmp\/[^\s:]+/g, "<config>")
      .replace(
        /("[^"]*(?:password|token|secret|private_key)[^"]*"\s*:\s*")[^"]*/gi,
        "$1<redacted>",
      )
      .slice(0, 4096);

  await db
    .update(server)
    .set({
      lastSeenAt: new Date(),
      ...(input.agentVersion !== undefined
        ? { agentVersion: input.agentVersion }
        : {}),
      ...(input.agentBuildId !== undefined
        ? { agentBuildId: input.agentBuildId }
        : {}),
      ...(input.agentCapabilities !== undefined
        ? { agentCapabilities: input.agentCapabilities }
        : {}),
      ...(input.singBoxVersion !== undefined
        ? { singBoxVersion: input.singBoxVersion }
        : {}),
      ...(input.updates?.agent
        ? {
            agentUpdateState: input.updates.agent.state,
            agentUpdateTarget: input.updates.agent.targetVersion ?? null,
            agentUpdateError: input.updates.agent.message
              ? sanitizeMessage(input.updates.agent.message)
              : null,
            agentUpdateCheckedAt: input.updates.agent.checkedAt
              ? new Date(input.updates.agent.checkedAt)
              : new Date(),
          }
        : {}),
      ...(input.updates?.singBox
        ? {
            singBoxUpdateState: input.updates.singBox.state,
            singBoxUpdateTarget: input.updates.singBox.targetVersion ?? null,
            singBoxUpdateError: input.updates.singBox.message
              ? sanitizeMessage(input.updates.singBox.message)
              : null,
            singBoxUpdateCheckedAt: input.updates.singBox.checkedAt
              ? new Date(input.updates.singBox.checkedAt)
              : new Date(),
          }
        : {}),
      ...(input.runtimeState !== undefined
        ? { runtimeState: input.runtimeState }
        : {}),
      ...(input.configState !== undefined
        ? { configState: input.configState }
        : {}),
      ...(input.observedRevision !== undefined
        ? { observedRevision: input.observedRevision }
        : {}),
      ...(input.appliedRevision !== undefined
        ? { appliedRevision: input.appliedRevision }
        : {}),
      ...(appliedSeq !== null
        ? {
            appliedRevisionSeq: sql<number>`GREATEST(${server.appliedRevisionSeq}, ${appliedSeq})`,
          }
        : {}),
      ...(input.clearActiveNodeIds
        ? { activeNodeIds: [] }
        : input.activeNodeIds !== undefined
          ? { activeNodeIds: input.activeNodeIds }
          : {}),
      ...(hasStatus ? { statusReportedAt: new Date() } : {}),
      ...(!hasStatus
        ? {
            runtimeState: "unknown" as const,
            configState: "unknown" as const,
            activeNodeIds: [],
            statusReportedAt: null,
            lastErrorPhase: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            lastErrorNodeId: null,
            lastErrorAt: null,
          }
        : {}),
      ...(input.appliedAt !== undefined
        ? { lastAppliedAt: new Date(input.appliedAt) }
        : {}),
      ...(input.clearError
        ? {
            lastErrorPhase: null,
            lastErrorCode: null,
            lastErrorMessage: null,
            lastErrorNodeId: null,
            lastErrorAt: null,
          }
        : error === undefined
          ? {}
          : {
              lastErrorPhase: error.phase,
              lastErrorCode: error.code,
              lastErrorMessage: sanitizeMessage(error.message),
              lastErrorNodeId: error.nodeId ?? null,
              lastErrorAt: error.occurredAt
                ? new Date(error.occurredAt)
                : new Date(),
            }),
    })
    .where(eq(server.id, serverId));

  // Change links at or below the confirmed applied seq can never gate again.
  if (appliedSeq !== null) {
    await pruneAppliedConfigChanges(serverId, appliedSeq);
  }
}

export async function listServerNodeIds(serverId: string): Promise<string[]> {
  const rows = await db
    .select({ id: node.id })
    .from(node)
    .where(eq(node.serverId, serverId));
  return rows.map((row) => row.id);
}

/**
 * How long a `(serverId, reportId)` ledger row is kept. It must stay longer than
 * the longest time an agent may keep retrying one batch (7 days, enforced by the
 * agent), otherwise a very late replay could find no ledger row and be applied
 * a second time.
 */
export const TRAFFIC_REPORT_RETENTION_DAYS = 30;
const TRAFFIC_REPORT_PRUNE_BATCH = 500;

/** One resolved entry of a traffic report, ready to be applied. */
export interface TrafficReportRow {
  subscriptionId: string;
  nodeId: string | null;
  uplinkBytes: number;
  downlinkBytes: number;
}

export interface RecordTrafficReport {
  serverId: string;
  /** Absent for legacy agents; present reports are applied at most once. */
  reportId?: string;
  /** Required with `reportId`; see {@link computeTrafficReportHash}. */
  contentHash?: string;
  windowStartedAt: Date | null;
  windowEndedAt: Date | null;
  entries: TrafficReportRow[];
}

export interface RecordTrafficResult {
  accepted: number;
  dropped: number;
  /** The report id had already been applied; nothing was written. */
  duplicate: boolean;
}

/** The report id was already used by this server for different content. */
export class TrafficReportConflictError extends Error {
  constructor() {
    super("traffic report id was already used with different content");
    this.name = "TrafficReportConflictError";
  }
}

/**
 * Stable digest of the request as the agent sent it (before attribution), used
 * to tell a genuine retry from a reused id. Entry order is irrelevant.
 */
export function computeTrafficReportHash(report: {
  windowStartedAt?: string;
  windowEndedAt?: string;
  entries: {
    subscriptionId: string;
    uplinkBytes: number;
    downlinkBytes: number;
  }[];
}): string {
  const entries = report.entries
    .map((e) => [e.subscriptionId, e.uplinkBytes, e.downlinkBytes] as const)
    .sort((a, b) =>
      a[0] === b[0]
        ? a[1] === b[1]
          ? a[2] - b[2]
          : a[1] - b[1]
        : a[0] < b[0]
          ? -1
          : 1,
    );
  return createHash("sha256")
    .update(
      JSON.stringify([
        report.windowStartedAt ?? null,
        report.windowEndedAt ?? null,
        entries,
      ]),
    )
    .digest("hex");
}

/**
 * Applies one traffic report: history rows, subscription counters and (when the
 * report has an id) the idempotency ledger row, all in ONE SQL statement.
 *
 * Why one statement: `neon-http` has no interactive transactions, so ordinary
 * sequential writes can fail half-way and a retry then double-counts what
 * already landed. A single statement with data-modifying CTEs is atomic on both
 * drivers (PostgreSQL runs it in one implicit transaction; neon-http sends it
 * as one request). The `claim` CTE inserts the ledger row with
 * `ON CONFLICT DO NOTHING`; `history` and `usage` only run when that insert
 * produced a row. Two concurrent deliveries of the same report both reach the
 * unique index; the loser blocks until the winner commits, then inserts
 * nothing, so exactly one of them writes history and counters.
 *
 * Without a `reportId` (legacy agents) the statement is still atomic, but a
 * replay after a lost response is counted again: there is nothing to
 * recognise it by.
 *
 * Unknown subscriptions are dropped (counted in `dropped`); expired or
 * cancelled ones still accrue, as before.
 */
export async function recordAgentTraffic(
  report: RecordTrafficReport,
): Promise<RecordTrafficResult> {
  const { serverId, reportId } = report;
  if (reportId !== undefined && !report.contentHash) {
    throw new Error("contentHash is required with reportId");
  }
  const rows = JSON.stringify(
    report.entries.map((e) => ({
      id: randomUUID(),
      subscription_id: e.subscriptionId,
      node_id: e.nodeId,
      uplink_bytes: e.uplinkBytes,
      downlink_bytes: e.downlinkBytes,
    })),
  );
  const windowStartedAt = report.windowStartedAt?.toISOString() ?? null;
  const windowEndedAt = report.windowEndedAt?.toISOString() ?? null;

  const claimCte =
    reportId === undefined
      ? sql``
      : sql`claim AS (
          INSERT INTO traffic_report (id, server_id, report_id, content_hash, accepted, dropped, created_at)
          SELECT ${randomUUID()}::text, ${serverId}::text, ${reportId}::text, ${report.contentHash}::text,
                 (SELECT count(*) FROM resolved)::int,
                 ((SELECT count(*) FROM incoming) - (SELECT count(*) FROM resolved))::int,
                 timezone('utc', now())
          ON CONFLICT (server_id, report_id) DO NOTHING
          RETURNING id
        ),`;
  const apply =
    reportId === undefined ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM claim)`;
  const claimedColumn =
    reportId === undefined ? sql`1` : sql`(SELECT count(*) FROM claim)::int`;

  const statement = sql`
    WITH incoming AS (
      SELECT * FROM jsonb_to_recordset(${rows}::jsonb)
        AS e(id text, subscription_id text, node_id text, uplink_bytes bigint, downlink_bytes bigint)
    ),
    resolved AS (
      SELECT i.id, i.subscription_id, s.user_id, i.node_id, i.uplink_bytes, i.downlink_bytes
      FROM incoming i JOIN subscription s ON s.id = i.subscription_id
    ),
    ${claimCte}
    history AS (
      INSERT INTO traffic_record (id, subscription_id, user_id, node_id, server_id, uplink_bytes, downlink_bytes, window_started_at, window_ended_at)
      SELECT r.id, r.subscription_id, r.user_id, r.node_id, ${serverId}::text, r.uplink_bytes, r.downlink_bytes,
             ${windowStartedAt}::timestamp, ${windowEndedAt}::timestamp
      FROM resolved r
      WHERE ${apply}
      RETURNING id
    ),
    usage AS (
      UPDATE subscription s
      SET traffic_used_bytes = s.traffic_used_bytes + t.delta::bigint,
          updated_at = timezone('utc', now())
      FROM (
        SELECT subscription_id, sum(uplink_bytes + downlink_bytes) AS delta
        FROM resolved GROUP BY subscription_id
      ) t
      WHERE s.id = t.subscription_id AND ${apply}
      RETURNING s.id
    )
    SELECT ${claimedColumn} AS claimed,
           (SELECT count(*) FROM history)::int AS accepted,
           ((SELECT count(*) FROM incoming) - (SELECT count(*) FROM resolved))::int AS dropped,
           (SELECT count(*) FROM usage)::int AS usage_rows
  `;

  // A pruned ledger row can vanish between the conflict and the lookup below;
  // one more attempt then applies the report as a fresh delivery.
  for (let attempt = 0; attempt < 2; attempt++) {
    const [outcome] = await db.execute<{
      claimed: number;
      accepted: number;
      dropped: number;
    }>(statement, "objects");
    if (!outcome) {
      throw new Error("traffic statement returned no row");
    }
    if (Number(outcome.claimed) > 0) {
      if (reportId !== undefined) {
        await pruneTrafficReports(serverId);
      }
      return {
        accepted: Number(outcome.accepted),
        dropped: Number(outcome.dropped),
        duplicate: false,
      };
    }

    const [existing] = await db
      .select()
      .from(trafficReport)
      .where(
        and(
          eq(trafficReport.serverId, serverId),
          eq(trafficReport.reportId, reportId!),
        ),
      );
    if (!existing) continue;
    if (existing.contentHash !== report.contentHash) {
      throw new TrafficReportConflictError();
    }
    return {
      accepted: existing.accepted,
      dropped: existing.dropped,
      duplicate: true,
    };
  }
  throw new Error("traffic report could not be recorded");
}

/** Best-effort retention pruning; never fails the report it piggybacks on. */
async function pruneTrafficReports(serverId: string): Promise<void> {
  const cutoff = new Date(
    Date.now() - TRAFFIC_REPORT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  try {
    await db.execute(
      sql`
      DELETE FROM traffic_report WHERE id IN (
        SELECT id FROM traffic_report
        WHERE server_id = ${serverId}::text AND created_at < ${cutoff}::timestamp
        LIMIT ${TRAFFIC_REPORT_PRUNE_BATCH}
      )
    `,
      "objects",
    );
  } catch {
    // Retention is housekeeping; the next report prunes again.
  }
}
