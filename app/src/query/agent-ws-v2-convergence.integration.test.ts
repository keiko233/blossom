/**
 * Agent WebSocket v2 convergence against a real PostgreSQL through each driver:
 * a real session, the real store adapter and the real desired-state compiler.
 * A routing-rule change is the input under test. It has no publish-gate record,
 * so a missed invalidation or notification must be recovered by the status
 * exchange, and only within the cached identifier's deadline.
 *
 * Skipped unless `BLOSSOM_TEST_DATABASE_URL` points at a DISPOSABLE database
 * with the migrations applied. Its name must begin with `blossom_test`, and
 * BLOSSOM_TEST_CONFIRM_DISPOSABLE must be `yes`. The neon-http driver runs too
 * when `BLOSSOM_TEST_NEON_HTTP_URL` and `BLOSSOM_TEST_NEON_HTTP_ENDPOINT` are
 * set. Run with `vitest run --no-file-parallelism`, since the disposable
 * suites share one database.
 */
import {
  AGENT_WS_V2_LIMITS,
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2HelloPayload,
  type AgentWsV2StatusPayload,
} from "@blossom/contracts/agent-ws-v2";
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
      "Agent v2 convergence tests require explicit disposable database confirmation",
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
        "Agent v2 convergence tests require a database named blossom_test*",
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

import { createAgentWsV2Store } from "@/lib/agent-ws-store";
import {
  openAgentWsV2Session,
  type AgentWsV2Peer,
} from "@/lib/agent-ws-v2-session";
import {
  invalidateDesiredConfigRevisions,
  rotateAgentCredential,
} from "@/query/agent";

type Driver = "node-postgres" | "neon-http";
const drivers: Driver[] = ["node-postgres"];
if (pgUrl && neonUrl && neonEndpoint) drivers.push("neon-http");

const admin = new pg.Pool({ connectionString: pgUrl, max: 4 });
afterAll(async () => {
  await admin.end();
});

const TOKEN_HASH = "srv1-hash";
const STATUS: AgentWsV2StatusPayload = {
  reason: "interval",
  runtimeState: "running",
  certificateDeployments: [],
};
const HELLO: AgentWsV2HelloPayload = {
  agentVersion: "0.4.0",
  agentBuildId: "build-1",
  capabilities: ["config-v3"],
  applied: null,
  certificateDeployments: [],
};

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

/** Frames the control plane sent on a fake socket, parsed and validated. */
function received(peer: { sent: string[] }) {
  return peer.sent.map((text) => {
    const parsed = parseAgentWsV2Frame(text, "control-plane");
    if (!parsed.ok) throw new Error(`invalid outgoing frame: ${parsed.code}`);
    return parsed.message;
  });
}

function agentText(type: string, payload: unknown, id?: string): string {
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame(type as never, payload as never, {
      ...(id ? { id } : {}),
      ts: "2026-11-19T00:00:00.000Z",
    }),
  );
}

function makePeer() {
  const sent: string[] = [];
  return {
    sent,
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
    close: vi.fn(),
  } satisfies AgentWsV2Peer & { sent: string[] };
}

async function row(serverId: string) {
  const { rows } = await admin.query(
    `select desired_config_revision, desired_inputs_version, ws_session_id
       from server where id = $1`,
    [serverId],
  );
  return rows[0] as Record<string, unknown>;
}

/** The identifier the status acknowledgement carried, or `undefined`. */
function ackedRevision(peer: { sent: string[] }): string | undefined {
  const last = received(peer).at(-1);
  if (last?.kind !== "agent.status.ack") return undefined;
  return last.payload.desired.desiredRevision;
}

describe.skipIf(!pgUrl).each(drivers)(
  "agent WebSocket v2 convergence on %s",
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
         delete from plan; delete from node; delete from routing_rule;
         delete from server; delete from "user";`,
      );
      await admin.query(
        `insert into server(id,name,address,agent_token_hash,agent_token_prefix,
                            enabled,desired_revision_seq,applied_revision_seq)
         values ('srv1','srv1','192.0.2.1',$1,'srv1-pre',true,8,8)`,
        [TOKEN_HASH],
      );
    });

    /** Opens a v2 session the way the hub does: start, then the frame loop. */
    async function openSession() {
      const store = createAgentWsV2Store(database);
      const started = await store.startSession("srv1", TOKEN_HASH);
      if (!started) throw new Error("session did not start");
      const peer = makePeer();
      const session = openAgentWsV2Session({
        serverId: "srv1",
        sessionId: started.sessionId,
        peer,
        store,
      });
      return { session, peer, sessionId: started.sessionId, store };
    }

    /** A routing rule that changes the compiled configuration, with no record. */
    async function addServerRule(id: string) {
      await admin.query(
        `insert into routing_rule(id,name,enabled,sort_order,match_type,values,action,scope)
         values ($1,$1,true,0,'domain_suffix',array['example.com'],'reject','server')`,
        [id],
      );
    }

    it("recovers a missed change on the status exchange once the cached identifier ages out", async () => {
      const { session, peer } = await openSession();
      await session.handleText(agentText("hello", HELLO, "hello-1"));
      const first = received(peer).find((m) => m.kind === "welcome");
      if (first?.kind !== "welcome") throw new Error("no welcome");
      const before = first.payload.desired.desiredRevision;

      // The change lands with no notification and no invalidation.
      await addServerRule("r-missed");

      // Inside the deadline the cached identifier is still served, which is the
      // bound the guide promises for changes that were never signalled.
      await session.handleText(agentText("agent.status", STATUS, "status-1"));
      expect(ackedRevision(peer)).toBe(before);

      // Once the deadline has passed, the same exchange reports the change.
      await admin.query(
        `update server set desired_config_valid_until = '2000-01-01T00:00:00Z'
          where id = 'srv1'`,
      );
      await session.handleText(agentText("agent.status", STATUS, "status-2"));
      const after = ackedRevision(peer);
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
      expect(after!.startsWith("8:sha256:")).toBe(true);
    });

    it("reports an invalidated change on the very next status, without waiting for the deadline", async () => {
      const { session, peer } = await openSession();
      await session.handleText(agentText("hello", HELLO, "hello-1"));
      const welcome = received(peer).find((m) => m.kind === "welcome");
      if (welcome?.kind !== "welcome") throw new Error("no welcome");
      const before = welcome.payload.desired.desiredRevision;

      await addServerRule("r-invalidated");
      await invalidateDesiredConfigRevisions(["srv1"], database);
      expect(await row("srv1")).toMatchObject({
        desired_config_revision: null,
        desired_inputs_version: 1,
      });

      await session.handleText(agentText("agent.status", STATUS, "status-1"));
      const after = ackedRevision(peer);
      expect(after).toBeDefined();
      expect(after).not.toBe(before);
      expect(await row("srv1")).toMatchObject({
        desired_config_revision: after,
      });
    });

    it("stops a session whose credential was rotated, before it reads or sends configuration", async () => {
      const { session, peer } = await openSession();
      await session.handleText(agentText("hello", HELLO, "hello-1"));
      const sentBefore = peer.sent.length;

      await rotateAgentCredential(
        "srv1",
        { hash: "srv1-rotated-hash", prefix: "srv1-new" },
        database,
      );
      expect(await row("srv1")).toMatchObject({ ws_session_id: null });

      await session.handleText(
        agentText("config.get", { requestId: "snap-1", reason: "mismatch" }),
      );
      const frames = received(peer).slice(sentBefore);
      expect(frames.some((m) => m.kind === "config.snapshot.begin")).toBe(
        false,
      );
      expect(frames).toEqual([
        {
          kind: "error",
          payload: expect.objectContaining({ code: "session_replaced" }),
        },
      ]);
      expect(peer.close).toHaveBeenCalledWith(4000, "session_replaced");
    });

    it("stops a session on its next status once the server is disabled, and serves no snapshot", async () => {
      const { session, peer } = await openSession();
      await session.handleText(agentText("hello", HELLO, "hello-1"));
      await admin.query(`update server set enabled = false where id = 'srv1'`);

      await session.handleText(
        agentText("config.get", { requestId: "snap-d", reason: "notify" }),
      );
      expect(
        received(peer).some((m) => m.kind === "config.snapshot.begin"),
      ).toBe(false);
      expect(peer.close).toHaveBeenCalledWith(4000, "server_disabled");
    });

    it("serves a snapshot that verifies against the authoritative identifier", async () => {
      const { session, peer } = await openSession();
      await session.handleText(agentText("hello", HELLO, "hello-1"));
      await addServerRule("r-snapshot");
      await invalidateDesiredConfigRevisions(["srv1"], database);

      await session.handleText(
        agentText("config.get", { requestId: "snap-ok", reason: "mismatch" }),
      );
      const begin = received(peer).find(
        (m) => m.kind === "config.snapshot.begin",
      );
      if (begin?.kind !== "config.snapshot.begin") throw new Error("no begin");
      expect(begin.payload.totalBytes).toBeLessThanOrEqual(
        AGENT_WS_V2_LIMITS.maxSnapshotBytes,
      );
      expect(begin.payload.desired.desiredRevisionSeq).toBe(8);
      expect(await row("srv1")).toMatchObject({
        desired_config_revision: begin.payload.desired.desiredRevision,
      });
    });
  },
);
