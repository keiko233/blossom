import {
  LOG_POLICY_DEFAULT_TEMPORARY_SECONDS,
  LOG_POLICY_MAX_TEMPORARY_SECONDS,
  LOG_POLICY_SOURCES,
  type LogPolicyAckPayload,
  type LogPolicyDesiredSource,
  type LogPolicyLevel,
  type LogPolicySource,
  isLogPolicyTemporaryLevel,
  logPolicyLevelSchema,
  logPolicySourceSchema,
} from "@blossom/contracts/log-policy";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { type Database, db } from "@/db";

type DbHandle = Database;

export const serverLogPolicySourceSchema = logPolicySourceSchema;
export const serverLogPolicyReadSchema = z.object({
  serverId: z.string().min(1),
});
export const serverLogPolicyWriteSchema = z
  .object({
    serverId: z.string().min(1),
    source: logPolicySourceSchema,
    level: logPolicyLevelSchema,
    temporarySeconds: z.number().int().min(30).max(3_600).optional(),
    expectedRevision: z.number().int().min(0),
  })
  .superRefine((value, context) => {
    if (
      !isLogPolicyTemporaryLevel(value.level) &&
      value.temporarySeconds !== undefined
    ) {
      context.addIssue({
        code: "custom",
        message: "only debug and trace accept a temporary duration",
        path: ["temporarySeconds"],
      });
    }
  });
export const serverLogPolicyResetSchema = z.object({
  serverId: z.string().min(1),
  source: logPolicySourceSchema,
  expectedRevision: z.number().int().min(0),
});

export type ServerLogPolicyWriteInput = z.infer<
  typeof serverLogPolicyWriteSchema
>;
export type ServerLogPolicyResetInput = z.infer<
  typeof serverLogPolicyResetSchema
>;

export interface ServerLogPolicySourceView {
  source: LogPolicySource;
  /** Whether a durable row exists; absent rows are the implicit default. */
  present: boolean;
  desiredRevision: number;
  desiredLevel: LogPolicyLevel;
  desiredDeadline: Date | null;
  /** True when a temporary override's deadline has passed. */
  expired: boolean;
  /** `default` means "restore the agent's generated or local baseline". */
  targetLevel: LogPolicyLevel;
  effectiveRevision: number | null;
  effectiveLevel: LogPolicyLevel | null;
  effectiveBaseline: LogPolicyLevel | null;
  effectiveDeadline: Date | null;
  effectiveError: string | null;
  effectivePending: boolean;
  effectiveAt: Date | null;
  /** The agent has not acknowledged the current desired revision yet. */
  pending: boolean;
}

export interface ServerLogPolicyView {
  serverId: string;
  /** Server-wide monotonic revision used for compare-and-swap and welcome. */
  revision: number;
  sources: Record<LogPolicySource, ServerLogPolicySourceView>;
}

export type ServerLogPolicyMutationResult =
  | {
      ok: true;
      policy: ServerLogPolicyView;
      previous: ServerLogPolicySourceView;
      next: ServerLogPolicySourceView;
    }
  | {
      ok: false;
      reason: "conflict";
      policy: ServerLogPolicyView | null;
    };

export type AgentLogPolicySnapshot = {
  revision: number;
  sources: LogPolicyDesiredSource[];
};

export type LogPolicyAckOutcome = "recorded" | "stale" | "replaced";

interface PolicyRow {
  [key: string]: unknown;
  source: string | null;
  desired_revision: number | string | null;
  desired_level: string | null;
  desired_deadline: Date | string | null;
  effective_revision: number | string | null;
  effective_level: string | null;
  effective_baseline: string | null;
  effective_deadline: Date | string | null;
  effective_error: string | null;
  effective_pending: boolean | null;
  effective_at: Date | string | null;
}

interface PolicyReadRow extends PolicyRow {
  revision: number | string;
}

function toNumber(value: number | string | null | undefined, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value : new Date(value);
}

function toLevel(
  value: string | null | undefined,
  fallback: LogPolicyLevel = "default",
): LogPolicyLevel {
  switch (value) {
    case "default":
    case "error":
    case "warn":
    case "info":
    case "debug":
    case "trace":
      return value;
    default:
      return fallback;
  }
}

function toSource(value: string | null): LogPolicySource | null {
  return value === "agent" || value === "sing-box" ? value : null;
}

function normalizeDesired(
  level: LogPolicyLevel,
  deadline: Date | null,
  now: Date,
): { level: LogPolicyLevel; deadline: Date | null; expired: boolean } {
  if (
    isLogPolicyTemporaryLevel(level) &&
    deadline !== null &&
    deadline.getTime() <= now.getTime()
  ) {
    return { level: "default", deadline: null, expired: true };
  }
  return { level, deadline, expired: false };
}

/**
 * Clamps a temporary override into the bounded range the Rust agent also
 * enforces. A baseline level never gets a deadline.
 */
export function resolveLogPolicyDeadline(
  level: LogPolicyLevel,
  temporarySeconds: number | undefined,
  now: Date = new Date(),
): Date | null {
  if (!isLogPolicyTemporaryLevel(level)) {
    return null;
  }
  const seconds = Math.min(
    LOG_POLICY_MAX_TEMPORARY_SECONDS,
    Math.max(
      30,
      Math.floor(temporarySeconds ?? LOG_POLICY_DEFAULT_TEMPORARY_SECONDS),
    ),
  );
  return new Date(now.getTime() + seconds * 1_000);
}

function emptySourceView(source: LogPolicySource): ServerLogPolicySourceView {
  return {
    source,
    present: false,
    desiredRevision: 0,
    desiredLevel: "default",
    desiredDeadline: null,
    expired: false,
    targetLevel: "default",
    effectiveRevision: null,
    effectiveLevel: null,
    effectiveBaseline: null,
    effectiveDeadline: null,
    effectiveError: null,
    effectivePending: false,
    effectiveAt: null,
    pending: false,
  };
}

function sourceView(
  row: PolicyRow,
  source: LogPolicySource,
  now: Date,
): ServerLogPolicySourceView {
  const desiredLevel = toLevel(row.desired_level);
  const rawDeadline = toDate(row.desired_deadline);
  const normalized = normalizeDesired(desiredLevel, rawDeadline, now);
  const desiredRevision = toNumber(row.desired_revision);
  const effectiveRevision =
    row.effective_revision === null ? null : toNumber(row.effective_revision);
  const effectiveLevel =
    row.effective_level === null ? null : toLevel(row.effective_level);
  const effectiveBaseline =
    row.effective_baseline === null ? null : toLevel(row.effective_baseline);
  const targetLevel =
    normalized.level === "default"
      ? (effectiveBaseline ?? "default")
      : normalized.level;
  const pending =
    desiredRevision > 0 &&
    (effectiveRevision !== desiredRevision || targetLevel !== effectiveLevel);
  return {
    source,
    present: true,
    desiredRevision,
    desiredLevel,
    desiredDeadline: rawDeadline,
    expired: normalized.expired,
    targetLevel: normalized.level,
    effectiveRevision,
    effectiveLevel,
    effectiveBaseline,
    effectiveDeadline: toDate(row.effective_deadline),
    effectiveError: row.effective_error,
    effectivePending: row.effective_pending ?? false,
    effectiveAt: toDate(row.effective_at),
    pending,
  };
}

function viewFromRows(
  serverId: string,
  revision: number,
  rows: PolicyRow[],
  now: Date,
): ServerLogPolicyView {
  const sources = {
    agent: emptySourceView("agent"),
    "sing-box": emptySourceView("sing-box"),
  } satisfies Record<LogPolicySource, ServerLogPolicySourceView>;
  for (const row of rows) {
    const source = toSource(row.source);
    if (source) {
      sources[source] = sourceView(row, source, now);
    }
  }
  return { serverId, revision, sources };
}

function selectPolicySql(serverId: string, sessionId?: string) {
  return sql`
    SELECT s.log_policy_revision AS revision,
           p.source,
           p.desired_revision,
           p.desired_level,
           p.desired_deadline,
           p.effective_revision,
           p.effective_level,
           p.effective_baseline,
           p.effective_deadline,
           p.effective_error,
           p.effective_pending,
           p.effective_at
      FROM server s
      LEFT JOIN server_log_policy p ON p.server_id = s.id
     WHERE s.id = ${serverId}
       ${sessionId === undefined ? sql`` : sql`AND s.ws_session_id = ${sessionId}`}
  `;
}

async function readPolicyRows(
  serverId: string,
  database: DbHandle,
  sessionId?: string,
): Promise<PolicyReadRow[]> {
  const rows = await database.execute<PolicyReadRow>(
    selectPolicySql(serverId, sessionId),
    "objects",
  );
  return Array.isArray(rows) ? rows : [];
}

/** Reads the current desired/effective policy for an admin view. */
export async function readServerLogPolicy(
  serverId: string,
  database: DbHandle = db,
): Promise<ServerLogPolicyView | null> {
  const rows = await readPolicyRows(serverId, database);
  if (rows.length === 0) {
    return null;
  }
  return viewFromRows(serverId, toNumber(rows[0]!.revision), rows, new Date());
}

/**
 * Reads the policy only while the v2 session is still current. The server row
 * and its sources come from one statement, so a concurrent write cannot pair a
 * new server revision with stale source rows.
 */
export async function loadAgentLogPolicySnapshot(
  serverId: string,
  sessionId: string,
  database: DbHandle = db,
  now: Date = new Date(),
): Promise<AgentLogPolicySnapshot | null> {
  const rows = await readPolicyRows(serverId, database, sessionId);
  if (rows.length === 0) {
    return null;
  }
  const view = viewFromRows(serverId, toNumber(rows[0]!.revision), rows, now);
  return {
    revision: view.revision,
    sources: LOG_POLICY_SOURCES.map((source) => {
      const entry = view.sources[source];
      return {
        source,
        revision: entry.desiredRevision,
        level: entry.targetLevel,
        deadline:
          entry.targetLevel === "default"
            ? null
            : (entry.desiredDeadline?.toISOString() ?? null),
      };
    }),
  };
}

/**
 * Increments the server-wide revision only when `expectedRevision` is still
 * current, then writes the source's desired row in the same statement. This is
 * the compare-and-swap that makes concurrent admin edits conflict instead of
 * silently overwriting each other.
 */
export async function writeServerLogPolicy(
  input: {
    serverId: string;
    source: LogPolicySource;
    level: LogPolicyLevel;
    deadline: Date | null;
    actorId: string | null;
    expectedRevision: number;
  },
  database: DbHandle = db,
): Promise<{ revision: number } | null> {
  const rows = await database.execute<{ revision: number | string }>(
    sql`
      WITH bumped AS (
        UPDATE server
           SET log_policy_revision = log_policy_revision + 1,
               updated_at = now()
         WHERE id = ${input.serverId}
           AND log_policy_revision = ${input.expectedRevision}
        RETURNING log_policy_revision
      )
      INSERT INTO server_log_policy (
        server_id, source, desired_revision, desired_level, desired_deadline,
        desired_updated_at, desired_updated_by, updated_at
      )
      SELECT ${input.serverId}, ${input.source}, bumped.log_policy_revision,
             ${input.level}, ${input.deadline}, now(), ${input.actorId}, now()
        FROM bumped
      ON CONFLICT (server_id, source) DO UPDATE SET
        desired_revision = EXCLUDED.desired_revision,
        desired_level = EXCLUDED.desired_level,
        desired_deadline = EXCLUDED.desired_deadline,
        desired_updated_at = now(),
        desired_updated_by = EXCLUDED.desired_updated_by,
        updated_at = now()
      RETURNING desired_revision AS revision
    `,
    "objects",
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row ? { revision: toNumber(row.revision) } : null;
}

function boundLogPolicyError(message: string): string {
  return [...message]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (
        code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)
      );
    })
    .join("")
    .slice(0, 512);
}

/**
 * Records one source acknowledgement only while the v2 session is current and
 * the acknowledged source revision is still the desired one. A late ack from a
 * replaced connection, or one for a superseded revision, changes nothing.
 */
export async function recordAgentLogPolicyAck(
  serverId: string,
  sessionId: string,
  ack: LogPolicyAckPayload,
  database: DbHandle = db,
): Promise<LogPolicyAckOutcome> {
  const error =
    ack.error === null
      ? null
      : boundLogPolicyError(ack.error) || "log policy apply failed";
  const rows = await database.execute<{
    fenced: number | string;
    recorded: number | string;
  }>(
    sql`
      WITH fenced AS (
        SELECT 1 FROM server
         WHERE id = ${serverId} AND ws_session_id = ${sessionId}
      ),
      updated AS (
        UPDATE server_log_policy
           SET effective_revision = ${ack.sourceRevision},
               effective_level = ${ack.effective},
               effective_baseline = ${ack.baseline},
               effective_deadline = ${ack.deadline},
               effective_error = ${error},
               effective_pending = ${ack.pending},
               effective_at = now(),
               updated_at = now()
         WHERE server_id = ${serverId}
           AND source = ${ack.source}
           AND desired_revision = ${ack.sourceRevision}
           AND EXISTS (SELECT 1 FROM fenced)
        RETURNING 1
      ),
      inserted AS (
        INSERT INTO server_log_policy (
          server_id, source, desired_revision, desired_level, desired_deadline,
          desired_updated_at, desired_updated_by,
          effective_revision, effective_level, effective_baseline,
          effective_deadline, effective_error, effective_pending,
          effective_at, updated_at
        )
        SELECT ${serverId}, ${ack.source}, 0, 'default', NULL,
               now(), NULL, ${ack.sourceRevision}, ${ack.effective},
               ${ack.baseline}, ${ack.deadline}, ${error}, ${ack.pending},
               now(), now()
         WHERE ${ack.sourceRevision} = 0
           AND NOT EXISTS (
             SELECT 1 FROM server_log_policy
              WHERE server_id = ${serverId} AND source = ${ack.source}
           )
           AND EXISTS (SELECT 1 FROM fenced)
        ON CONFLICT (server_id, source) DO UPDATE SET
          effective_revision = EXCLUDED.effective_revision,
          effective_level = EXCLUDED.effective_level,
          effective_baseline = EXCLUDED.effective_baseline,
          effective_deadline = EXCLUDED.effective_deadline,
          effective_error = EXCLUDED.effective_error,
          effective_pending = EXCLUDED.effective_pending,
          effective_at = now(),
          updated_at = now()
        WHERE server_log_policy.desired_revision = 0
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM fenced)::int AS fenced,
             ((SELECT count(*) FROM updated) + (SELECT count(*) FROM inserted))::int AS recorded
    `,
    "objects",
  );
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || toNumber(row.fenced) === 0) {
    return "replaced";
  }
  return toNumber(row.recorded) > 0 ? "recorded" : "stale";
}
