/**
 * Atomicity and idempotency of `recordAgentTraffic` against a real PostgreSQL.
 *
 * Skipped unless `BLOSSOM_TEST_DATABASE_URL` points at a DISPOSABLE database
 * that already has the migrations applied (this suite deletes rows from the
 * traffic, subscription, plan, node, server and user tables). Its database name
 * must begin with `blossom_test`, and BLOSSOM_TEST_CONFIRM_DISPOSABLE must be
 * `yes`. Never use an existing database. The neon-http
 * driver is exercised as well when `BLOSSOM_TEST_NEON_HTTP_URL` and
 * `BLOSSOM_TEST_NEON_HTTP_ENDPOINT` are set (a Neon HTTP proxy in front of the
 * same database); see docs/development/api-data-auth.md.
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
      "Traffic integration tests require explicit disposable database confirmation",
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
        "Traffic integration tests require a database named blossom_test*",
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
  computeTrafficReportHash,
  recordAgentTraffic,
  TRAFFIC_REPORT_RETENTION_DAYS,
  TrafficReportConflictError,
  type RecordTrafficReport,
} from "./agent";

type Driver = "node-postgres" | "neon-http";
const drivers: Driver[] = ["node-postgres"];
if (pgUrl && neonUrl && neonEndpoint) drivers.push("neon-http");

const admin = new pg.Pool({ connectionString: pgUrl, max: 4 });

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

function entries(...pairs: [string, number][]) {
  return pairs.map(([subscriptionId, bytes]) => ({
    subscriptionId,
    nodeId: null,
    uplinkBytes: bytes,
    downlinkBytes: 0,
  }));
}

function report(
  serverId: string,
  reportId: string | undefined,
  rows: ReturnType<typeof entries>,
): RecordTrafficReport {
  const raw = rows.map((r) => ({
    subscriptionId: r.subscriptionId,
    uplinkBytes: r.uplinkBytes,
    downlinkBytes: r.downlinkBytes,
  }));
  return {
    serverId,
    reportId,
    contentHash:
      reportId === undefined
        ? undefined
        : computeTrafficReportHash({ entries: raw }),
    windowStartedAt: new Date("2026-10-30T00:00:00.000Z"),
    windowEndedAt: new Date("2026-10-30T00:01:00.000Z"),
    entries: rows,
  };
}

async function used() {
  const { rows } = await admin.query(
    `select id, traffic_used_bytes::int as used from subscription order by id`,
  );
  return Object.fromEntries(rows.map((r) => [r.id, r.used]));
}

async function count(table: string) {
  const { rows } = await admin.query(`select count(*)::int as n from ${table}`);
  return rows[0].n as number;
}

describe.skipIf(!pgUrl).each(drivers)("recordAgentTraffic on %s", (driver) => {
  let close: () => Promise<unknown>;
  beforeAll(async () => {
    close = await useDriver(driver);
  });
  afterAll(async () => {
    await close();
    if (driver === drivers[drivers.length - 1]) await admin.end();
  });

  beforeEach(async () => {
    await admin.query(
      `drop trigger if exists fail_sb on subscription;
         delete from traffic_report; delete from traffic_record; delete from subscription;
         delete from plan; delete from node; delete from server; delete from "user";`,
    );
    await admin.query(
      `insert into "user"(id,name,email) values ('u1','u','u@example.test')`,
    );
    await admin.query(
      `insert into plan(id,name,price_cents,duration_days,traffic_bytes) values ('p1','p',0,30,1000000)`,
    );
    for (const id of ["srv1", "srv2"]) {
      await admin.query(
        `insert into server(id,name,address,agent_token_hash,agent_token_prefix) values ($1,$1,'192.0.2.1',$1||'-hash',$1||'-pre')`,
        [id],
      );
    }
    await admin.query(
      `insert into node(id,name,listen_port,protocol,server_id) values ('n1','n1',443,'vless','srv1')`,
    );
    for (const [id, expiry] of [
      ["sa", "now() + interval '1 day'"],
      ["sb", "now() + interval '1 day'"],
      ["sexpired", "now() - interval '1 day'"],
    ] as const) {
      await admin.query(
        `insert into subscription(id,user_id,plan_id,expires_at,traffic_quota_bytes,device_limit,credential_uuid,credential_password,token)
           values ($1,'u1','p1', ${expiry}, 1000000, 1, $1||'-uuid', 'pw', $1||'-tok')`,
        [id],
      );
    }
  });

  it("writes history, counters and one ledger row for a new report", async () => {
    const r = report("srv1", "report-0001", entries(["sa", 100], ["sb", 50]));
    r.entries[0]!.nodeId = "n1";

    await expect(recordAgentTraffic(r)).resolves.toEqual({
      accepted: 2,
      dropped: 0,
      duplicate: false,
      quotaExhausted: false,
    });

    expect(await used()).toMatchObject({ sa: 100, sb: 50 });
    expect(await count("traffic_record")).toBe(2);
    expect(await count("traffic_report")).toBe(1);
    const { rows } = await admin.query(
      `select user_id, node_id, server_id, window_ended_at from traffic_record where subscription_id='sa'`,
    );
    expect(rows[0]).toMatchObject({
      user_id: "u1",
      node_id: "n1",
      server_id: "srv1",
    });
    expect(new Date(rows[0].window_ended_at + "Z").toISOString()).toBe(
      "2026-10-30T00:01:00.000Z",
    );
  });

  it("applies an identical retry (lost response) at most once", async () => {
    const r = report("srv1", "report-0002", entries(["sa", 100], ["sb", 50]));
    const first = await recordAgentTraffic(r);
    const replay = await recordAgentTraffic(r);

    expect(replay).toEqual({ ...first, duplicate: true });
    expect(await used()).toMatchObject({ sa: 100, sb: 50 });
    expect(await count("traffic_record")).toBe(2);
    expect(await count("traffic_report")).toBe(1);
  });

  it("a replay returns the original counts even when attribution changed", async () => {
    const r = report("srv1", "report-0003", entries(["sa", 10], ["ghost", 5]));
    const first = await recordAgentTraffic(r);
    expect(first).toMatchObject({ accepted: 1, dropped: 1 });
    await admin.query(`delete from subscription where id = 'sa'`);

    await expect(recordAgentTraffic(r)).resolves.toEqual({
      accepted: 1,
      dropped: 1,
      duplicate: true,
      quotaExhausted: false,
    });
  });

  it("applies concurrent duplicates exactly once", async () => {
    const r = report("srv1", "report-0004", entries(["sa", 100], ["sb", 50]));
    const results = await Promise.all(
      Array.from({ length: 12 }, () => recordAgentTraffic(r)),
    );

    expect(results.filter((x) => !x.duplicate)).toHaveLength(1);
    expect(results.filter((x) => x.duplicate)).toHaveLength(11);
    expect(new Set(results.map((x) => `${x.accepted}/${x.dropped}`))).toEqual(
      new Set(["2/0"]),
    );
    expect(await used()).toMatchObject({ sa: 100, sb: 50 });
    expect(await count("traffic_record")).toBe(2);
  });

  it("rejects a reused id with different content and changes nothing", async () => {
    await recordAgentTraffic(
      report("srv1", "report-0005", entries(["sa", 100])),
    );

    await expect(
      recordAgentTraffic(report("srv1", "report-0005", entries(["sa", 999]))),
    ).rejects.toBeInstanceOf(TrafficReportConflictError);
    expect(await used()).toMatchObject({ sa: 100 });
    expect(await count("traffic_record")).toBe(1);
  });

  it("scopes report ids to the calling server", async () => {
    const a = await recordAgentTraffic(
      report("srv1", "report-0006", entries(["sa", 100])),
    );
    const b = await recordAgentTraffic(
      report("srv2", "report-0006", entries(["sa", 7])),
    );

    expect([a.duplicate, b.duplicate]).toEqual([false, false]);
    expect(await used()).toMatchObject({ sa: 107 });
  });

  it("is atomic: a failure on the second subscription leaves nothing behind, and the retry applies once", async () => {
    await admin.query(`
        create or replace function fail_sb() returns trigger language plpgsql as $$
        begin if new.id = 'sb' then raise exception 'injected failure'; end if; return new; end $$;
        create trigger fail_sb before update on subscription for each row execute function fail_sb();`);
    const r = report("srv1", "report-0007", entries(["sa", 100], ["sb", 50]));

    await expect(recordAgentTraffic(r)).rejects.toThrow();
    expect(await used()).toMatchObject({ sa: 0, sb: 0 });
    expect(await count("traffic_record")).toBe(0);
    expect(await count("traffic_report")).toBe(0);

    await admin.query(`drop trigger fail_sb on subscription`);
    await expect(recordAgentTraffic(r)).resolves.toMatchObject({
      accepted: 2,
      duplicate: false,
    });
    expect(await used()).toMatchObject({ sa: 100, sb: 50 });
    expect(await count("traffic_record")).toBe(2);
  });

  it("drops unknown subscriptions but still credits expired ones", async () => {
    const result = await recordAgentTraffic(
      report("srv1", "report-0008", entries(["sexpired", 30], ["ghost", 99])),
    );

    expect(result).toEqual({
      accepted: 1,
      dropped: 1,
      duplicate: false,
      quotaExhausted: false,
    });
    expect(await used()).toMatchObject({ sexpired: 30 });
    expect(await count("traffic_record")).toBe(1);
  });

  it("records a report whose subscriptions are all unknown so replays stay detectable", async () => {
    const r = report("srv1", "report-0009", entries(["ghost", 99]));
    await expect(recordAgentTraffic(r)).resolves.toEqual({
      accepted: 0,
      dropped: 1,
      duplicate: false,
      quotaExhausted: false,
    });
    await expect(recordAgentTraffic(r)).resolves.toMatchObject({
      duplicate: true,
    });
  });

  it("legacy reports (no id) are atomic but NOT replay-safe", async () => {
    const r = report("srv1", undefined, entries(["sa", 100], ["sb", 50]));
    await recordAgentTraffic(r);
    await recordAgentTraffic(r);

    expect(await used()).toMatchObject({ sa: 200, sb: 100 });
    expect(await count("traffic_report")).toBe(0);
  });

  it("legacy reports are atomic too: a failure leaves no partial history", async () => {
    await admin.query(`
        create or replace function fail_sb() returns trigger language plpgsql as $$
        begin if new.id = 'sb' then raise exception 'injected failure'; end if; return new; end $$;
        create trigger fail_sb before update on subscription for each row execute function fail_sb();`);

    await expect(
      recordAgentTraffic(
        report("srv1", undefined, entries(["sa", 1], ["sb", 1])),
      ),
    ).rejects.toThrow();
    expect(await used()).toMatchObject({ sa: 0, sb: 0 });
    expect(await count("traffic_record")).toBe(0);
  });

  it("flags the report that crosses a traffic quota, and only that one", async () => {
    await admin.query(
      `update subscription set traffic_used_bytes = 90, traffic_quota_bytes = 100 where id = 'sa'`,
    );

    const crossing = report("srv1", "report-0011", entries(["sa", 10]));
    await expect(recordAgentTraffic(crossing)).resolves.toEqual({
      accepted: 1,
      dropped: 0,
      duplicate: false,
      quotaExhausted: true,
    });
    expect(await used()).toMatchObject({ sa: 100 });

    // Already at the quota: further usage accrues but neither crosses again nor
    // re-flags the report.
    const after = report("srv1", "report-0012", entries(["sa", 1]));
    await expect(recordAgentTraffic(after)).resolves.toEqual({
      accepted: 1,
      dropped: 0,
      duplicate: false,
      quotaExhausted: false,
    });
    expect(await used()).toMatchObject({ sa: 101 });
  });

  it("prunes ledger rows past retention when a new report is claimed", async () => {
    await admin.query(
      `insert into traffic_report(id,server_id,report_id,content_hash,accepted,dropped,created_at)
         values ('old','srv1','report-old0001','h',1,0, now() - interval '${TRAFFIC_REPORT_RETENTION_DAYS + 1} days'),
                ('fresh','srv1','report-new0001','h',1,0, now())`,
    );

    await recordAgentTraffic(report("srv1", "report-0010", entries(["sa", 1])));

    const { rows } = await admin.query(
      `select report_id from traffic_report order by report_id`,
    );
    expect(rows.map((r) => r.report_id)).toEqual([
      "report-0010",
      "report-new0001",
    ]);
  });
});
