/**
 * Applies the ordered-membership migration to a database that already has
 * legacy `node_group` rows, which is the case a fresh-schema test cannot
 * reproduce. Skipped unless BLOSSOM_TEST_PG_URL names a disposable loopback
 * database (`blossom_disposable_*`).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;
const TARGET = "20261120105128_group_membership_order";
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

describe.skipIf(!PG_URL)("ordered membership migration backfill", () => {
  const pool = PG_URL ? new Pool({ connectionString: PG_URL }) : null;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    await pool!.query(
      `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`,
    );
    for (const folder of folders.filter((name) => name < TARGET)) {
      await apply(pool!, folder);
    }

    // Legacy rows: node_group had no position, proxy_group had no revision.
    await pool!.query(`
      INSERT INTO server (id, name, address, agent_token_hash)
      VALUES ('srv-legacy', 'legacy', 'legacy.example.test', 'fake-hash');
      INSERT INTO proxy_group (id, name, sort_order)
      VALUES ('g-legacy', 'Legacy', 0), ('g-empty', 'Empty', 1);
      INSERT INTO node (id, name, server_id, listen_port, protocol, settings)
      VALUES ('n-z', 'z', 'srv-legacy', 10001, 'trojan', '{}'),
             ('n-a', 'a', 'srv-legacy', 10002, 'trojan', '{}'),
             ('n-m', 'm', 'srv-legacy', 10003, 'trojan', '{}');
      INSERT INTO node_group (node_id, group_id)
      VALUES ('n-z', 'g-legacy'), ('n-a', 'g-legacy'), ('n-m', 'g-legacy');
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("backfills contiguous positions by stable node id before adding the deferrable constraint", async () => {
    await apply(pool!, TARGET);

    const members = await pool!.query(
      `SELECT node_id, position FROM node_group
       WHERE group_id = 'g-legacy' ORDER BY position, node_id`,
    );
    expect(members.rows).toEqual([
      { node_id: "n-a", position: 0 },
      { node_id: "n-m", position: 1 },
      { node_id: "n-z", position: 2 },
    ]);

    const groups = await pool!.query(
      `SELECT id, revision FROM proxy_group ORDER BY id`,
    );
    expect(groups.rows).toEqual([
      { id: "g-empty", revision: 1 },
      { id: "g-legacy", revision: 1 },
    ]);

    const constraint = await pool!.query(
      `SELECT condeferrable, condeferred FROM pg_constraint
       WHERE conname = 'node_group_group_position_unique'`,
    );
    expect(constraint.rows).toEqual([
      { condeferrable: true, condeferred: false },
    ]);
  });

  it("allows a row-set position swap in one statement and rejects a duplicate after it", async () => {
    await pool!.query(
      `UPDATE node_group SET position = 2 - position WHERE group_id = 'g-legacy'`,
    );
    const swapped = await pool!.query(
      `SELECT node_id, position FROM node_group
       WHERE group_id = 'g-legacy' ORDER BY position`,
    );
    expect(swapped.rows).toEqual([
      { node_id: "n-z", position: 0 },
      { node_id: "n-m", position: 1 },
      { node_id: "n-a", position: 2 },
    ]);

    await expect(
      pool!.query(
        `UPDATE node_group SET position = 0 WHERE group_id = 'g-legacy' AND node_id = 'n-m'`,
      ),
    ).rejects.toThrow(/node_group_group_position_unique/);
  });
});
