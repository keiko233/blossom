import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  collectLocalMigrations,
  findMissingMigrationHashes,
  formatTarget,
  isTransientDbError,
  parseDatabaseTarget,
  parseHyperdriveGetOutput,
  runDrizzleMigrate,
  shouldVerifyHyperdrive,
  stripJsonc,
  targetsMatch,
  verifyAppliedMigrations,
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

  it("identifies transient database connection errors and ignores permanent errors", () => {
    expect(isTransientDbError("Error: read ECONNRESET\nFailed query:")).toBe(
      true,
    );
    expect(
      isTransientDbError("Connection terminated unexpectedly during startup"),
    ).toBe(true);
    expect(
      isTransientDbError(
        Object.assign(new Error("reset"), { code: "ECONNRESET" }),
      ),
    ).toBe(true);
    expect(
      isTransientDbError(
        new Error("wrapper", {
          cause: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }),
        }),
      ),
    ).toBe(true);

    expect(isTransientDbError('ERROR: relation "users" already exists')).toBe(
      false,
    );
    expect(isTransientDbError("password authentication failed for user")).toBe(
      false,
    );
  });

  it("retries drizzle-kit migrate on transient ECONNRESET and succeeds", async () => {
    const appDir = path.resolve(import.meta.dirname, "../..");
    const sleepCalls: number[] = [];
    const warnings: string[] = [];
    let attempt = 0;

    const spawnImpl = vi.fn(() => {
      attempt += 1;
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        if (attempt === 1) {
          child.stderr.emit("data", Buffer.from("Error: read ECONNRESET\n"));
          child.emit("close", 1);
        } else {
          child.stdout.emit("data", Buffer.from("migrations applied\n"));
          child.emit("close", 0);
        }
      });
      return child;
    });

    const status = await runDrizzleMigrate({
      appDir,
      maxAttempts: 3,
      baseDelayMs: 50,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      spawnImpl: spawnImpl as never,
      logger: { warn: (msg: string) => warnings.push(msg) },
    });

    expect(status).toBe(0);
    expect(spawnImpl).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([50]);
    expect(warnings).toHaveLength(1);
  });

  it("does not retry drizzle-kit migrate on non-transient SQL errors", async () => {
    const appDir = path.resolve(import.meta.dirname, "../..");
    const sleepCalls: number[] = [];

    const spawnImpl = vi.fn(() => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();

      queueMicrotask(() => {
        child.stderr.emit(
          "data",
          Buffer.from('ERROR: syntax error at or near "FROM"\n'),
        );
        child.emit("close", 1);
      });
      return child;
    });

    const status = await runDrizzleMigrate({
      appDir,
      maxAttempts: 3,
      baseDelayMs: 50,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      spawnImpl: spawnImpl as never,
      logger: { warn: () => {} },
    });

    expect(status).toBe(1);
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    expect(sleepCalls).toEqual([]);
  });

  it("retries verifyAppliedMigrations on transient connection reset", async () => {
    const drizzleDir = path.resolve(import.meta.dirname, "../../drizzle");
    const local = collectLocalMigrations(drizzleDir);
    const sleepCalls: number[] = [];
    let attempt = 0;

    const createClient = vi.fn(() => {
      attempt += 1;
      const currentAttempt = attempt;
      return {
        connect: async () => {
          if (currentAttempt === 1) {
            throw Object.assign(new Error("read ECONNRESET"), {
              code: "ECONNRESET",
            });
          }
        },
        query: async () => ({
          rows: local.map((m) => ({ hash: m.hash })),
        }),
        end: async () => {},
      };
    });

    const verified = await verifyAppliedMigrations(
      "postgresql://u_test:pw@localhost:5432/main",
      drizzleDir,
      {
        maxAttempts: 3,
        baseDelayMs: 25,
        sleep: async (ms) => {
          sleepCalls.push(ms);
        },
        createClient: createClient as never,
        logger: { warn: () => {} },
      },
    );

    expect(verified).toEqual(local);
    expect(createClient).toHaveBeenCalledTimes(2);
    expect(sleepCalls).toEqual([25]);
  });
});
