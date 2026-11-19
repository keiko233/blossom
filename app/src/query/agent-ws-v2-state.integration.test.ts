/**
 * Fenced v2 state writes (acknowledgements, status, hello, cached identifiers)
 * against a real PostgreSQL through each database driver.
 *
 * Skipped unless `BLOSSOM_TEST_DATABASE_URL` points at a DISPOSABLE database
 * that already has the migrations applied (this suite deletes rows). Its
 * database name must begin with `blossom_test`, and
 * BLOSSOM_TEST_CONFIRM_DISPOSABLE must be `yes`. The neon-http driver runs too
 * when `BLOSSOM_TEST_NEON_HTTP_URL` and `BLOSSOM_TEST_NEON_HTTP_ENDPOINT` are
 * set. All disposable-database suites share one database, so run them with
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
      "Agent v2 state integration tests require explicit disposable database confirmation",
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
        "Agent v2 state integration tests require a database named blossom_test*",
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
  cacheAgentDesiredRevision,
  invalidateDesiredConfigRevisions,
  loadAgentServer,
  recordAgentV2ConfigAck,
  recordAgentV2Hello,
  recordAgentV2Status,
  startAgentWsSession,
} from "./agent";

type Driver = "node-postgres" | "neon-http";
const drivers: Driver[] = ["node-postgres"];
if (pgUrl && neonUrl && neonEndpoint) drivers.push("neon-http");

const admin = new pg.Pool({ connectionString: pgUrl, max: 4 });
afterAll(async () => {
  await admin.end();
});

const REV = (seq: number, digit: string) => `${seq}:sha256:${digit.repeat(64)}`;

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

async function row(serverId: string) {
  const { rows } = await admin.query(
    `select applied_revision, applied_revision_seq, config_state, desired_revision_seq,
            desired_config_revision, runtime_state, last_error_code, last_error_message,
            ws_session_id, transport_mode
       from server where id = $1`,
    [serverId],
  );
  return rows[0] as Record<string, unknown>;
}

describe.skipIf(!pgUrl).each(drivers)(
  "agent WebSocket v2 state writes on %s",
  (driver) => {
    let database: Awaited<ReturnType<typeof useDriver>>["database"];
    let close: () => Promise<unknown>;

    beforeAll(async () => {
      ({ database, close } = await useDriver(driver));
    });
    afterAll(async () => {
      await close();
    });

    beforeEach(async () => {
      await admin.query(
        `delete from traffic_report; delete from traffic_record; delete from subscription;
         delete from plan; delete from node; delete from server; delete from "user";`,
      );
      // desired sequence 8, applied sequence 6: the agent is one change behind.
      await admin.query(
        `insert into server(id,name,address,agent_token_hash,agent_token_prefix,
                            desired_revision_seq,applied_revision_seq,applied_revision)
         values ('srv1','srv1','192.0.2.1','srv1-hash','srv1-pre',8,6,$1)`,
        [REV(6, "a")],
      );
    });

    it("advances the applied revision on a fenced success", async () => {
      const session = await startAgentWsSession("srv1", database);
      const outcome = await recordAgentV2ConfigAck(
        "srv1",
        session.sessionId,
        {
          desired: { desiredRevisionSeq: 8, desiredRevision: REV(8, "b") },
          outcome: "applied",
        },
        database,
      );

      expect(outcome).toBe("applied");
      expect(await row("srv1")).toMatchObject({
        applied_revision: REV(8, "b"),
        applied_revision_seq: 8,
        config_state: "applied",
      });
    });

    it("never rewinds the gate on a stale or replayed success", async () => {
      const session = await startAgentWsSession("srv1", database);
      await recordAgentV2ConfigAck(
        "srv1",
        session.sessionId,
        {
          desired: { desiredRevisionSeq: 8, desiredRevision: REV(8, "b") },
          outcome: "applied",
        },
        database,
      );

      const stale = await recordAgentV2ConfigAck(
        "srv1",
        session.sessionId,
        {
          desired: { desiredRevisionSeq: 6, desiredRevision: REV(6, "a") },
          outcome: "applied",
        },
        database,
      );

      expect(stale).toBe("stale");
      expect(await row("srv1")).toMatchObject({
        applied_revision: REV(8, "b"),
        applied_revision_seq: 8,
      });
    });

    it("refuses an acknowledgement for a sequence the server has not reached", async () => {
      const session = await startAgentWsSession("srv1", database);
      const outcome = await recordAgentV2ConfigAck(
        "srv1",
        session.sessionId,
        {
          desired: { desiredRevisionSeq: 9, desiredRevision: REV(9, "c") },
          outcome: "applied",
        },
        database,
      );

      expect(outcome).toBe("stale");
      expect(await row("srv1")).toMatchObject({
        applied_revision_seq: 6,
        desired_revision_seq: 8,
      });
    });

    it("records a failed stage and keeps the applied revision", async () => {
      const session = await startAgentWsSession("srv1", database);
      const outcome = await recordAgentV2ConfigAck(
        "srv1",
        session.sessionId,
        {
          desired: { desiredRevisionSeq: 8, desiredRevision: REV(8, "b") },
          outcome: "failed",
          stage: "validate",
          error: "sing-box check rejected a tag",
        },
        database,
      );

      expect(outcome).toBe("failed");
      expect(await row("srv1")).toMatchObject({
        applied_revision_seq: 6,
        applied_revision: REV(6, "a"),
        config_state: "apply_failed",
        last_error_code: "config_validate",
        last_error_message: "sing-box check rejected a tag",
      });
    });

    it("fences a replaced session out of every write", async () => {
      const old = await startAgentWsSession("srv1", database);
      await startAgentWsSession("srv1", database);

      await expect(
        recordAgentV2ConfigAck(
          "srv1",
          old.sessionId,
          {
            desired: { desiredRevisionSeq: 8, desiredRevision: REV(8, "b") },
            outcome: "applied",
          },
          database,
        ),
      ).resolves.toBe("replaced");
      await expect(
        recordAgentV2ConfigAck(
          "srv1",
          old.sessionId,
          {
            desired: { desiredRevisionSeq: 8, desiredRevision: REV(8, "b") },
            outcome: "failed",
            stage: "apply",
            error: "late",
          },
          database,
        ),
      ).resolves.toBe("replaced");
      expect(
        await recordAgentV2Status(
          "srv1",
          old.sessionId,
          {
            reason: "interval",
            runtimeState: "crash_loop",
            certificateDeployments: [],
          },
          database,
        ),
      ).toBeNull();
      await cacheAgentDesiredRevision(
        "srv1",
        old.sessionId,
        8,
        REV(8, "b"),
        database,
      );

      expect(await row("srv1")).toMatchObject({
        applied_revision_seq: 6,
        runtime_state: "unknown",
        desired_config_revision: null,
      });
    });

    it("does not let a hello report rewind the recorded applied revision", async () => {
      const session = await startAgentWsSession("srv1", database);
      await recordAgentV2ConfigAck(
        "srv1",
        session.sessionId,
        {
          desired: { desiredRevisionSeq: 8, desiredRevision: REV(8, "b") },
          outcome: "applied",
        },
        database,
      );

      await recordAgentV2Hello(
        "srv1",
        session.sessionId,
        {
          agentVersion: "0.4.0",
          agentBuildId: "build-1",
          capabilities: ["config-v3"],
          applied: { desiredRevisionSeq: 6, desiredRevision: REV(6, "a") },
          certificateDeployments: [],
        },
        database,
      );

      expect(await row("srv1")).toMatchObject({
        applied_revision: REV(8, "b"),
        applied_revision_seq: 8,
      });
    });

    it("stores status fields for the current session and returns authoritative identifiers", async () => {
      const session = await startAgentWsSession("srv1", database);
      await cacheAgentDesiredRevision(
        "srv1",
        session.sessionId,
        8,
        REV(8, "b"),
        database,
      );

      const updated = await recordAgentV2Status(
        "srv1",
        session.sessionId,
        {
          reason: "change",
          runtimeState: "running",
          singBoxVersion: "1.13.0",
          error: { phase: "apply", code: "boom", message: "bad\u0007value" },
          certificateDeployments: [],
        },
        database,
      );

      expect(updated).toMatchObject({
        runtimeState: "running",
        desiredRevisionSeq: 8,
        desiredConfigRevision: REV(8, "b"),
        lastErrorCode: "boom",
      });
      expect(updated?.lastErrorMessage).not.toContain("\u0007");

      const cleared = await recordAgentV2Status(
        "srv1",
        session.sessionId,
        {
          reason: "interval",
          error: null,
          certificateDeployments: [],
        },
        database,
      );
      expect(cleared?.lastErrorCode).toBeNull();
    });

    it("keeps a cached identifier only for the sequence it was compiled at", async () => {
      const session = await startAgentWsSession("srv1", database);
      await cacheAgentDesiredRevision(
        "srv1",
        session.sessionId,
        7,
        REV(7, "d"),
        database,
      );
      expect((await row("srv1")).desired_config_revision).toBeNull();

      await cacheAgentDesiredRevision(
        "srv1",
        session.sessionId,
        8,
        REV(8, "b"),
        database,
      );
      expect((await row("srv1")).desired_config_revision).toBe(REV(8, "b"));

      await invalidateDesiredConfigRevisions(["srv1"], database);
      expect((await row("srv1")).desired_config_revision).toBeNull();
    });

    it("loads the server row a session compiles from", async () => {
      expect(await loadAgentServer("srv1", database)).toMatchObject({
        id: "srv1",
        desiredRevisionSeq: 8,
        appliedRevisionSeq: 6,
      });
      expect(await loadAgentServer("missing", database)).toBeNull();
    });
  },
);
