/**
 * Applies the managed networking migrations to a database that already has
 * legacy nodes, then checks the listener-claim trigger and the immutable
 * config version. Skipped unless BLOSSOM_TEST_PG_URL names a disposable
 * loopback database (`blossom_disposable_*`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;
const FIRST = "20261120121044_managed_networking_foundation";
const MIGRATIONS = fileURLToPath(new URL("../../drizzle/", import.meta.url));

function assertDisposable(raw: string) {
  const url = new URL(raw);
  const loopback = ["127.0.0.1", "localhost", "[::1]", "::1"];
  const dbName = decodeURIComponent(url.pathname.slice(1));
  if (
    !loopback.includes(url.hostname) ||
    !dbName.startsWith("blossom_disposable_")
  ) {
    throw new Error(
      "BLOSSOM_TEST_PG_URL must be a loopback database named blossom_disposable_*",
    );
  }
}

async function apply(pool: Pool, folder: string) {
  const sqlText = readFileSync(`${MIGRATIONS}${folder}/migration.sql`, "utf8");
  for (const statement of sqlText.split("--> statement-breakpoint")) {
    if (statement.trim()) await pool.query(statement);
  }
}

const folders = readdirSync(MIGRATIONS)
  .filter((entry) => !entry.endsWith(".json"))
  .sort();

async function claims(pool: Pool) {
  const result = await pool.query(
    `SELECT server_id, port, owner_kind, owner_id FROM listener_claim
     ORDER BY server_id, port`,
  );
  return result.rows;
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    const { code, constraint } = error as {
      code?: string;
      constraint?: string;
    };
    return { code, constraint };
  }
  throw new Error("expected the statement to fail");
}

describe.skipIf(!PG_URL)("managed networking migrations", () => {
  const pool = PG_URL ? new Pool({ connectionString: PG_URL }) : null;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    await pool!.query(
      `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`,
    );
    for (const folder of folders.filter((name) => name < FIRST)) {
      await apply(pool!, folder);
    }
    await pool!.query(`
      INSERT INTO server (id, name, address)
      VALUES ('srv-a', 'a', 'a.example.test'), ('srv-b', 'b', 'b.example.test');
      INSERT INTO node (id, name, server_id, listen_port, protocol, settings)
      VALUES ('n-1', 'one', 'srv-a', 10001, 'trojan', '{}'),
             ('n-2', 'two', 'srv-a', 10002, 'trojan', '{}'),
             ('n-3', 'three', 'srv-b', 10001, 'trojan', '{}');
    `);
    for (const folder of folders.filter((name) => name >= FIRST)) {
      await apply(pool!, folder);
    }
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("seeds the topology fence and backfills subscriber claims", async () => {
    const topology = await pool!.query(
      `SELECT id, generation FROM managed_topology`,
    );
    expect(topology.rows).toEqual([{ id: "global", generation: 0 }]);
    expect(await claims(pool!)).toEqual([
      {
        server_id: "srv-a",
        port: 10001,
        owner_kind: "subscriber_inbound",
        owner_id: "n-1",
      },
      {
        server_id: "srv-a",
        port: 10002,
        owner_kind: "subscriber_inbound",
        owner_id: "n-2",
      },
      {
        server_id: "srv-b",
        port: 10001,
        owner_kind: "subscriber_inbound",
        owner_id: "n-3",
      },
    ]);
  });

  it("keeps subscriber claims in step with every node write", async () => {
    await pool!.query(`
      INSERT INTO node (id, name, server_id, listen_port, protocol, settings)
      VALUES ('n-4', 'four', 'srv-b', 10004, 'trojan', '{}');
      UPDATE node SET listen_port = 10005 WHERE id = 'n-2';
      UPDATE node SET server_id = 'srv-b', listen_port = 10006 WHERE id = 'n-1';
      UPDATE node SET name = 'renamed', enabled = false WHERE id = 'n-3';
      DELETE FROM node WHERE id = 'n-4';
    `);
    expect(await claims(pool!)).toEqual([
      {
        server_id: "srv-a",
        port: 10005,
        owner_kind: "subscriber_inbound",
        owner_id: "n-2",
      },
      {
        server_id: "srv-b",
        port: 10001,
        owner_kind: "subscriber_inbound",
        owner_id: "n-3",
      },
      {
        server_id: "srv-b",
        port: 10006,
        owner_kind: "subscriber_inbound",
        owner_id: "n-1",
      },
    ]);
  });

  it("keeps the legacy port conflict and rejects a port held by a peer claim", async () => {
    expect(
      await failure(
        pool!
          .query(`INSERT INTO node (id, name, server_id, listen_port, protocol, settings)
          VALUES ('n-dup', 'dup', 'srv-b', 10001, 'trojan', '{}')`),
      ),
    ).toEqual({ code: "23505", constraint: "node_server_listen_port_unique" });

    await pool!
      .query(`INSERT INTO listener_claim (server_id, port, owner_kind, owner_id)
      VALUES ('srv-a', 20000, 'peer_inbound', 'peer-1')`);
    expect(
      await failure(
        pool!
          .query(`INSERT INTO node (id, name, server_id, listen_port, protocol, settings)
          VALUES ('n-peer', 'peer', 'srv-a', 20000, 'trojan', '{}')`),
      ),
    ).toEqual({ code: "23505", constraint: "listener_claim_pkey" });
    expect(
      await failure(
        pool!.query(`UPDATE node SET listen_port = 20000 WHERE id = 'n-2'`),
      ),
    ).toEqual({ code: "23505", constraint: "listener_claim_pkey" });

    const nodes = await pool!.query(
      `SELECT id, listen_port FROM node WHERE server_id = 'srv-a' ORDER BY id`,
    );
    expect(nodes.rows).toEqual([{ id: "n-2", listen_port: 10005 }]);
    await pool!.query(
      `DELETE FROM listener_claim WHERE owner_kind = 'peer_inbound'`,
    );
  });

  it("rejects updates to an immutable config version but allows pruning", async () => {
    await pool!.query(`INSERT INTO managed_config_version
      (id, server_id, version, schema_version, intent, intent_digest)
      VALUES ('cv-1', 'srv-a', 1, 1, '{}', 'sha256:00')`);
    expect(
      await failure(
        pool!.query(
          `UPDATE managed_config_version SET intent_digest = 'sha256:ff' WHERE id = 'cv-1'`,
        ),
      ),
    ).toMatchObject({ code: "23001" });
    await pool!.query(`DELETE FROM managed_config_version WHERE id = 'cv-1'`);
  });

  it("pins a peer outbound to its link's source server", async () => {
    await pool!.query(`
      INSERT INTO managed_certificate (id, name, kind, domains)
      VALUES ('cert-1', 'peer', 'self_signed', '["b.example.test"]');
      INSERT INTO peer_inbound (id, server_id, name, runtime_tag, protocol,
        listen_address, listen_port, advertised_address, advertised_port,
        tls_server_name, certificate_id)
      VALUES ('pi-1', 'srv-b', 'transit', 'peer-in-pi-1', 'trojan', '::', 30000,
        'b.example.test', 30000, 'b.example.test', 'cert-1');
      INSERT INTO peer_link (id, source_server_id, destination_inbound_id)
      VALUES ('link-1', 'srv-a', 'pi-1');
    `);
    expect(
      await failure(
        pool!
          .query(`INSERT INTO managed_outbound (id, server_id, kind, name, runtime_tag, link_id)
          VALUES ('out-x', 'srv-b', 'peer_link', 'wrong', 'peer-out-x', 'link-1')`),
      ),
    ).toEqual({ code: "23503", constraint: "managed_outbound_link_source_fk" });
    expect(
      await failure(
        pool!
          .query(`INSERT INTO managed_outbound (id, server_id, kind, name, runtime_tag)
          VALUES ('out-y', 'srv-a', 'peer_link', 'missing', 'peer-out-y')`),
      ),
    ).toEqual({ code: "23514", constraint: "managed_outbound_kind_link" });
    await pool!
      .query(`INSERT INTO managed_outbound (id, server_id, kind, name, runtime_tag, link_id)
      VALUES ('out-1', 'srv-a', 'peer_link', 'to b', 'peer-out-link-1', 'link-1')`);
    expect(
      await failure(pool!.query(`DELETE FROM peer_inbound WHERE id = 'pi-1'`)),
    ).toMatchObject({ code: "23001" });
  });
});
