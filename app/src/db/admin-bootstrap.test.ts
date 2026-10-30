import { drizzleAdapter } from "@better-auth/drizzle-adapter";
import type { Database } from "@blossom/database/server";
import { neonConfig } from "@neondatabase/serverless";
import { betterAuth } from "better-auth";
import { admin, magicLink } from "better-auth/plugins";
import { eq } from "drizzle-orm";
import { drizzle as drizzleNeonHttp } from "drizzle-orm/neon-http";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import * as schema from "@/db/schema";
import { createRegistrationHooks } from "@/lib/auth-registration-hooks";
import type { RegistrationSettings } from "@/lib/settings";

/**
 * Real-PostgreSQL tests for the "first registered user becomes administrator"
 * claim (`drizzle/*_first_admin_trigger`). They need a disposable database and
 * are skipped unless one is configured:
 *
 *   BLOSSOM_BOOTSTRAP_TEST_DATABASE_URL          node-postgres connection string
 *   BLOSSOM_BOOTSTRAP_TEST_NEON_HTTP_URL         (optional) connection string the Neon
 *   BLOSSOM_BOOTSTRAP_TEST_NEON_HTTP_ENDPOINT    HTTP client uses, and the http(s)://…/sql
 *                                      endpoint of a local Neon HTTP proxy that
 *                                      reaches the SAME database
 *
 * THE DATABASE IS WIPED: every test run drops the `public` and `drizzle`
 * schemas and re-applies `app/drizzle`. The guard below only accepts a
 * loopback host and a database whose name contains "test".
 */
const adminUrl = process.env.BLOSSOM_BOOTSTRAP_TEST_DATABASE_URL;
const neonUrl = process.env.BLOSSOM_BOOTSTRAP_TEST_NEON_HTTP_URL;
const neonEndpoint = process.env.BLOSSOM_BOOTSTRAP_TEST_NEON_HTTP_ENDPOINT;

const MIGRATIONS = fileURLToPath(new URL("../../drizzle", import.meta.url));
const BOOTSTRAP_MIGRATIONS = [
  "20261030100007_admin_bootstrap",
  "20261030100008_first_admin_trigger",
];
const BASE_URL = "http://localhost:3000";

function assertDisposable(connectionString: string, loopbackOnly: boolean) {
  const url = new URL(connectionString);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (loopbackOnly && !loopback) {
    throw new Error(
      "BLOSSOM_BOOTSTRAP_TEST_DATABASE_URL must point at a loopback host",
    );
  }
  if (!/test/i.test(url.pathname.slice(1))) {
    throw new Error(
      "refusing to wipe a database whose name does not contain 'test'",
    );
  }
}

let pool: Pool;

async function rebuild(options: { withoutBootstrap?: boolean } = {}) {
  await pool.query("DROP SCHEMA IF EXISTS drizzle CASCADE");
  await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
  await pool.query("CREATE SCHEMA public");
  let folder = MIGRATIONS;
  let scratch: string | undefined;
  if (options.withoutBootstrap) {
    scratch = mkdtempSync(join(tmpdir(), "blossom-migrations-"));
    for (const name of readdirSync(MIGRATIONS)) {
      if (BOOTSTRAP_MIGRATIONS.includes(name)) continue;
      cpSync(join(MIGRATIONS, name), join(scratch, name), { recursive: true });
    }
    folder = scratch;
  }
  try {
    await migrate(drizzleNodePg({ client: pool }), {
      migrationsFolder: folder,
    });
  } finally {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}

/** Applies the migrations that were left out by `rebuild`. */
async function upgrade() {
  await migrate(drizzleNodePg({ client: pool }), {
    migrationsFolder: MIGRATIONS,
  });
}

/** Back to an empty, freshly migrated installation. */
async function resetState() {
  await pool.query('TRUNCATE "user" CASCADE');
  await pool.query('DELETE FROM "admin_bootstrap"');
}

function newUser(overrides: Partial<typeof schema.user.$inferInsert> = {}) {
  const id = `u-${randomUUID()}`;
  const now = new Date();
  return {
    id,
    name: "Test User",
    email: `${id}@example.test`,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

async function usersOf(db: Database) {
  return db
    .select({ id: schema.user.id, role: schema.user.role })
    .from(schema.user);
}

async function markerOf(db: Database) {
  return db.select().from(schema.adminBootstrap);
}

async function waitUntilBlocked(pid: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { rowCount } = await pool.query(
      "SELECT 1 FROM pg_stat_activity WHERE pid = $1 AND wait_event_type = 'Lock'",
      [pid],
    );
    if (rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

describe.each(["node-postgres", "neon-http"] as const)(
  "first-admin claim on %s",
  (driver) => {
    const enabled =
      driver === "node-postgres"
        ? Boolean(adminUrl)
        : Boolean(adminUrl && neonUrl && neonEndpoint);
    const suite = enabled ? describe : describe.skip;

    suite("against PostgreSQL", () => {
      let db: Database;

      beforeAll(async () => {
        assertDisposable(adminUrl!, true);
        if (driver === "neon-http") assertDisposable(neonUrl!, false);
        pool = new Pool({ connectionString: adminUrl, max: 32 });
        if (driver === "node-postgres") {
          db = drizzleNodePg({ client: pool });
        } else {
          neonConfig.fetchEndpoint = neonEndpoint!;
          db = drizzleNeonHttp(neonUrl!);
        }
        await rebuild();
      });

      afterAll(async () => {
        await pool?.end();
      });

      beforeEach(async () => {
        await resetState();
      });

      describe("user inserts", () => {
        it("promotes the first user and returns the role from the insert", async () => {
          const [first] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          const [second] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(first!.role).toBe("admin");
          expect(second!.role).toBe("user");
          const [marker] = await markerOf(db);
          expect(marker).toMatchObject({ id: true, claimedUserId: first!.id });
        });

        it("overrides the explicit default role better-auth's admin plugin sends", async () => {
          const [first] = await db
            .insert(schema.user)
            .values(newUser({ role: "user" }))
            .returning();
          expect(first!.role).toBe("admin");
        });

        it("never demotes or touches an explicitly chosen role later", async () => {
          await db.insert(schema.user).values(newUser());
          const [other] = await db
            .insert(schema.user)
            .values(newUser({ role: "admin" }))
            .returning();
          expect(other!.role).toBe("admin");
          expect((await markerOf(db)).length).toBe(1);
        });

        it("promotes only one row of a multi-row insert", async () => {
          await db
            .insert(schema.user)
            .values([newUser(), newUser(), newUser()]);
          const admins = (await usersOf(db)).filter((u) => u.role === "admin");
          expect(admins).toHaveLength(1);
        });
      });

      describe("concurrency", () => {
        it("promotes exactly one of many simultaneous first registrations", async () => {
          for (let round = 0; round < 5; round++) {
            await resetState();
            const results = await Promise.all(
              Array.from({ length: 16 }, () =>
                db.insert(schema.user).values(newUser()).returning(),
              ),
            );
            const returned = results.map(([row]) => row!);
            const returnedAdmins = returned.filter((u) => u.role === "admin");
            expect(returnedAdmins).toHaveLength(1);

            const stored = await usersOf(db);
            expect(stored).toHaveLength(16);
            const storedAdmins = stored.filter((u) => u.role === "admin");
            expect(storedAdmins.map((u) => u.id)).toEqual([
              returnedAdmins[0]!.id,
            ]);
            const markers = await markerOf(db);
            expect(markers).toHaveLength(1);
            expect(markers[0]!.claimedUserId).toBe(returnedAdmins[0]!.id);
          }
        });

        it("lets only one of several identical emails in, and makes it admin", async () => {
          const email = `dup-${randomUUID()}@example.test`;
          const results = await Promise.allSettled(
            Array.from({ length: 8 }, () =>
              db.insert(schema.user).values(newUser({ email })).returning(),
            ),
          );
          const won = results.filter((r) => r.status === "fulfilled");
          expect(won).toHaveLength(1);
          const stored = await usersOf(db);
          expect(stored).toHaveLength(1);
          expect(stored[0]!.role).toBe("admin");
          expect((await markerOf(db))[0]!.claimedUserId).toBe(stored[0]!.id);
        });

        it("does not lose the claim when a racing insert fails", async () => {
          for (let round = 0; round < 8; round++) {
            await resetState();
            const bad = () =>
              db
                .insert(schema.user)
                // NOT NULL violation, raised after the BEFORE trigger ran.
                .values(newUser({ name: null as unknown as string }))
                .returning();
            const goodValues = newUser();
            const good = () =>
              db.insert(schema.user).values(goodValues).returning();
            const [first, second] = round % 2 === 0 ? [bad, good] : [good, bad];
            const results = await Promise.allSettled([first(), second()]);
            const goodResult = results[round % 2 === 0 ? 1 : 0]!;
            const badResult = results[round % 2 === 0 ? 0 : 1]!;
            expect(badResult.status).toBe("rejected");
            expect(goodResult.status).toBe("fulfilled");
            const stored = await usersOf(db);
            expect(stored).toEqual([{ id: goodValues.id, role: "admin" }]);
            expect((await markerOf(db))[0]!.claimedUserId).toBe(goodValues.id);
          }
        });
      });

      describe("rollback", () => {
        it("does not consume the claim when the first insert fails", async () => {
          await expect(
            db
              .insert(schema.user)
              .values(newUser({ name: null as unknown as string })),
          ).rejects.toThrow();
          expect(await markerOf(db)).toHaveLength(0);
          expect(await usersOf(db)).toHaveLength(0);

          const [next] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(next!.role).toBe("admin");
        });

        it("does not change the claim when a later insert fails", async () => {
          const [first] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          await expect(
            db.insert(schema.user).values(newUser({ email: first!.email })),
          ).rejects.toThrow();
          expect(await markerOf(db)).toEqual([
            expect.objectContaining({ claimedUserId: first!.id }),
          ]);
          const [later] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(later!.role).toBe("user");
        });

        // Interactive transactions do not exist on neon-http.
        const itInteractive = driver === "node-postgres" ? it : it.skip;

        itInteractive.each([
          { outcome: "ROLLBACK", secondRole: "admin", firstRole: undefined },
          { outcome: "COMMIT", secondRole: "user", firstRole: "admin" },
        ] as const)(
          "makes a concurrent claimant wait for a transaction that ends in $outcome",
          async ({ outcome, secondRole, firstRole }) => {
            const insert =
              "INSERT INTO \"user\" (id, name, email) VALUES ($1, 'T', $2) RETURNING role";
            const one = await pool.connect();
            const two = await pool.connect();
            try {
              const a = newUser();
              const b = newUser();
              await one.query("BEGIN");
              const first = await one.query(insert, [a.id, a.email]);
              // The claim is held by an uncommitted transaction.
              expect(first.rows[0].role).toBe("admin");

              await two.query("BEGIN");
              const pid = (await two.query("SELECT pg_backend_pid() AS pid"))
                .rows[0].pid as number;
              const pending = two.query(insert, [b.id, b.email]);
              await waitUntilBlocked(pid);

              await one.query(outcome);
              const second = await pending;
              await two.query("COMMIT");

              expect(second.rows[0].role).toBe(secondRole);
              const stored = await usersOf(db);
              const byId = Object.fromEntries(
                stored.map((u) => [u.id, u.role]),
              );
              expect(byId[b.id]).toBe(secondRole);
              if (firstRole) expect(byId[a.id]).toBe(firstRole);
              else expect(byId[a.id]).toBeUndefined();
              const markers = await markerOf(db);
              expect(markers).toHaveLength(1);
              expect(markers[0]!.claimedUserId).toBe(
                outcome === "COMMIT" ? a.id : b.id,
              );
            } finally {
              await one.query("ROLLBACK").catch(() => {});
              await two.query("ROLLBACK").catch(() => {});
              one.release();
              two.release();
            }
          },
        );

        itInteractive(
          "rolls the claim back with an aborted application transaction",
          async () => {
            await expect(
              drizzleNodePg({ client: pool }).transaction(async (tx) => {
                await tx.insert(schema.user).values(newUser());
                throw new Error("abort");
              }),
            ).rejects.toThrow("abort");
            expect(await markerOf(db)).toHaveLength(0);
            const [next] = await db
              .insert(schema.user)
              .values(newUser())
              .returning();
            expect(next!.role).toBe("admin");
          },
        );
      });

      describe("deleting users", () => {
        it("never reopens the claim after every user is deleted", async () => {
          const [first] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          await db.delete(schema.user).where(eq(schema.user.id, first!.id));
          expect(await usersOf(db)).toHaveLength(0);

          const [later] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(later!.role).toBe("user");
          expect((await markerOf(db))[0]!.claimedUserId).toBe(first!.id);
        });

        it("survives TRUNCATE of the user table", async () => {
          await db.insert(schema.user).values(newUser());
          await pool.query('TRUNCATE "user" CASCADE');
          const [later] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(later!.role).toBe("user");
        });

        it("keeps a single marker row", async () => {
          await db.insert(schema.user).values(newUser());
          await expect(
            pool.query('INSERT INTO "admin_bootstrap" (id) VALUES (false)'),
          ).rejects.toThrow();
          await expect(
            pool.query('INSERT INTO "admin_bootstrap" (id) VALUES (true)'),
          ).rejects.toThrow();
        });
      });

      describe("upgrading an existing installation", () => {
        beforeEach(async () => {
          await rebuild({ withoutBootstrap: true });
        });

        // Leave the full schema behind for the other groups, even on failure.
        afterEach(async () => {
          await rebuild();
        });

        it("preserves existing users and promotes nobody who registers later", async () => {
          const existing = [
            newUser({ role: "user" }),
            newUser({ role: "user" }),
            newUser({ role: "admin" }),
          ];
          await pool.query(
            'INSERT INTO "user" (id, name, email, role) SELECT * FROM unnest($1::text[], $2::text[], $3::text[], $4::text[])',
            [
              existing.map((u) => u.id),
              existing.map((u) => u.name),
              existing.map((u) => u.email),
              existing.map((u) => u.role),
            ],
          );
          await upgrade();

          const stored = await usersOf(db);
          expect(stored.map((u) => [u.id, u.role]).sort()).toEqual(
            existing.map((u) => [u.id, u.role]).sort(),
          );
          expect(await markerOf(db)).toEqual([
            expect.objectContaining({ id: true, claimedUserId: null }),
          ]);

          const [later] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(later!.role).toBe("user");
        });

        it("does not promote after an upgraded installation loses all its users", async () => {
          await pool.query(
            "INSERT INTO \"user\" (id, name, email, role) VALUES ('old', 'Old', 'old@example.test', 'user')",
          );
          await upgrade();
          await pool.query('DELETE FROM "user"');
          const [later] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(later!.role).toBe("user");
        });

        it("makes the first registrant of an empty upgraded installation admin", async () => {
          await upgrade();
          expect(await markerOf(db)).toHaveLength(0);
          const [first] = await db
            .insert(schema.user)
            .values(newUser())
            .returning();
          expect(first!.role).toBe("admin");
        });
      });

      describe("through better-auth", () => {
        function makeAuth(initial?: Partial<RegistrationSettings>) {
          const registration: RegistrationSettings = {
            mode: "open",
            allowedEmailDomains: [],
            requireEmailVerification: false,
            ...initial,
          };
          const magicLinks: { email: string; url: string }[] = [];
          const hooks = createRegistrationHooks({
            getRegistration: async () => registration,
            grantTrial: async () => undefined,
          });
          const auth = betterAuth({
            baseURL: BASE_URL,
            secret: "test-secret-test-secret-test-secret-0123456789",
            database: drizzleAdapter(db, { provider: "pg", schema }),
            emailAndPassword: { enabled: true },
            rateLimit: { enabled: false },
            user: { validateUserInfo: hooks.validateUserInfo },
            databaseHooks: hooks.databaseHooks,
            plugins: [
              admin(),
              magicLink({
                sendMagicLink: async ({ email, url }) => {
                  magicLinks.push({ email, url });
                },
              }),
            ],
          });
          return { auth, registration, magicLinks };
        }

        const cookieOf = (headers: Headers) =>
          new Headers({
            cookie: headers
              .getSetCookie()
              .map((entry) => entry.split(";")[0])
              .join("; "),
          });

        async function signUp(
          auth: ReturnType<typeof makeAuth>["auth"],
          label: string,
        ) {
          const { headers, response } = await auth.api.signUpEmail({
            body: {
              email: `${label}-${randomUUID()}@example.test`,
              password: "password-123",
              name: label,
            },
            returnHeaders: true,
          });
          return { headers, user: response.user };
        }

        it("makes the first email sign-up admin in the response, the session and the row", async () => {
          const { auth } = makeAuth();
          const first = await signUp(auth, "first");
          expect(first.user.role).toBe("admin");
          const session = await auth.api.getSession({
            headers: cookieOf(first.headers),
          });
          expect(session?.user.role).toBe("admin");

          const second = await signUp(auth, "second");
          expect(second.user.role).toBe("user");
          const secondSession = await auth.api.getSession({
            headers: cookieOf(second.headers),
          });
          expect(secondSession?.user.role).toBe("user");

          const stored = await usersOf(db);
          expect(stored.find((u) => u.id === first.user.id)?.role).toBe(
            "admin",
          );
        });

        it("makes the first magic-link sign-in admin", async () => {
          const { auth, magicLinks } = makeAuth();
          await auth.api.signInMagicLink({
            body: { email: `magic-${randomUUID()}@example.test` },
            headers: new Headers(),
          });
          const token = new URL(magicLinks.at(-1)!.url).searchParams.get(
            "token",
          )!;
          const response = await auth.handler(
            new Request(
              `${BASE_URL}/api/auth/magic-link/verify?token=${token}&callbackURL=/dashboard&errorCallbackURL=/auth/login`,
            ),
          );
          expect(response.headers.get("location")).toContain("/dashboard");
          const session = await auth.api.getSession({
            headers: cookieOf(response.headers),
          });
          expect(session?.user.role).toBe("admin");
        });

        it("promotes exactly one of many concurrent sign-ups, consistently everywhere", async () => {
          const { auth } = makeAuth();
          const results = await Promise.all(
            Array.from({ length: 8 }, (_, i) => signUp(auth, `racer${i}`)),
          );
          const admins = results.filter((r) => r.user.role === "admin");
          expect(admins).toHaveLength(1);
          for (const result of results) {
            const session = await auth.api.getSession({
              headers: cookieOf(result.headers),
            });
            expect(session?.user.role).toBe(result.user.role);
          }
          const stored = await usersOf(db);
          expect(stored.filter((u) => u.role === "admin")).toEqual([
            { id: admins[0]!.user.id, role: "admin" },
          ]);
        });

        it("keeps the claim when closed registration refuses the first sign-up", async () => {
          const { auth, registration } = makeAuth({ mode: "closed" });
          await expect(signUp(auth, "early")).rejects.toThrow();
          expect(await usersOf(db)).toHaveLength(0);
          expect(await markerOf(db)).toHaveLength(0);

          registration.mode = "open";
          const first = await signUp(auth, "later");
          expect(first.user.role).toBe("admin");
        });
      });
    });
  },
);
