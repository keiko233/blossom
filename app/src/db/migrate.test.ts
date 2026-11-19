import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  collectLocalMigrations,
  findMissingMigrationHashes,
  formatTarget,
  parseDatabaseTarget,
  parseHyperdriveGetOutput,
  shouldVerifyHyperdrive,
  stripJsonc,
  targetsMatch,
  verifyHyperdriveAlignment,
} from "../../scripts/db-migrate.mjs";

describe("db-migrate helpers", () => {
  it("parses wrangler.jsonc with comments and trailing commas", () => {
    const raw = fs.readFileSync(
      path.resolve(import.meta.dirname, "../../wrangler.jsonc"),
      "utf8",
    );
    const parsed = JSON.parse(stripJsonc(raw));
    expect(parsed.hyperdrive?.[0]?.id).toBeTypeOf("string");
  });

  it("parses PostgreSQL connection strings without leaking passwords", () => {
    const target = parseDatabaseTarget(
      "postgresql://u_test:secret-password@blossom-xzmn78-pooler.db.enzonic.com:5432/main?sslmode=require",
    );
    expect(target).toEqual({
      host: "blossom-xzmn78-pooler.db.enzonic.com",
      port: 5432,
      database: "main",
      user: "u_test",
    });
    expect(formatTarget(target)).toBe(
      "u_test@blossom-xzmn78-pooler.db.enzonic.com:5432/main",
    );
  });

  it("rejects empty or non-postgres DATABASE_URL values", () => {
    expect(() => parseDatabaseTarget("")).toThrow(/DATABASE_URL is required/);
    expect(() => parseDatabaseTarget("mysql://user:pw@host/db")).toThrow(
      /postgres/,
    );
  });

  it("matches direct and pooler hostnames on the same cluster while rejecting other databases", () => {
    const origin = {
      host: "blossom-xzmn78-pooler.db.enzonic.com",
      port: 5432,
      database: "main",
      user: "u_test",
    };

    expect(
      targetsMatch(
        parseDatabaseTarget(
          "postgresql://u_test:pw@blossom-xzmn78.db.enzonic.com:5432/main",
        ),
        origin,
      ),
    ).toBe(true);

    expect(
      targetsMatch(
        parseDatabaseTarget(
          "postgresql://u_test:pw@ep-old-db.us-east-2.aws.neon.tech:5432/neondb",
        ),
        origin,
      ),
    ).toBe(false);
  });

  it("parses wrangler hyperdrive get output with leading banner lines", () => {
    const parsed = parseHyperdriveGetOutput(`
 ⛅️ wrangler 4.164.0
───────────────────────────────────────────────
{
  "id": "hd-123",
  "origin": {
    "host": "db.example.com",
    "port": 5432,
    "database": "main",
    "user": "u_test"
  }
}
`);
    expect(parsed.origin.host).toBe("db.example.com");
  });

  it("blocks migration when DATABASE_URL disagrees with Hyperdrive origin", () => {
    const appDir = path.resolve(import.meta.dirname, "../..");
    const wrongTarget = parseDatabaseTarget(
      "postgresql://old_user:pw@old-db.neon.tech:5432/neondb",
    );

    expect(() =>
      verifyHyperdriveAlignment({
        appDir,
        databaseTarget: wrongTarget,
        runWrangler: () =>
          JSON.stringify({
            id: "8d00a6bf46b24b74a1c833dc992e3ef5",
            origin: {
              host: "blossom-xzmn78-pooler.db.enzonic.com",
              port: 5432,
              database: "main",
              user: "u_9hgm7wzvfx",
            },
          }),
      }),
    ).toThrow(/does not match Cloudflare Hyperdrive binding/);
  });

  it("allows migration when DATABASE_URL matches Hyperdrive origin", () => {
    const appDir = path.resolve(import.meta.dirname, "../..");
    const rightTarget = parseDatabaseTarget(
      "postgresql://u_9hgm7wzvfx:pw@blossom-xzmn78-pooler.db.enzonic.com:5432/main?sslmode=require",
    );

    expect(() =>
      verifyHyperdriveAlignment({
        appDir,
        databaseTarget: rightTarget,
        runWrangler: () =>
          JSON.stringify({
            id: "8d00a6bf46b24b74a1c833dc992e3ef5",
            origin: {
              host: "blossom-xzmn78-pooler.db.enzonic.com",
              port: 5432,
              database: "main",
              user: "u_9hgm7wzvfx",
            },
          }),
      }),
    ).not.toThrow();
  });

  it("only enables Hyperdrive verification in Workers CI / token environments unless skipped", () => {
    expect(shouldVerifyHyperdrive({})).toBe(false);
    expect(shouldVerifyHyperdrive({ WORKERS_CI: "1" })).toBe(true);
    expect(shouldVerifyHyperdrive({ CLOUDFLARE_API_TOKEN: "tok" })).toBe(true);
    expect(
      shouldVerifyHyperdrive({
        WORKERS_CI: "1",
        SKIP_HYPERDRIVE_CHECK: "1",
      }),
    ).toBe(false);
  });

  it("detects unapplied local migration hashes", () => {
    const local = collectLocalMigrations(
      path.resolve(import.meta.dirname, "../../drizzle"),
    );
    expect(local.length).toBeGreaterThan(0);

    const missingOne = findMissingMigrationHashes(
      local,
      new Set(local.slice(0, -1).map((m) => m.hash)),
    );
    expect(missingOne).toEqual([local.at(-1)]);
  });
});
