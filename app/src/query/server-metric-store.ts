import { eq, type SQL, sql } from "drizzle-orm";

import { type Database, db } from "@/db";
import { serverMetricMinute } from "@/db/server-metric-schema";
import {
  fillMetricGrid,
  type MetricHistoryRow,
  metricMinuteStart,
  normalizeMetricSample,
  planMetricHistory,
  SERVER_METRIC_RETENTION_DAYS,
  type ServerMetricRange,
  type ServerMetricSample,
} from "@/lib/server-metric-history";

/*
 * Server-only storage for host metric history. Imported by server functions
 * and the agent WebSocket ingress, never by browser code: keep it out of
 * `createServerFn` modules that client bundles import.
 */

type DbHandle = Database;

/**
 * Runs one raw statement and returns its rows. The two drivers share the
 * `rows` result shape, but their typed `execute` overloads do not unify.
 */
async function executeRows<T>(database: DbHandle, query: SQL): Promise<T[]> {
  const executor = database as unknown as {
    execute: (statement: SQL) => Promise<{ rows: unknown[] }>;
  };
  const result = await executor.execute(query);
  return result.rows as T[];
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRY_BATCH_SIZE = 1000;

/*
 * Ingestion contract for the WebSocket telemetry branch.
 *
 * `recordServerMetricMinute` is the only write path for `server_metric_minute`.
 * The agent WebSocket handler calls it for each accepted telemetry sample on
 * the session it authenticated. Browser requests never call it, and no agent
 * polling is added for it. The caller passes:
 *
 * - `connectedAt`: the `server.wsConnectedAt` of that session. It is the
 *   fence: a write from a replaced or closed socket matches no server row and
 *   returns "fenced". The v2 integration branch replaces the predicate in
 *   `sessionFence` with its session ID; nothing else here changes.
 * - `receivedAt`: the control plane's receipt time. It selects the UTC minute
 *   and orders samples that land in the same minute.
 * - `sample`: the agent measurements. Pass `network: null` until the agent
 *   reports counter-derived rates.
 */
export interface RecordServerMetricInput {
  serverId: string;
  connectedAt: Date;
  receivedAt: Date;
  sample: ServerMetricSample;
}

/**
 * "written": the minute now holds this sample.
 * "superseded": a sample received at or after this one already holds the minute.
 * "fenced": the server is disabled or the session is no longer current.
 * "invalid": no usable measurement remains after normalization.
 */
export type RecordServerMetricResult =
  | "written"
  | "superseded"
  | "fenced"
  | "invalid";

function sessionFence(serverId: string, connectedAt: Date) {
  return sql`
    select s.id from server s
    where s.id = ${serverId}
      and s.enabled = true
      and s.ws_connected_at = ${connectedAt.toISOString()}::timestamp
  `;
}

/**
 * Writes one minute bucket. The session fence and the conditional upsert run
 * in one statement, so a replaced socket cannot overwrite a newer sample. A
 * same-minute row is replaced only by a strictly newer receipt. Afterwards one
 * bounded batch of expired rows is removed.
 */
export async function recordServerMetricMinute(
  input: RecordServerMetricInput,
  database: DbHandle = db,
): Promise<RecordServerMetricResult> {
  const stored = normalizeMetricSample(input.sample);
  if (!stored) return "invalid";

  const minute = new Date(
    metricMinuteStart(input.receivedAt.getTime()),
  ).toISOString();
  const rows = await executeRows<{ fenced: number; written: number }>(
    database,
    sql`
    with fenced as (${sessionFence(input.serverId, input.connectedAt)}),
    written as (
      insert into server_metric_minute (
        server_id, minute, scope, scope_key, cpu_percent,
        memory_used_bytes, memory_total_bytes, disk_used_bytes, disk_total_bytes,
        network_tx_bytes_per_second, network_rx_bytes_per_second, received_at
      )
      select
        fenced.id, ${minute}::timestamp, ${stored.scope}::text,
        ${stored.scopeKey}::text, ${stored.cpuPercent}::float8,
        ${stored.memoryUsedBytes}::bigint, ${stored.memoryTotalBytes}::bigint,
        ${stored.diskUsedBytes}::bigint, ${stored.diskTotalBytes}::bigint,
        ${stored.networkTxBytesPerSecond}::float8,
        ${stored.networkRxBytesPerSecond}::float8,
        ${input.receivedAt.toISOString()}::timestamp
      from fenced
      on conflict (server_id, minute) do update set
        scope = excluded.scope,
        scope_key = excluded.scope_key,
        cpu_percent = excluded.cpu_percent,
        memory_used_bytes = excluded.memory_used_bytes,
        memory_total_bytes = excluded.memory_total_bytes,
        disk_used_bytes = excluded.disk_used_bytes,
        disk_total_bytes = excluded.disk_total_bytes,
        network_tx_bytes_per_second = excluded.network_tx_bytes_per_second,
        network_rx_bytes_per_second = excluded.network_rx_bytes_per_second,
        received_at = excluded.received_at
      where server_metric_minute.received_at < excluded.received_at
      returning 1
    )
    select
      (select count(*)::int from fenced) as fenced,
      (select count(*)::int from written) as written
  `,
  );
  const outcome = rows[0];

  await pruneServerMetricHistory({ now: input.receivedAt.getTime() }, database);

  if (!outcome || Number(outcome.fenced) === 0) return "fenced";
  return Number(outcome.written) === 0 ? "superseded" : "written";
}

/**
 * Deletes history older than the retention window, oldest minutes first, in at
 * most `maxBatches` batches of `batchSize` rows. The minute index serves the
 * scan, and the bound caps the work and locks of one call. Returns the number
 * of rows removed.
 */
export async function pruneServerMetricHistory(
  options: { now: number; batchSize?: number; maxBatches?: number },
  database: DbHandle = db,
): Promise<number> {
  const batchSize = options.batchSize ?? EXPIRY_BATCH_SIZE;
  const maxBatches = options.maxBatches ?? 1;
  const cutoff = new Date(
    options.now - SERVER_METRIC_RETENTION_DAYS * MS_PER_DAY,
  ).toISOString();

  let removed = 0;
  for (let batch = 0; batch < maxBatches; batch += 1) {
    const rows = await executeRows<{ n: number }>(
      database,
      sql`
      with expired as (
        select server_id, minute from server_metric_minute
        where minute < ${cutoff}::timestamp
        order by minute
        limit ${batchSize}::int
      ),
      deleted as (
        delete from server_metric_minute m
        using expired e
        where m.server_id = e.server_id and m.minute = e.minute
        returning 1
      )
      select count(*)::int as n from deleted
    `,
    );
    const count = Number(rows[0]?.n ?? 0);
    removed += count;
    if (count < batchSize) break;
  }
  return removed;
}

/**
 * Host history of one server over a preset range, read through the bounded
 * plan: at most 600 buckets, aggregated in SQL. Each bucket averages the valid
 * samples of the scope that was most recent in it, so a scope change never
 * mixes denominators. Empty buckets are returned as gap points.
 */
export async function loadServerMetricHistory(
  serverId: string,
  range: ServerMetricRange,
  nowMs: number = Date.now(),
  database: DbHandle = db,
) {
  const plan = planMetricHistory(range, nowMs);
  const bucketSeconds = plan.bucketMs / 1000;
  const from = new Date(plan.fromMs).toISOString();
  const to = new Date(plan.toMs).toISOString();

  const rows = await executeRows<Record<string, unknown>>(
    database,
    sql`
    with bucketed as (
      select
        (floor(extract(epoch from minute) / ${bucketSeconds}::int)
          * ${bucketSeconds}::int * 1000)::float8 as start_ms,
        minute, scope, scope_key, cpu_percent,
        network_tx_bytes_per_second as tx,
        network_rx_bytes_per_second as rx,
        case when memory_total_bytes > 0
          then 100.0 * memory_used_bytes / memory_total_bytes end as memory_percent,
        case when disk_total_bytes > 0
          then 100.0 * disk_used_bytes / disk_total_bytes end as disk_percent
      from server_metric_minute
      where server_id = ${serverId}
        and minute >= ${from}::timestamp
        and minute < ${to}::timestamp
    ),
    per_scope as (
      select
        start_ms, scope_key, max(scope) as scope, max(minute) as last_minute,
        count(*)::int as samples,
        avg(cpu_percent)::float8 as cpu_percent,
        avg(memory_percent)::float8 as memory_percent,
        avg(disk_percent)::float8 as disk_percent,
        avg(tx)::float8 as tx,
        avg(rx)::float8 as rx
      from bucketed
      group by start_ms, scope_key
    ),
    chosen as (
      select distinct on (start_ms) *
      from per_scope
      order by start_ms, last_minute desc, scope_key
    )
    select start_ms, scope, scope_key, samples, cpu_percent, memory_percent,
      disk_percent, tx, rx
    from chosen
    order by start_ms
  `,
  );

  // Earliest retained minute, so the UI can tell "not collected yet" from a
  // gap inside the window. The primary key serves this lookup.
  const [earliest] = await database
    .select({
      since: sql<
        number | null
      >`(extract(epoch from min(${serverMetricMinute.minute})) * 1000)::float8`,
    })
    .from(serverMetricMinute)
    .where(eq(serverMetricMinute.serverId, serverId));

  const sparse = rows.map((record): MetricHistoryRow => {
    return {
      startMs: Number(record.start_ms),
      samples: Number(record.samples),
      scope: record.scope === "container" ? "container" : "host",
      scopeKey: String(record.scope_key),
      cpuPercent: nullableNumber(record.cpu_percent),
      memoryPercent: nullableNumber(record.memory_percent),
      diskPercent: nullableNumber(record.disk_percent),
      networkTxBytesPerSecond: nullableNumber(record.tx),
      networkRxBytesPerSecond: nullableNumber(record.rx),
    };
  });

  return {
    range,
    bucketSeconds,
    historySinceMs: nullableNumber(earliest?.since),
    points: fillMetricGrid(plan, sparse),
  };
}

export type ServerMetricHistory = Awaited<
  ReturnType<typeof loadServerMetricHistory>
>;

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
