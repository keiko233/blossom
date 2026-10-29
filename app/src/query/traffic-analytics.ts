import { createServerFn } from "@tanstack/react-start";
import { asc, desc, eq, ilike, or, type SQL, sql } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { plan, subscription } from "@/db/plan-schema";
import { node, server } from "@/db/proxy-schema";
import { trafficRecord } from "@/db/traffic-schema";
import { ensureAdmin } from "@/lib/ensure-admin";
import { escapeLikePattern } from "@/lib/subscription-filters";
import {
  changePercent,
  getTrafficGranularity,
  previousRange,
  type TrafficBucket,
  type TrafficGranularity,
  type TrafficRange,
  zeroFillBuckets,
} from "@/lib/traffic-analytics";
import {
  trafficBreakdownToCsv,
  type TrafficBreakdownRow,
  trafficSeriesToCsv,
} from "@/lib/traffic-csv";
import { buildTrafficWhere } from "@/lib/traffic-filters";
import {
  exportTrafficCsvSchema,
  getTrafficBreakdownSchema,
  searchTrafficUsersSchema,
  TRAFFIC_EXPORT_MAX_ROWS,
  type TrafficBreakdownSort,
  type TrafficDimension,
  type TrafficFilter,
  trafficFilterSchema,
} from "@/orpc/traffic/schema";

/** TanStack Query key for everything on the admin traffic analytics page. */
export const TRAFFIC_ANALYTICS_QUERY_KEY = ["admin", "traffic"] as const;

/*
 * Time zone: every bucket is a UTC hour / day. `traffic_record.created_at` is a
 * `timestamp` (no zone) written as UTC, so `date_trunc` on it needs no
 * `AT TIME ZONE`, and `extract(epoch ...)` of the truncated value is the UTC
 * epoch of the bucket start.
 */

const uplinkSum = sql<number>`coalesce(sum(${trafficRecord.uplinkBytes}), 0)::float8`;
const downlinkSum = sql<number>`coalesce(sum(${trafficRecord.downlinkBytes}), 0)::float8`;
const totalSum = sql<number>`coalesce(sum(${trafficRecord.uplinkBytes} + ${trafficRecord.downlinkBytes}), 0)::float8`;

function toRange(filter: Pick<TrafficFilter, "from" | "to">): TrafficRange {
  return { from: Date.parse(filter.from), to: Date.parse(filter.to) };
}

function toWhere(filter: TrafficFilter, range: TrafficRange = toRange(filter)) {
  return buildTrafficWhere({
    from: new Date(range.from),
    to: new Date(range.to),
    serverId: filter.serverId,
    nodeId: filter.nodeId,
    planId: filter.planId,
    userId: filter.userId,
  });
}

async function queryBuckets(
  filter: TrafficFilter,
  range: TrafficRange,
  granularity: TrafficGranularity,
): Promise<TrafficBucket[]> {
  // Raw literal (a fixed enum value, never user text) so the SELECT and
  // GROUP BY expressions are textually identical, which Postgres requires.
  const bucket = sql`date_trunc('${sql.raw(granularity)}', ${trafficRecord.createdAt})`;
  const rows = await db
    .select({
      start: sql<number>`(extract(epoch from ${bucket}) * 1000)::float8`,
      uplink: uplinkSum,
      downlink: downlinkSum,
    })
    .from(trafficRecord)
    .where(toWhere(filter, range))
    .groupBy(bucket)
    .orderBy(bucket);
  return zeroFillBuckets(
    rows.map((row) => ({
      start: Number(row.start),
      uplink: Number(row.uplink),
      downlink: Number(row.downlink),
    })),
    range,
    granularity,
  );
}

/**
 * Zero-filled uplink / downlink per UTC bucket (hourly up to 48h, else daily),
 * aggregated in SQL.
 */
export const getTrafficSeries = createServerFn({ method: "GET" })
  .validator(trafficFilterSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const range = toRange(data);
    const granularity = getTrafficGranularity(range);
    return {
      granularity,
      buckets: await queryBuckets(data, range, granularity),
    };
  });

export type TrafficSeries = Awaited<ReturnType<typeof getTrafficSeries>>;

/**
 * Totals of the range, the same totals of the previous equal-length range,
 * and distinct users with traffic in the range: one scan of
 * `[previous.from, to)` with conditional aggregates.
 */
export const getTrafficSummary = createServerFn({ method: "GET" })
  .validator(trafficFilterSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const range = toRange(data);
    const previous = previousRange(range);
    const inRange = sql`${trafficRecord.createdAt} >= ${new Date(range.from)}`;
    const beforeRange = sql`${trafficRecord.createdAt} < ${new Date(range.from)}`;

    const [row] = await db
      .select({
        uplink: sql<number>`coalesce(sum(${trafficRecord.uplinkBytes}) filter (where ${inRange}), 0)::float8`,
        downlink: sql<number>`coalesce(sum(${trafficRecord.downlinkBytes}) filter (where ${inRange}), 0)::float8`,
        previousUplink: sql<number>`coalesce(sum(${trafficRecord.uplinkBytes}) filter (where ${beforeRange}), 0)::float8`,
        previousDownlink: sql<number>`coalesce(sum(${trafficRecord.downlinkBytes}) filter (where ${beforeRange}), 0)::float8`,
        activeUsers: sql<number>`count(distinct ${trafficRecord.userId}) filter (where ${inRange})::int`,
      })
      .from(trafficRecord)
      .where(toWhere(data, { from: previous.from, to: range.to }));

    const uplink = Number(row?.uplink ?? 0);
    const downlink = Number(row?.downlink ?? 0);
    const previousUplink = Number(row?.previousUplink ?? 0);
    const previousDownlink = Number(row?.previousDownlink ?? 0);
    const total = uplink + downlink;
    const previousTotal = previousUplink + previousDownlink;
    return {
      current: {
        uplink,
        downlink,
        total,
        activeUsers: Number(row?.activeUsers ?? 0),
      },
      previous: {
        uplink: previousUplink,
        downlink: previousDownlink,
        total: previousTotal,
      },
      /** Null when the previous period had no traffic. */
      changePercent: changePercent(total, previousTotal),
    };
  });

export type TrafficSummary = Awaited<ReturnType<typeof getTrafficSummary>>;

interface BreakdownQueryRow extends TrafficBreakdownRow {
  grandTotal: number;
  groupCount: number;
}

/**
 * One row per dimension entity, aggregated and ordered in SQL. `grandTotal`
 * (all groups, not just the page) and `groupCount` come from window
 * functions over the grouped result, so shares and page counts need no extra
 * query. Server / node rows with a null id are usage whose entity was deleted.
 */
async function queryBreakdown(
  dimension: TrafficDimension,
  filter: TrafficFilter,
  order: { sort: TrafficBreakdownSort; dir: "asc" | "desc" },
  limit: number,
  offset: number,
): Promise<BreakdownQueryRow[]> {
  const where = toWhere(filter);
  const columns = {
    uplink: uplinkSum,
    downlink: downlinkSum,
    total: totalSum,
    grandTotal: sql<number>`coalesce(sum(sum(${trafficRecord.uplinkBytes} + ${trafficRecord.downlinkBytes})) over (), 0)::float8`,
    groupCount: sql<number>`(count(*) over ())::int`,
  };
  const orderBy = (id: SQL<unknown>, name: SQL<unknown>) => {
    const direction = order.dir === "asc" ? asc : desc;
    const primary =
      order.sort === "uplink"
        ? uplinkSum
        : order.sort === "downlink"
          ? downlinkSum
          : order.sort === "name"
            ? sql`lower(coalesce(${name}, ''))`
            : totalSum;
    return [direction(primary), asc(id)];
  };

  let rows: {
    id: string | null;
    name: string | null;
    email: string | null;
    uplink: number;
    downlink: number;
    total: number;
    grandTotal: number;
    groupCount: number;
  }[];

  switch (dimension) {
    case "user":
      rows = await db
        .select({
          id: trafficRecord.userId,
          name: user.name,
          email: user.email,
          ...columns,
        })
        .from(trafficRecord)
        .innerJoin(user, eq(user.id, trafficRecord.userId))
        .where(where)
        .groupBy(trafficRecord.userId, user.name, user.email)
        .orderBy(...orderBy(sql`${trafficRecord.userId}`, sql`${user.name}`))
        .limit(limit)
        .offset(offset);
      break;
    case "server":
      rows = (
        await db
          .select({
            id: trafficRecord.serverId,
            name: server.name,
            ...columns,
          })
          .from(trafficRecord)
          .leftJoin(server, eq(server.id, trafficRecord.serverId))
          .where(where)
          .groupBy(trafficRecord.serverId, server.name)
          .orderBy(
            ...orderBy(sql`${trafficRecord.serverId}`, sql`${server.name}`),
          )
          .limit(limit)
          .offset(offset)
      ).map((row) => ({ ...row, email: null }));
      break;
    case "node":
      rows = (
        await db
          .select({
            id: trafficRecord.nodeId,
            name: node.name,
            ...columns,
          })
          .from(trafficRecord)
          .leftJoin(node, eq(node.id, trafficRecord.nodeId))
          .where(where)
          .groupBy(trafficRecord.nodeId, node.name)
          .orderBy(...orderBy(sql`${trafficRecord.nodeId}`, sql`${node.name}`))
          .limit(limit)
          .offset(offset)
      ).map((row) => ({ ...row, email: null }));
      break;
    case "plan":
      rows = (
        await db
          .select({
            id: subscription.planId,
            name: plan.name,
            ...columns,
          })
          .from(trafficRecord)
          .innerJoin(
            subscription,
            eq(subscription.id, trafficRecord.subscriptionId),
          )
          .innerJoin(plan, eq(plan.id, subscription.planId))
          .where(where)
          .groupBy(subscription.planId, plan.name)
          .orderBy(...orderBy(sql`${subscription.planId}`, sql`${plan.name}`))
          .limit(limit)
          .offset(offset)
      ).map((row) => ({ ...row, email: null }));
      break;
  }

  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    uplink: Number(row.uplink),
    downlink: Number(row.downlink),
    total: Number(row.total),
    grandTotal: Number(row.grandTotal),
    groupCount: Number(row.groupCount),
  }));
}

/**
 * One page of the by-user / server / node / plan breakdown of the range,
 * sorted and paginated in SQL. `grandTotal` is the range total across every
 * group (the denominator of the shares) and `total` the group count.
 */
export const getTrafficBreakdown = createServerFn({ method: "GET" })
  .validator(getTrafficBreakdownSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { dimension, sort, sortDir, page, pageSize, ...filter } = data;
    const rows = await queryBreakdown(
      dimension,
      filter,
      { sort, dir: sortDir },
      pageSize,
      (page - 1) * pageSize,
    );
    return {
      rows: rows.map(({ grandTotal: _g, groupCount: _c, ...row }) => row),
      total: rows[0]?.groupCount ?? 0,
      grandTotal: rows[0]?.grandTotal ?? 0,
    };
  });

export type TrafficBreakdown = Awaited<ReturnType<typeof getTrafficBreakdown>>;

/**
 * CSV of the time series or of a whole breakdown (not just one page), capped
 * at TRAFFIC_EXPORT_MAX_ROWS rows; `truncated` tells the caller the cap hit.
 * Breakdowns are ordered by total descending.
 */
export const exportTrafficCsv = createServerFn({ method: "GET" })
  .validator(exportTrafficCsvSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const { kind, ...filter } = data;

    if (kind === "series") {
      const range = toRange(filter);
      const buckets = await queryBuckets(
        filter,
        range,
        getTrafficGranularity(range),
      );
      return {
        csv: trafficSeriesToCsv(buckets),
        count: buckets.length,
        truncated: false,
      };
    }

    const rows = await queryBreakdown(
      kind,
      filter,
      { sort: "total", dir: "desc" },
      TRAFFIC_EXPORT_MAX_ROWS + 1,
      0,
    );
    const truncated = rows.length > TRAFFIC_EXPORT_MAX_ROWS;
    const exported = truncated ? rows.slice(0, TRAFFIC_EXPORT_MAX_ROWS) : rows;
    return {
      csv: trafficBreakdownToCsv(kind, exported, rows[0]?.grandTotal ?? 0),
      count: exported.length,
      truncated,
    };
  });

/** Servers, nodes and plans to filter by (names only, no config). */
export const getTrafficFilterOptions = createServerFn({
  method: "GET",
}).handler(async () => {
  await ensureAdmin();
  const [servers, nodes, plans] = await Promise.all([
    db
      .select({ id: server.id, name: server.name })
      .from(server)
      .orderBy(asc(server.name)),
    db
      .select({ id: node.id, name: node.name, serverId: node.serverId })
      .from(node)
      .orderBy(asc(node.name)),
    db
      .select({ id: plan.id, name: plan.name })
      .from(plan)
      .orderBy(asc(plan.sortOrder), asc(plan.name)),
  ]);
  return { servers, nodes, plans };
});

export type TrafficFilterOptions = Awaited<
  ReturnType<typeof getTrafficFilterOptions>
>;

const USER_SEARCH_LIMIT = 8;

/** Users matching a name / email substring (or an exact id), for the filter. */
export const searchTrafficUsers = createServerFn({ method: "GET" })
  .validator(searchTrafficUsersSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const q = data.q?.trim();
    if (!q) return [];
    const pattern = `%${escapeLikePattern(q)}%`;
    return db
      .select({ id: user.id, name: user.name, email: user.email })
      .from(user)
      .where(
        or(
          eq(user.id, q),
          ilike(user.name, pattern),
          ilike(user.email, pattern),
        ),
      )
      .orderBy(asc(user.name))
      .limit(USER_SEARCH_LIMIT);
  });

export type TrafficUserOption = Awaited<
  ReturnType<typeof searchTrafficUsers>
>[number];
