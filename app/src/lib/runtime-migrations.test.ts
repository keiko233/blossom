import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  collectBundledMigrations,
  findPendingMigrations,
  parseMigrationFolderMillis,
  runBundledMigrations,
  splitMigrationStatements,
} from "@/lib/runtime-migrations";

import { collectLocalMigrations } from "../../scripts/db-migrate.mjs";

describe("runtime migrations", () => {
  it("bundles the exact same migration names and hashes as db-migrate.mjs", () => {
    const bundled = collectBundledMigrations();
    const local = collectLocalMigrations(
      path.resolve(import.meta.dirname, "../../drizzle"),
    );

    expect(bundled.length).toBeGreaterThan(0);
    expect(bundled.map((m) => ({ name: m.name, hash: m.hash }))).toEqual(local);
  });

  it("parses folder timestamps and splits statement breakpoints", () => {
    expect(parseMigrationFolderMillis("20261119115347_late_ken_ellis")).toBe(
      Date.UTC(2026, 10, 19, 11, 53, 47),
    );
    expect(
      splitMigrationStatements(
        "CREATE TABLE a (id int);\n--> statement-breakpoint\n\nCREATE TABLE b (id int);\n--> statement-breakpoint\n",
      ),
    ).toEqual(["CREATE TABLE a (id int);", "CREATE TABLE b (id int);"]);
  });

  it("filters out already-applied migrations by name or legacy hash", () => {
    const migrations = collectBundledMigrations({
      "../../drizzle/20260101000000_first/migration.sql": "SELECT 1;",
      "../../drizzle/20260102000000_second/migration.sql": "SELECT 2;",
      "../../drizzle/20260103000000_third/migration.sql": "SELECT 3;",
    });

    const pending = findPendingMigrations(migrations, [
      { name: "20260101000000_first", hash: "different-hash" },
      { name: null, hash: migrations[1].hash },
    ]);

    expect(pending.map((m) => m.name)).toEqual(["20260103000000_third"]);
  });

  it("acquires a transaction-scoped advisory lock and runs only pending migrations", async () => {
    const migrations = collectBundledMigrations({
      "../../drizzle/20260101000000_first/migration.sql": "SELECT 1;",
      "../../drizzle/20260102000000_second/migration.sql":
        "SELECT 2;\n--> statement-breakpoint\nSELECT 3;",
    });

    const executed: string[] = [];
    const mockExecutor = {
      execute: vi.fn(async (query: { queryChunks?: unknown[] }) => {
        const text = JSON.stringify(query);
        executed.push(text);
        if (
          text.includes(
            'SELECT hash, name FROM \\"drizzle\\".\\"__drizzle_migrations\\"',
          )
        ) {
          return {
            rows: [{ name: "20260101000000_first", hash: migrations[0].hash }],
          };
        }
        return { rows: [] };
      }),
    };
    const mockDb = {
      execute: mockExecutor.execute,
      transaction: vi.fn(
        async (fn: (tx: typeof mockExecutor) => Promise<unknown>) =>
          fn(mockExecutor),
      ),
    };

    const result = await runBundledMigrations({
      database: mockDb as never,
      interactiveTransactions: true,
      migrations,
    });

    expect(result).toEqual({
      total: 2,
      applied: ["20260102000000_second"],
      skipped: 1,
    });
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    expect(
      executed.some((entry) => entry.includes("pg_advisory_xact_lock")),
    ).toBe(true);
    expect(executed.some((entry) => entry.includes("SELECT 2;"))).toBe(true);
    expect(executed.some((entry) => entry.includes("SELECT 3;"))).toBe(true);
    expect(executed.some((entry) => entry.includes("SELECT 1;"))).toBe(false);
  });
});
