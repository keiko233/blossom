/**
 * Fenced ingestion, expiry and downsampled reads of `server_metric_minute`
 * against a real PostgreSQL.
 *
 * Skipped unless `BLOSSOM_TEST_DATABASE_URL` points at a DISPOSABLE database
 * with the migrations applied. This suite deletes rows from the server and
 * metric tables. Its database name must begin with `blossom_test`, and
 * `BLOSSOM_TEST_CONFIRM_DISPOSABLE` must be `yes`. The neon-http driver runs as
 * well when `BLOSSOM_TEST_NEON_HTTP_URL` and `BLOSSOM_TEST_NEON_HTTP_ENDPOINT`
 * are set (a Neon HTTP proxy in front of the same database); see
 * docs/development/testing.md.
 */
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const pgUrl = process.env.BLOSSOM_TEST_DATABASE_URL;
const neonUrl = process.env.BLOSSOM_TEST_NEON_HTTP_URL;
const neonEndpoint = process.env.BLOSSOM_TEST_NEON_HTTP_ENDPOINT;

if (pgUrl || neonUrl || neonEndpoint) {
  if (process.env.BLOSSOM_TEST_CONFIRM_DISPOSABLE !== "yes") {
    throw new Error(
      "Metric history integration tests require explicit disposable database confirmation",
    );
  }
  for (const url of [pgUrl, neonUrl]) {
    if (
      url &&
      !decodeURIComponent(new URL(url).pathname.slice(1)).startsWith(
        "blossom_test",
      )
    ) {
      throw new Error(
        "Metric history integration tests require a database named blossom_test*",
      );
    }
  }
}

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import {
  planMetricHistory,
  type ServerMetricSample,
  splitMetricSegments,
} from "@/lib/server-metric-history";

import {
  loadServerMetricHistory,
  pruneServerMetricHistory,
  recordServerMetricMinute,
  type RecordServerMetricInput,
} from "./server-metric-store";

type Driver = "node-postgres" | "neon-http";
const drivers: Driver[] = ["node-postgres"];
if (pgUrl && neonUrl && neonEndpoint) drivers.push("neon-http");

const admin = new pg.Pool({ connectionString: pgUrl, max: 4 });

const NOW = Date.UTC(2026, 10, 19, 12, 0, 0);
const MINUTE = 60_000;
const SESSION = new Date("2026-11-19T11:00:00.000Z");

async function useDriver(driver: Driver) {
  if (driver === "node-postgres") {
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.Pool({ connectionString: pgUrl, max: 16 });
    hoisted.db = drizzle({ client: pool });
    return () => pool.end();
  }
  const { neon, neonConfig } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  neonConfig.fetchEndpoint = () => neonEndpoint!;
  hoisted.db = drizzle({ client: neon(neonUrl!) });
  return async () => {};
}

function sample(
  overrides: Partial<ServerMetricSample> = {},
): ServerMetricSample {
  return {
    cpuPercent: 20,
    memory: { used: 512, total: 1024 },
    disk: { used: 100, total: 1000 },
    environment: "systemd",
    cgroupVersion: null,
    cpuLimit: null,
    memoryLimit: null,
    network: null,
    ...overrides,
  };
}

function write(
  overrides: Partial<RecordServerMetricInput> & { cpu?: number | null } = {},
  database: unknown,
) {
  const { cpu, ...rest } = overrides;
  return recordServerMetricMinute(
    {
      serverId: "srv1",
      connectedAt: SESSION,
      receivedAt: new Date(NOW),
      sample: sample(cpu === undefined ? {} : { cpuPercent: cpu }),
      ...rest,
    },
    database as Parameters<typeof recordServerMetricMinute>[1],
  );
}

async function metricRows(serverId = "srv1") {
  const { rows } = await admin.query(
    `select (extract(epoch from minute) * 1000)::float8 as minute_ms,
            (extract(epoch from received_at) * 1000)::float8 as received_ms,
            scope, scope_key, cpu_percent
       from server_metric_minute where server_id = $1 order by minute`,
    [serverId],
  );
  return rows;
}

async function resetServers() {
  await admin.query(`delete from server_metric_minute; delete from server;`);
  for (const [id, enabled] of [
    ["srv1", true],
    ["srv2", true],
    ["disabled", false],
  ] as const) {
    await admin.query(
      `insert into server(id,name,address,agent_token_hash,agent_token_prefix,enabled,ws_connected_at)
       values ($1,$1,'192.0.2.1',$1||'-hash',$1||'-pre',$2,$3)`,
      [id, enabled, SESSION.toISOString()],
    );
  }
}

describe.skipIf(!pgUrl).each(drivers)(
  "server metric history on %s",
  (driver) => {
    let close: () => Promise<unknown>;
    let database: unknown;
    beforeAll(async () => {
      close = await useDriver(driver);
      database = hoisted.db;
    });
    afterAll(async () => {
      await close();
      if (driver === drivers[drivers.length - 1]) await admin.end();
    });
    beforeEach(resetServers);

    describe("recordServerMetricMinute", () => {
      it("writes one minute for the current session", async () => {
        await expect(
          write({ receivedAt: new Date(NOW + 20_000) }, database),
        ).resolves.toBe("written");

        const rows = await metricRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          scope: "host",
          scope_key: "systemd|-|-|-",
          cpu_percent: 20,
        });
        // The minute is truncated, the receipt time is kept as received.
        expect(rows[0].minute_ms).toBe(NOW);
        expect(rows[0].received_ms).toBe(NOW + 20_000);
      });

      it("fences a socket that has been replaced", async () => {
        const replaced = new Date("2026-11-19T10:00:00.000Z");
        await expect(write({ connectedAt: replaced }, database)).resolves.toBe(
          "fenced",
        );
        expect(await metricRows()).toHaveLength(0);
      });

      it("fences a disabled server", async () => {
        await expect(write({ serverId: "disabled" }, database)).resolves.toBe(
          "fenced",
        );
        expect(await metricRows("disabled")).toHaveLength(0);
      });

      it("keeps the newer receipt when a same-minute sample arrives late", async () => {
        await write({ receivedAt: new Date(NOW + 40_000), cpu: 80 }, database);
        await expect(
          write({ receivedAt: new Date(NOW + 10_000), cpu: 5 }, database),
        ).resolves.toBe("superseded");
        expect((await metricRows())[0]!.cpu_percent).toBe(80);

        await expect(
          write({ receivedAt: new Date(NOW + 50_000), cpu: 30 }, database),
        ).resolves.toBe("written");
        expect((await metricRows())[0]!.cpu_percent).toBe(30);
      });

      it("keeps a partial sample and drops one with nothing usable", async () => {
        // CPU unavailable, memory and disk still valid: stored with a gap.
        await expect(write({ cpu: null }, database)).resolves.toBe("written");
        expect((await metricRows())[0]!.cpu_percent).toBeNull();

        await expect(
          recordServerMetricMinute(
            {
              serverId: "srv1",
              connectedAt: SESSION,
              receivedAt: new Date(NOW + MINUTE),
              sample: sample({ cpuPercent: null, memory: null, disk: null }),
            },
            database as never,
          ),
        ).resolves.toBe("invalid");
        expect(await metricRows()).toHaveLength(1);
      });
    });

    describe("pruneServerMetricHistory", () => {
      it("removes only rows past retention, in bounded batches", async () => {
        const old = NOW - 31 * 24 * 60 * MINUTE;
        const recent = NOW - 2 * MINUTE;
        for (let i = 0; i < 5; i += 1) {
          await admin.query(
            `insert into server_metric_minute(server_id,minute,scope,scope_key,received_at)
             values ('srv1', $1::timestamp, 'host', 'k', $1::timestamp)`,
            [new Date(old + i * MINUTE).toISOString()],
          );
        }
        await admin.query(
          `insert into server_metric_minute(server_id,minute,scope,scope_key,received_at)
           values ('srv1', $1::timestamp, 'host', 'k', $1::timestamp)`,
          [new Date(recent).toISOString()],
        );

        await expect(
          pruneServerMetricHistory(
            { now: NOW, batchSize: 2, maxBatches: 1 },
            database as never,
          ),
        ).resolves.toBe(2);
        await expect(
          pruneServerMetricHistory(
            { now: NOW, batchSize: 2, maxBatches: 5 },
            database as never,
          ),
        ).resolves.toBe(3);
        expect(await metricRows()).toHaveLength(1);
      });
    });

    describe("loadServerMetricHistory", () => {
      async function seedDay(skipFromMinute: number, skipCount: number) {
        const plan = planMetricHistory("24h", NOW);
        await admin.query(
          `insert into server_metric_minute(server_id,minute,scope,scope_key,cpu_percent,memory_used_bytes,memory_total_bytes,received_at)
           select 'srv1', m, 'host', 'systemd', 10 + (extract(epoch from m)::bigint / 60 % 5), 512, 1024, m + interval '5 seconds'
           from generate_series($1::timestamp, $2::timestamp - interval '1 minute', interval '1 minute') m
           where not (m >= $3::timestamp and m < $3::timestamp + ($4 || ' minutes')::interval)`,
          [
            new Date(plan.fromMs).toISOString(),
            new Date(plan.toMs).toISOString(),
            new Date(plan.fromMs + skipFromMinute * MINUTE).toISOString(),
            skipCount,
          ],
        );
      }

      it("downsamples 24 hours into at most 600 buckets of 3 minutes", async () => {
        await seedDay(0, 0);
        const history = await loadServerMetricHistory(
          "srv1",
          "24h",
          NOW,
          database as never,
        );

        expect(history.points.length).toBeLessThanOrEqual(600);
        expect(history.bucketSeconds).toBe(180);
        expect(history.points).toHaveLength(480);
        expect(history.points.every((p) => p.samples === 3)).toBe(true);
        expect(history.points[0]!.cpuPercent).not.toBeNull();
        expect(history.historySinceMs).toBe(
          planMetricHistory("24h", NOW).fromMs,
        );
      });

      it("returns gap points for a missing interval and breaks the series there", async () => {
        // Remove one whole hour in the middle of the window.
        await seedDay(120, 60);
        const history = await loadServerMetricHistory(
          "srv1",
          "24h",
          NOW,
          database as never,
        );

        const gaps = history.points.filter((p) => p.samples === 0);
        expect(gaps).toHaveLength(20);
        expect(gaps.every((p) => p.cpuPercent === null)).toBe(true);

        const segments = splitMetricSegments(
          history.points,
          (p) => p.cpuPercent,
        );
        expect(segments.length).toBe(2);
      });

      it("breaks the series at a scope change inside the window", async () => {
        const plan = planMetricHistory("1h", NOW);
        await admin.query(
          `insert into server_metric_minute(server_id,minute,scope,scope_key,cpu_percent,received_at)
           select 'srv1', m, case when m < $2::timestamp then 'host' else 'container' end,
             case when m < $2::timestamp then 'systemd' else 'docker|cg2' end,
             25, m
           from generate_series($1::timestamp, $3::timestamp - interval '1 minute', interval '1 minute') m`,
          [
            new Date(plan.fromMs).toISOString(),
            new Date(plan.fromMs + 30 * MINUTE).toISOString(),
            new Date(plan.toMs).toISOString(),
          ],
        );
        const history = await loadServerMetricHistory(
          "srv1",
          "1h",
          NOW,
          database as never,
        );
        const segments = splitMetricSegments(
          history.points,
          (p) => p.cpuPercent,
        );
        expect(segments.map((s) => s.scopeKey)).toEqual([
          "systemd",
          "docker|cg2",
        ]);
        expect(history.points.at(-1)).toMatchObject({
          scope: "container",
          scopeKey: "docker|cg2",
        });
      });

      it("returns no history and no earliest sample for a new server", async () => {
        const history = await loadServerMetricHistory(
          "srv2",
          "30d",
          NOW,
          database as never,
        );
        expect(history.historySinceMs).toBeNull();
        expect(history.points).toHaveLength(600);
        expect(history.points.every((p) => p.samples === 0)).toBe(true);
      });

      it("removes history with its server", async () => {
        await seedDay(0, 0);
        await admin.query(`delete from server where id = 'srv1'`);
        expect(await metricRows()).toHaveLength(0);
      });
    });
  },
);
