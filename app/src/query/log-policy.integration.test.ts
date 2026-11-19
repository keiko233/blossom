/**
 * Durable log-policy compare-and-swap, expiry and fenced acknowledgement
 * against a real PostgreSQL through each driver.
 *
 * Skipped unless `BLOSSOM_TEST_DATABASE_URL` points at a DISPOSABLE database
 * with the migrations applied. Its name must begin with `blossom_test`, and
 * BLOSSOM_TEST_CONFIRM_DISPOSABLE must be `yes`. Run with
 * `vitest run --no-file-parallelism`, because the disposable suites share one
 * database.
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
      "Log policy integration tests require explicit disposable database confirmation",
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
        "Log policy integration tests require a database named blossom_test*",
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

import type { LogPolicyAckPayload } from "@blossom/contracts/log-policy";

import { startAgentWsSession } from "./agent";
import {
  loadAgentLogPolicySnapshot,
  readServerLogPolicy,
  recordAgentLogPolicyAck,
  restoreServerLogPolicy,
  writeServerLogPolicy,
} from "./log-policy";

type Driver = "node-postgres" | "neon-http";
const drivers: Driver[] = ["node-postgres"];
if (pgUrl && neonUrl && neonEndpoint) drivers.push("neon-http");

const admin = new pg.Pool({ connectionString: pgUrl, max: 4 });
afterAll(async () => {
  await admin.end();
});

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

async function serverRow(serverId: string) {
  const { rows } = await admin.query(
    `select log_policy_revision, ws_session_id
       from server where id = $1`,
    [serverId],
  );
  return rows[0] as Record<string, unknown>;
}

async function policyRow(serverId: string, source: string) {
  const { rows } = await admin.query(
    `select desired_revision, desired_baseline, desired_level, desired_deadline,
            effective_revision, effective_level, effective_baseline, effective_error,
            effective_pending
       from server_log_policy where server_id = $1 and source = $2`,
    [serverId, source],
  );
  return rows[0] as Record<string, unknown> | undefined;
}

const ack = (
  source: "agent" | "sing-box",
  sourceRevision: number,
  overrides: Partial<LogPolicyAckPayload> = {},
): LogPolicyAckPayload => ({
  source,
  sourceRevision,
  requested: "warn",
  baseline: "info",
  effective: "warn",
  deadline: null,
  error: null,
  pending: false,
  ...overrides,
});

describe.skipIf(!pgUrl).each(drivers)("server log policy on %s", (driver) => {
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
         delete from plan; delete from node; delete from server_log_policy; delete from server;
         delete from "user";`,
    );
    await admin.query(
      `insert into server(id,name,address,agent_token_hash,agent_token_prefix,
                            desired_revision_seq,applied_revision_seq,applied_revision)
         values ('srv1','srv1','192.0.2.1','srv1-hash','srv1-pre',8,6,
                 '6:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')`,
    );
  });

  it("compare-and-swaps the server revision and rejects a stale edit", async () => {
    const first = await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "warn",
        level: "warn",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    expect(first).toEqual({ revision: 1 });

    const conflict = await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "error",
        level: "error",
        deadline: null,
        actorId: "admin-2",
        expectedRevision: 0,
      },
      database,
    );
    expect(conflict).toBeNull();
    expect(await policyRow("srv1", "agent")).toMatchObject({
      desired_revision: 1,
      desired_baseline: "warn",
      desired_level: "warn",
    });

    const second = await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "sing-box",
        baseline: "info",
        level: "debug",
        deadline: new Date(Date.now() + 900_000),
        actorId: "admin-1",
        expectedRevision: 1,
      },
      database,
    );
    expect(second).toEqual({ revision: 2 });
    expect(await policyRow("srv1", "agent")).toMatchObject({
      desired_revision: 1,
    });
    expect(await policyRow("srv1", "sing-box")).toMatchObject({
      desired_revision: 2,
      desired_level: "debug",
    });
  });

  it("normalizes an expired override for the wire and keeps the raw intent visible", async () => {
    const expiredDeadline = new Date(Date.now() - 1_000);
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "sing-box",
        baseline: "info",
        level: "trace",
        deadline: expiredDeadline,
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    const session = await startAgentWsSession("srv1", database);
    const snapshot = await loadAgentLogPolicySnapshot(
      "srv1",
      session.sessionId,
      database,
    );
    expect(
      snapshot?.sources.find((source) => source.source === "sing-box"),
    ).toMatchObject({
      revision: 1,
      baseline: "info",
      level: "default",
      deadline: null,
    });
    await recordAgentLogPolicyAck(
      "srv1",
      session.sessionId,
      ack("sing-box", 1, {
        requested: "trace",
        effective: "debug",
        baseline: "info",
        deadline: expiredDeadline.toISOString(),
        pending: true,
      }),
      database,
    );

    const view = await readServerLogPolicy("srv1", database);
    expect(view?.sources["sing-box"]).toMatchObject({
      desiredLevel: "trace",
      expired: true,
      targetLevel: "info",
      effectiveLevel: "debug",
      effectiveBaseline: "info",
      pending: true,
    });
  });

  it("keeps a warn baseline through a debug override, offline expiry and a fresh agent", async () => {
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "warn",
        level: "warn",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    const deadline = new Date(Date.now() + 900_000);
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "warn",
        level: "debug",
        deadline,
        actorId: "admin-1",
        expectedRevision: 1,
      },
      database,
    );
    expect(await policyRow("srv1", "agent")).toMatchObject({
      desired_revision: 2,
      desired_baseline: "warn",
      desired_level: "debug",
    });

    // The first agent disconnects before the deadline and reconnects after it.
    const offline = await startAgentWsSession("srv1", database);
    const expired = await loadAgentLogPolicySnapshot(
      "srv1",
      offline.sessionId,
      database,
      new Date(deadline.getTime() + 1_000),
    );
    expect(
      expired?.sources.find((source) => source.source === "agent"),
    ).toMatchObject({
      revision: 2,
      baseline: "warn",
      level: "default",
      deadline: null,
    });
    expect(expired?.revision).toBe(2);

    // A newly enrolled agent sees the same baseline even though the override
    // expired while no agent was connected.
    const fresh = await startAgentWsSession("srv1", database);
    const freshSnapshot = await loadAgentLogPolicySnapshot(
      "srv1",
      fresh.sessionId,
      database,
      new Date(deadline.getTime() + 2_000),
    );
    expect(freshSnapshot?.sources).toEqual(expired?.sources);
    await expect(
      recordAgentLogPolicyAck(
        "srv1",
        fresh.sessionId,
        ack("agent", 2, {
          requested: "default",
          baseline: "warn",
          effective: "warn",
          pending: false,
        }),
        database,
      ),
    ).resolves.toBe("recorded");
    expect(await policyRow("srv1", "agent")).toMatchObject({
      desired_baseline: "warn",
      effective_revision: 2,
      effective_level: "warn",
      effective_baseline: "warn",
    });
  });

  it("distinguishes Restore now from restoring the installed default", async () => {
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "sing-box",
        baseline: "warn",
        level: "warn",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "sing-box",
        baseline: "warn",
        level: "debug",
        deadline: new Date(Date.now() + 900_000),
        actorId: "admin-1",
        expectedRevision: 1,
      },
      database,
    );

    expect(
      await restoreServerLogPolicy(
        {
          serverId: "srv1",
          source: "sing-box",
          mode: "restore-baseline",
          actorId: "admin-1",
          expectedRevision: 2,
        },
        database,
      ),
    ).toEqual({ revision: 3 });
    expect(await policyRow("srv1", "sing-box")).toMatchObject({
      desired_baseline: "warn",
      desired_level: "warn",
      desired_deadline: null,
    });
    let view = await readServerLogPolicy("srv1", database);
    expect(view?.sources["sing-box"]).toMatchObject({
      desiredBaseline: "warn",
      targetLevel: "warn",
      expired: false,
    });

    expect(
      await restoreServerLogPolicy(
        {
          serverId: "srv1",
          source: "sing-box",
          mode: "restore-default",
          actorId: "admin-1",
          expectedRevision: 3,
        },
        database,
      ),
    ).toEqual({ revision: 4 });
    expect(await policyRow("srv1", "sing-box")).toMatchObject({
      desired_baseline: "default",
      desired_level: "default",
      desired_deadline: null,
    });
    const session = await startAgentWsSession("srv1", database);
    await expect(
      recordAgentLogPolicyAck(
        "srv1",
        session.sessionId,
        ack("sing-box", 4, {
          requested: "default",
          effective: "info",
          baseline: "info",
          pending: false,
        }),
        database,
      ),
    ).resolves.toBe("recorded");
    view = await readServerLogPolicy("srv1", database);
    expect(view?.sources["sing-box"]).toMatchObject({
      desiredBaseline: "default",
      targetLevel: "default",
      effectiveLevel: "info",
      pending: false,
    });
  });

  it("keeps temporary overrides independent per source", async () => {
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "warn",
        level: "warn",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "sing-box",
        baseline: "error",
        level: "error",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 1,
      },
      database,
    );
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "warn",
        level: "trace",
        deadline: new Date(Date.now() + 900_000),
        actorId: "admin-1",
        expectedRevision: 2,
      },
      database,
    );

    const view = await readServerLogPolicy("srv1", database);
    expect(view?.sources.agent).toMatchObject({
      desiredBaseline: "warn",
      desiredLevel: "trace",
      targetLevel: "trace",
    });
    expect(view?.sources["sing-box"]).toMatchObject({
      desiredRevision: 2,
      desiredBaseline: "error",
      desiredLevel: "error",
      targetLevel: "error",
    });
  });

  it("records only the current revision and session, and ignores a stale ack", async () => {
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "warn",
        level: "warn",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    const old = await startAgentWsSession("srv1", database);
    await expect(
      recordAgentLogPolicyAck(
        "srv1",
        old.sessionId,
        ack("agent", 0, {
          requested: "default",
          effective: "info",
          pending: true,
        }),
        database,
      ),
    ).resolves.toBe("stale");
    await expect(
      recordAgentLogPolicyAck("srv1", old.sessionId, ack("agent", 1), database),
    ).resolves.toBe("recorded");
    expect(await policyRow("srv1", "agent")).toMatchObject({
      effective_revision: 1,
      effective_level: "warn",
    });

    const current = await startAgentWsSession("srv1", database);
    await expect(
      recordAgentLogPolicyAck("srv1", old.sessionId, ack("agent", 1), database),
    ).resolves.toBe("replaced");
    await expect(
      recordAgentLogPolicyAck(
        "srv1",
        current.sessionId,
        ack("agent", 1),
        database,
      ),
    ).resolves.toBe("recorded");
  });

  it("records the implicit revision zero acknowledgement on first contact", async () => {
    const session = await startAgentWsSession("srv1", database);
    await expect(
      recordAgentLogPolicyAck(
        "srv1",
        session.sessionId,
        ack("agent", 0, {
          requested: "default",
          effective: "info",
          baseline: "info",
          pending: false,
        }),
        database,
      ),
    ).resolves.toBe("recorded");
    expect(await policyRow("srv1", "agent")).toMatchObject({
      desired_revision: 0,
      desired_level: "default",
      effective_revision: 0,
      effective_level: "info",
      effective_baseline: "info",
    });
  });

  it("reports a failed apply without exposing log data", async () => {
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "sing-box",
        baseline: "info",
        level: "debug",
        deadline: new Date(Date.now() + 900_000),
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    const session = await startAgentWsSession("srv1", database);
    const failed = ack("sing-box", 1, {
      requested: "debug",
      effective: "info",
      deadline: new Date(Date.now() + 900_000).toISOString(),
      error: "sing-box check rejected the candidate",
      pending: true,
    });
    await expect(
      recordAgentLogPolicyAck("srv1", session.sessionId, failed, database),
    ).resolves.toBe("recorded");
    expect(await policyRow("srv1", "sing-box")).toMatchObject({
      desired_level: "debug",
      effective_level: "info",
      effective_error: "sing-box check rejected the candidate",
      effective_pending: true,
    });
    const view = await readServerLogPolicy("srv1", database);
    expect(view?.sources["sing-box"].effectiveError).toBe(
      "sing-box check rejected the candidate",
    );
  });

  it("moves the snapshot revision after a lost push and a reconnect", async () => {
    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "warn",
        level: "warn",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 0,
      },
      database,
    );
    const first = await startAgentWsSession("srv1", database);
    expect(
      await loadAgentLogPolicySnapshot("srv1", first.sessionId, database),
    ).toMatchObject({ revision: 1 });

    await writeServerLogPolicy(
      {
        serverId: "srv1",
        source: "agent",
        baseline: "error",
        level: "error",
        deadline: null,
        actorId: "admin-1",
        expectedRevision: 1,
      },
      database,
    );
    const reconnected = await startAgentWsSession("srv1", database);
    const snapshot = await loadAgentLogPolicySnapshot(
      "srv1",
      reconnected.sessionId,
      database,
    );
    expect(snapshot).toMatchObject({ revision: 2 });
    expect(
      snapshot?.sources.find((source) => source.source === "agent"),
    ).toMatchObject({ revision: 2, level: "error" });
    expect(await serverRow("srv1")).toMatchObject({ log_policy_revision: 2 });
  });
});
