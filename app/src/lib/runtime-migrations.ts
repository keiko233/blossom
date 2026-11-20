import { sql, type SQLWrapper } from "drizzle-orm";
import { createHash } from "node:crypto";

import { db, getDatabaseDriver, type Database } from "@/db";
import { supportsInteractiveTransactions } from "@/lib/env-schema";

export interface BundledMigration {
  name: string;
  hash: string;
  folderMillis: number;
  statements: string[];
}

export interface AppliedMigrationRow {
  hash: string;
  name: string | null;
}

export interface RuntimeMigrationResult {
  total: number;
  applied: string[];
  skipped: number;
}

const STATEMENT_BREAKPOINT = "--> statement-breakpoint";
const MIGRATION_LOCK_KEY = "blossom:drizzle_migrations";

const bundledSqlModules = import.meta.glob<string>(
  "../../drizzle/*/migration.sql",
  {
    query: "?raw",
    import: "default",
    eager: true,
  },
);

export function parseMigrationFolderMillis(name: string): number {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!match) {
    return 0;
  }
  return Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
}

export function splitMigrationStatements(rawSql: string): string[] {
  return rawSql
    .split(STATEMENT_BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

export function collectBundledMigrations(
  modules: Record<string, string> = bundledSqlModules,
): BundledMigration[] {
  const migrations: BundledMigration[] = [];

  for (const [modulePath, rawSql] of Object.entries(modules)) {
    const match = /\/([^/]+)\/migration\.sql$/.exec(modulePath);
    if (!match) {
      continue;
    }
    const name = match[1];
    migrations.push({
      name,
      hash: createHash("sha256").update(rawSql).digest("hex"),
      folderMillis: parseMigrationFolderMillis(name),
      statements: splitMigrationStatements(rawSql),
    });
  }

  return migrations.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  );
}

export function findPendingMigrations(
  migrations: BundledMigration[],
  appliedRows: AppliedMigrationRow[],
): BundledMigration[] {
  const appliedNames = new Set(
    appliedRows
      .map((row) => row.name)
      .filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      ),
  );
  const legacyHashes = new Set(
    appliedRows
      .filter((row) => !row.name)
      .map((row) => row.hash)
      .filter((hash) => hash.length > 0),
  );

  return migrations.filter(
    (migration) =>
      !appliedNames.has(migration.name) && !legacyHashes.has(migration.hash),
  );
}

function extractRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    return result as Array<Record<string, unknown>>;
  }
  if (
    result &&
    typeof result === "object" &&
    "rows" in result &&
    Array.isArray((result as { rows: unknown }).rows)
  ) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

interface SqlExecutor {
  execute(query: SQLWrapper | string): Promise<unknown>;
}

async function ensureMigrationsTable(executor: SqlExecutor): Promise<void> {
  await executor.execute(sql`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await executor.execute(sql`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint,
      name text,
      applied_at timestamp with time zone DEFAULT now()
    )
  `);
  await executor.execute(
    sql`ALTER TABLE "drizzle"."__drizzle_migrations" ADD COLUMN IF NOT EXISTS "name" text`,
  );
  await executor.execute(
    sql`ALTER TABLE "drizzle"."__drizzle_migrations" ADD COLUMN IF NOT EXISTS "applied_at" timestamp with time zone DEFAULT now()`,
  );
}

async function readAppliedMigrations(
  executor: SqlExecutor,
): Promise<AppliedMigrationRow[]> {
  const result = await executor.execute(
    sql`SELECT hash, name FROM "drizzle"."__drizzle_migrations"`,
  );
  return extractRows(result).map((row) => ({
    hash: typeof row.hash === "string" ? row.hash : "",
    name: typeof row.name === "string" ? row.name : null,
  }));
}

async function applyPendingInExecutor(
  executor: SqlExecutor,
  migrations: BundledMigration[],
): Promise<RuntimeMigrationResult> {
  const appliedRows = await readAppliedMigrations(executor);
  const pending = findPendingMigrations(migrations, appliedRows);

  for (const migration of pending) {
    for (const statement of migration.statements) {
      await executor.execute(sql.raw(statement));
    }
    await executor.execute(
      sql`INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at", "name") VALUES (${migration.hash}, ${migration.folderMillis}, ${migration.name})`,
    );
  }

  return {
    total: migrations.length,
    applied: pending.map((migration) => migration.name),
    skipped: migrations.length - pending.length,
  };
}

/**
 * Apply any unapplied Drizzle SQL migrations bundled into the build.
 * Uses a transaction-scoped advisory lock when interactive transactions are
 * available (e.g. `node-postgres` / Hyperdrive) so concurrent deploy hooks
 * serialize cleanly across pooled connections.
 */
export async function runBundledMigrations(
  options: {
    database?: Database;
    interactiveTransactions?: boolean;
    migrations?: BundledMigration[];
  } = {},
): Promise<RuntimeMigrationResult> {
  const database = options.database ?? db;
  const migrations = options.migrations ?? collectBundledMigrations();
  if (migrations.length === 0) {
    return { total: 0, applied: [], skipped: 0 };
  }

  const useTransaction =
    options.interactiveTransactions ??
    supportsInteractiveTransactions(getDatabaseDriver());

  const executor = database as unknown as SqlExecutor;
  await ensureMigrationsTable(executor);

  if (!useTransaction) {
    return applyPendingInExecutor(executor, migrations);
  }

  return database.transaction(async (tx) => {
    const txExecutor = tx as unknown as SqlExecutor;
    await txExecutor.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${MIGRATION_LOCK_KEY}))`,
    );
    return applyPendingInExecutor(txExecutor, migrations);
  });
}
