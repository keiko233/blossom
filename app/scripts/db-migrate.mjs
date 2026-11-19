import { config as loadDotenv } from "dotenv";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const DEFAULT_PG_PORT = 5432;

/**
 * Strip comments and trailing commas from JSONC (e.g. `wrangler.jsonc`) while
 * keeping string literal contents intact.
 */
export function stripJsonc(input) {
  let stripped = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    const next = input[i + 1];

    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 1;
      while (i + 1 < input.length && input[i + 1] !== "\n") {
        i += 1;
      }
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 1;
      while (
        i + 1 < input.length &&
        !(input[i + 1] === "*" && input[i + 2] === "/")
      ) {
        i += 1;
      }
      i += 2;
      continue;
    }

    stripped += ch;
  }

  // Remove trailing commas before closing brackets/braces outside strings.
  let result = "";
  inString = false;
  escaped = false;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (inString) {
      result += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === ",") {
      let j = i + 1;
      while (j < stripped.length && /\s/.test(stripped[j])) {
        j += 1;
      }
      if (stripped[j] === "}" || stripped[j] === "]") {
        continue;
      }
    }
    result += ch;
  }

  return result;
}

export function parseDatabaseTarget(connectionString) {
  if (!connectionString || !connectionString.trim()) {
    throw new Error(
      "DATABASE_URL is required to run database migrations (received empty value).",
    );
  }

  let parsed;
  try {
    parsed = new URL(connectionString.trim());
  } catch {
    throw new Error("DATABASE_URL is not a valid connection URL.");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(
      `DATABASE_URL must use postgres:// or postgresql:// (got ${parsed.protocol}).`,
    );
  }

  const host = parsed.hostname.toLowerCase();
  const port = parsed.port ? Number(parsed.port) : DEFAULT_PG_PORT;
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  const user = decodeURIComponent(parsed.username);

  if (!host || !database || !Number.isInteger(port) || port <= 0) {
    throw new Error(
      "DATABASE_URL must include a valid hostname, port, and database name.",
    );
  }

  return { host, port, database, user };
}

export function normalizeClusterHost(host) {
  return host.toLowerCase().replace(/-pooler(?=\.)/, "");
}

export function targetsMatch(databaseTarget, hyperdriveOrigin) {
  const originPort = Number(hyperdriveOrigin.port ?? DEFAULT_PG_PORT);
  return (
    normalizeClusterHost(databaseTarget.host) ===
      normalizeClusterHost(hyperdriveOrigin.host) &&
    databaseTarget.port === originPort &&
    databaseTarget.database === hyperdriveOrigin.database &&
    databaseTarget.user === (hyperdriveOrigin.user ?? "")
  );
}

export function formatTarget(target) {
  const port = target.port ?? DEFAULT_PG_PORT;
  const prefix = target.user ? `${target.user}@` : "";
  return `${prefix}${target.host}:${port}/${target.database}`;
}

export function parseHyperdriveGetOutput(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error(
      "Unexpected output from `wrangler hyperdrive get` (no JSON).",
    );
  }
  const parsed = JSON.parse(stdout.slice(start, end + 1));
  if (!parsed?.origin?.host || !parsed?.origin?.database) {
    throw new Error(
      "Unexpected output from `wrangler hyperdrive get` (missing origin).",
    );
  }
  return parsed;
}

export function shouldVerifyHyperdrive(env = process.env) {
  if (env.SKIP_HYPERDRIVE_CHECK === "1") {
    return false;
  }
  return Boolean(env.WORKERS_CI || env.CLOUDFLARE_API_TOKEN);
}

export function collectLocalMigrations(drizzleDir) {
  if (!fs.existsSync(drizzleDir)) {
    return [];
  }
  const entries = fs
    .readdirSync(drizzleDir, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() &&
        !entry.name.startsWith(".") &&
        entry.name !== "meta",
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const migrations = [];
  for (const entry of entries) {
    const sqlPath = path.join(drizzleDir, entry.name, "migration.sql");
    if (!fs.existsSync(sqlPath)) {
      continue;
    }
    const sql = fs.readFileSync(sqlPath, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    migrations.push({ name: entry.name, hash });
  }
  return migrations;
}

export function findMissingMigrationHashes(localMigrations, appliedHashes) {
  return localMigrations.filter(
    (migration) => !appliedHashes.has(migration.hash),
  );
}

export function verifyHyperdriveAlignment({
  appDir,
  databaseTarget,
  runWrangler = (args) => {
    const wranglerBin = path.join(appDir, "node_modules/.bin/wrangler");
    return execFileSync(wranglerBin, args, {
      cwd: appDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  },
}) {
  const wranglerPath = path.join(appDir, "wrangler.jsonc");
  if (!fs.existsSync(wranglerPath)) {
    return;
  }

  const wranglerConfig = JSON.parse(
    stripJsonc(fs.readFileSync(wranglerPath, "utf8")),
  );
  const bindings = Array.isArray(wranglerConfig.hyperdrive)
    ? wranglerConfig.hyperdrive
    : [];

  for (const binding of bindings) {
    if (!binding?.id) {
      continue;
    }
    const output = runWrangler(["hyperdrive", "get", binding.id]);
    const config = parseHyperdriveGetOutput(output);
    if (!targetsMatch(databaseTarget, config.origin)) {
      throw new Error(
        [
          `Refusing to run migrations: DATABASE_URL (${formatTarget(databaseTarget)}) does not match Cloudflare Hyperdrive binding ${binding.binding ?? "HYPERDRIVE"} (${binding.id}: ${formatTarget(config.origin)}).`,
          "Update DATABASE_URL in Cloudflare Workers Build Variables and secrets (and Runtime Secrets) to point at the Hyperdrive database before deploying.",
          "Set SKIP_HYPERDRIVE_CHECK=1 only if you intentionally target a separate database.",
        ].join("\n"),
      );
    }
    console.log(
      `Verified DATABASE_URL matches Hyperdrive ${binding.binding ?? "HYPERDRIVE"} (${formatTarget(config.origin)}).`,
    );
  }
}

export async function verifyAppliedMigrations(connectionString, drizzleDir) {
  const localMigrations = collectLocalMigrations(drizzleDir);
  if (localMigrations.length === 0) {
    return localMigrations;
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query(
      "SELECT hash FROM drizzle.__drizzle_migrations",
    );
    const appliedHashes = new Set(res.rows.map((row) => row.hash));
    const missing = findMissingMigrationHashes(localMigrations, appliedHashes);
    if (missing.length > 0) {
      const names = missing.map((m) => m.name).join(", ");
      throw new Error(
        `Migration verification failed: ${missing.length} migration(s) are not recorded in drizzle.__drizzle_migrations (${names}).`,
      );
    }
    return localMigrations;
  } finally {
    await client.end();
  }
}

async function main() {
  const appDir = path.resolve(import.meta.dirname, "..");

  loadDotenv({
    path: [path.join(appDir, ".env.local"), path.join(appDir, ".env")],
    quiet: true,
  });

  const databaseUrl = process.env.DATABASE_URL?.trim();
  const databaseTarget = parseDatabaseTarget(databaseUrl);

  if (shouldVerifyHyperdrive(process.env)) {
    verifyHyperdriveAlignment({ appDir, databaseTarget });
  }

  const drizzleKitBin = path.join(appDir, "node_modules/.bin/drizzle-kit");
  const result = spawnSync(
    drizzleKitBin,
    ["migrate", ...process.argv.slice(2)],
    {
      cwd: appDir,
      stdio: "inherit",
    },
  );

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }

  const applied = await verifyAppliedMigrations(
    databaseUrl,
    path.join(appDir, "drizzle"),
  );
  console.log(
    `Verified ${applied.length} applied migration(s) on ${formatTarget(databaseTarget)}.`,
  );
}

const isEntrypoint =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isEntrypoint) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
