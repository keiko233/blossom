/**
 * Session fencing of the per-server WebSocket marker against a real PostgreSQL.
 *
 * Skipped unless `BLOSSOM_TEST_DATABASE_URL` points at a DISPOSABLE database
 * that already has the migrations applied (this suite deletes server rows). Its
 * database name must begin with `blossom_test`, and
 * BLOSSOM_TEST_CONFIRM_DISPOSABLE must be `yes`. Never use an existing database.
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

if (pgUrl) {
  if (process.env.BLOSSOM_TEST_CONFIRM_DISPOSABLE !== "yes") {
    throw new Error(
      "Session integration tests require explicit disposable database confirmation",
    );
  }
  if (
    !decodeURIComponent(new URL(pgUrl).pathname.slice(1)).startsWith(
      "blossom_test",
    )
  ) {
    throw new Error(
      "Session integration tests require a database named blossom_test*",
    );
  }
}

const hoisted = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/db", () => ({
  get db() {
    return hoisted.db;
  },
}));

import { drizzle } from "drizzle-orm/node-postgres";

import {
  endAgentWsSession,
  markAgentWsConnected,
  markAgentWsDisconnected,
  startAgentWsSession,
} from "./agent";

const admin = new pg.Pool({ connectionString: pgUrl, max: 4 });

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

describe.skipIf(!pgUrl)(
  "agent WebSocket session fencing (node-postgres)",
  () => {
    let pool: pg.Pool;
    let database: ReturnType<typeof drizzle>;
    beforeAll(() => {
      pool = new pg.Pool({ connectionString: pgUrl, max: 16 });
      database = drizzle({ client: pool });
      hoisted.db = database;
    });
    afterAll(async () => {
      await pool.end();
      await admin.end();
    });

    beforeEach(async () => {
      await admin.query(
        `delete from traffic_report; delete from traffic_record; delete from subscription;
       delete from plan; delete from node; delete from server; delete from "user";`,
      );
      await admin.query(
        `insert into server(id,name,address,agent_token_hash,agent_token_prefix)
       values ('srv1','srv1','192.0.2.1','srv1-hash','srv1-pre')`,
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
      expect(ids.size).toBe(12);

      const marker = (await markerOf("srv1")).ws_session_id;
      expect(ids.has(marker!)).toBe(true);
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
  },
);
