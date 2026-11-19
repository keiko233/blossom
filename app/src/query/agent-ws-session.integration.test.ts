/**
 * Session fencing of the per-server WebSocket marker and of the traffic write
 * that it fences, against a real PostgreSQL through each database driver.
 *
 * Skipped unless `BLOSSOM_TEST_DATABASE_URL` points at a DISPOSABLE database
 * that already has the migrations applied (this suite deletes rows). Its
 * database name must begin with `blossom_test`, and
 * BLOSSOM_TEST_CONFIRM_DISPOSABLE must be `yes`. The neon-http driver runs too
 * when `BLOSSOM_TEST_NEON_HTTP_URL` and `BLOSSOM_TEST_NEON_HTTP_ENDPOINT` are
 * set (a Neon HTTP `/sql` proxy in front of the same database); see
 * docs/development/api-data-auth.md. All disposable-database suites share one
 * database and wipe the same tables, so run them with
 * `vitest run --no-file-parallelism`.
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
      "Session integration tests require explicit disposable database confirmation",
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
        "Session integration tests require a database named blossom_test*",
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
  AgentSessionReplacedError,
  computeTrafficReportHash,
  endAgentWsSession,
  markAgentWsConnected,
  markAgentWsDisconnected,
  recordAgentTraffic,
  startAgentWsSession,
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
    const database = drizzle({ client: pool });
    hoisted.db = database;
    return { database, close: () => pool.end() };
  }
  const { neon, neonConfig } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-http");
  neonConfig.fetchEndpoint = () => neonEndpoint!;
  const database = drizzle({ client: neon(neonUrl!) });
  hoisted.db = database;
  return { database, close: async () => {} };
}

async function markerOf(serverId: string) {
  const { rows } = await admin.query(
    `select ws_session_id, ws_connected_at, transport_mode from server where id = $1`,
    [serverId],
  );
  return rows[0] as {
    ws_session_id: string | null;
    ws_connected_at: Date | null;
    transport_mode: string;
  };
}

function report(
  reportId: string,
  uplinkBytes: number,
  sessionId?: string,
): RecordTrafficReport {
  const entries = [
    { subscriptionId: "sa", nodeId: null, uplinkBytes, downlinkBytes: 0 },
  ];
  return {
    serverId: "srv1",
    reportId,
    contentHash: computeTrafficReportHash({
      entries: entries.map(
        ({ subscriptionId, uplinkBytes, downlinkBytes }) => ({
          subscriptionId,
          uplinkBytes,
          downlinkBytes,
        }),
      ),
    }),
    windowStartedAt: null,
    windowEndedAt: null,
    entries,
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

async function usedBytes() {
  const { rows } = await admin.query(
    `select traffic_used_bytes::int as used from subscription where id='sa'`,
  );
  return rows[0].used as number;
}

describe.skipIf(!pgUrl).each(drivers)(
  "agent WebSocket session fencing on %s",
  (driver) => {
    let database: Awaited<ReturnType<typeof useDriver>>["database"];
    let close: () => Promise<unknown>;

    beforeAll(async () => {
      ({ database, close } = await useDriver(driver));
    });
    afterAll(async () => {
      await close();
      if (driver === drivers[drivers.length - 1]) await admin.end();
    });

    beforeEach(async () => {
      await admin.query(
        `delete from traffic_report; delete from traffic_record; delete from subscription;
         delete from plan; delete from node; delete from server; delete from "user";`,
      );
      await admin.query(
        `insert into "user"(id,name,email) values ('u1','u','u@example.test')`,
      );
      await admin.query(
        `insert into plan(id,name,price_cents,duration_days,traffic_bytes) values ('p1','p',0,30,1000000)`,
      );
      await admin.query(
        `insert into server(id,name,address,agent_token_hash,agent_token_prefix)
         values ('srv1','srv1','192.0.2.1','srv1-hash','srv1-pre')`,
      );
      await admin.query(
        `insert into subscription(id,user_id,plan_id,expires_at,traffic_quota_bytes,device_limit,credential_uuid,credential_password,token)
         values ('sa','u1','p1', now() + interval '1 day', 1000000, 1, 'sa-uuid', 'pw', 'sa-tok')`,
      );
    });

    it("a newer handshake replaces the marker and an older session cannot end it", async () => {
      const first = await startAgentWsSession("srv1", database);
      const second = await startAgentWsSession("srv1", database);
      expect(second.sessionId).not.toBe(first.sessionId);
      expect((await markerOf("srv1")).ws_session_id).toBe(second.sessionId);

      await endAgentWsSession("srv1", first.sessionId, database);
      expect(await markerOf("srv1")).toMatchObject({
        ws_session_id: second.sessionId,
        transport_mode: "ws",
      });

      await endAgentWsSession("srv1", second.sessionId, database);
      expect(await markerOf("srv1")).toMatchObject({
        ws_session_id: null,
        ws_connected_at: null,
        transport_mode: "http",
      });
    });

    it("keeps exactly one marker when handshakes race", async () => {
      const sessions = await Promise.all(
        Array.from({ length: 12 }, () => startAgentWsSession("srv1", database)),
      );
      const ids = new Set(sessions.map((session) => session.sessionId));
      const connectedAt = new Set(
        sessions.map((session) => session.connectedAt.getTime()),
      );
      expect(ids.size).toBe(12);
      expect(connectedAt.size).toBe(12);
      expect(ids.has((await markerOf("srv1")).ws_session_id!)).toBe(true);
    });

    it("v1 disconnect clears only the handshake that is still current", async () => {
      const v1Connected = await markAgentWsConnected("srv1", database);
      const v2 = await startAgentWsSession("srv1", database);

      await markAgentWsDisconnected("srv1", v1Connected, database);
      expect((await markerOf("srv1")).ws_session_id).toBe(v2.sessionId);

      await markAgentWsDisconnected("srv1", v2.connectedAt, database);
      expect(await markerOf("srv1")).toMatchObject({
        ws_session_id: null,
        transport_mode: "http",
      });
    });

    it("applies a report from the current session and rejects one from a replaced session", async () => {
      const old = await startAgentWsSession("srv1", database);
      await expect(
        recordAgentTraffic(report("report-old-1", 100, old.sessionId)),
      ).resolves.toMatchObject({ accepted: 1, duplicate: false });

      const current = await startAgentWsSession("srv1", database);
      await expect(
        recordAgentTraffic(report("report-old-2", 50, old.sessionId)),
      ).rejects.toBeInstanceOf(AgentSessionReplacedError);
      expect(await usedBytes()).toBe(100);

      await expect(
        recordAgentTraffic(report("report-new-1", 25, current.sessionId)),
      ).resolves.toMatchObject({ accepted: 1, duplicate: false });
      expect(await usedBytes()).toBe(125);
    });

    it("deduplicates a replay that arrives on the replacing session", async () => {
      const old = await startAgentWsSession("srv1", database);
      await recordAgentTraffic(report("report-replay", 100, old.sessionId));
      const current = await startAgentWsSession("srv1", database);

      await expect(
        recordAgentTraffic(report("report-replay", 100, current.sessionId)),
      ).resolves.toMatchObject({ accepted: 1, duplicate: true });
      expect(await usedBytes()).toBe(100);
    });

    it("refuses a conflicting replay without applying it", async () => {
      const current = await startAgentWsSession("srv1", database);
      await recordAgentTraffic(
        report("report-conflict", 100, current.sessionId),
      );

      await expect(
        recordAgentTraffic(report("report-conflict", 999, current.sessionId)),
      ).rejects.toBeInstanceOf(TrafficReportConflictError);
      expect(await usedBytes()).toBe(100);
    });

    it("requires a report id for a fenced report", async () => {
      const current = await startAgentWsSession("srv1", database);
      await expect(
        recordAgentTraffic({
          ...report("unused", 1),
          reportId: undefined,
          contentHash: undefined,
          sessionId: current.sessionId,
        }),
      ).rejects.toThrow("sessionId requires reportId");
    });
  },
);
