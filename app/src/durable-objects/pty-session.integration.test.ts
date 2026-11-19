import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
/**
 * Runs the Cloudflare PTY re-check's SQL against a REAL, DISPOSABLE PostgreSQL.
 * Skipped unless BLOSSOM_TEST_PG_URL is set to a loopback database whose name
 * starts with `blossom_disposable_` and has the app's migrations applied
 * (`DATABASE_URL=<that url> pnpm --filter @blossom/app db:migrate`). The test
 * inserts its own uniquely named rows and deletes them afterwards; it never
 * drops or truncates anything.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/db";
import { session, user } from "@/db/auth-schema";
import { server } from "@/db/proxy-schema";

import {
  isPtySessionAuthorized,
  type PtySocketAttachment,
} from "./pty-session.cloudflare";

const url = process.env.BLOSSOM_TEST_PG_URL;

function assertDisposableLoopback(value: string): void {
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    !parsed.pathname.slice(1).startsWith("blossom_disposable_")
  ) {
    throw new Error(
      "BLOSSOM_TEST_PG_URL must be a loopback database named blossom_disposable_*",
    );
  }
}

const NOW = new Date("2026-11-19T01:00:00.000Z");
const CONNECTED_AT = new Date("2026-11-19T00:00:00.000Z");

(url ? describe : describe.skip)("PTY re-check against PostgreSQL", () => {
  const tag = randomUUID().slice(0, 8);
  const ids = {
    admin: `pty-it-admin-${tag}`,
    session: `pty-it-session-${tag}`,
    server: `pty-it-server-${tag}`,
  };
  let database: Database;

  function attachment(
    overrides: Partial<PtySocketAttachment> = {},
  ): PtySocketAttachment {
    return {
      kind: "pty",
      serverId: ids.server,
      connectedAt: CONNECTED_AT.toISOString(),
      agentProtocol: "v1",
      agentSessionId: null,
      sessionId: "pty-1",
      authSessionId: ids.session,
      actor: {
        id: ids.admin,
        email: null,
        impersonatedBy: null,
        ip: null,
        userAgent: null,
      },
      startedAt: "2026-11-19T00:30:00.000Z",
      cols: 80,
      rows: 24,
      ...overrides,
    };
  }

  async function reset(): Promise<void> {
    await database
      .update(user)
      .set({ role: "admin" })
      .where(eq(user.id, ids.admin));
    const expiresAt = new Date("2026-11-20T00:00:00.000Z");
    await database
      .insert(session)
      .values({
        id: ids.session,
        userId: ids.admin,
        token: `token-${tag}`,
        expiresAt,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({ target: session.id, set: { expiresAt } });
    await database
      .update(server)
      .set({
        enabled: true,
        transportMode: "ws",
        wsConnectedAt: CONNECTED_AT,
        agentCapabilities: ["pty-v1"],
      })
      .where(eq(server.id, ids.server));
  }

  beforeAll(async () => {
    assertDisposableLoopback(url!);
    // Connection string form, as the Durable Object does. Passing a Pool
    // instance to drizzle lost the port in this setup.
    database = drizzle(url!) as unknown as Database;
    await database.insert(user).values({
      id: ids.admin,
      name: "PTY integration admin",
      email: `pty-it-${tag}@example.invalid`,
      role: "admin",
    });
    await database.insert(server).values({
      id: ids.server,
      name: "pty-it",
      address: "203.0.113.10",
      agentTokenHash: `hash-${tag}`,
      agentTokenPrefix: `pfx-${tag}`,
    });
    await reset();
  });

  afterAll(async () => {
    await database.delete(session).where(eq(session.id, ids.session));
    await database.delete(server).where(eq(server.id, ids.server));
    await database.delete(user).where(eq(user.id, ids.admin));
    await (
      database as unknown as { $client: { end(): Promise<void> } }
    ).$client.end();
  });

  it("keeps a shell whose session, role, server and agent connection still hold", async () => {
    await reset();
    await expect(
      isPtySessionAuthorized(database, attachment(), NOW),
    ).resolves.toBe(true);
  });

  it("revokes when the admin session has expired", async () => {
    await reset();
    await database
      .update(session)
      .set({ expiresAt: new Date("2026-11-19T00:59:59.000Z") })
      .where(eq(session.id, ids.session));
    await expect(
      isPtySessionAuthorized(database, attachment(), NOW),
    ).resolves.toBe(false);
  });

  it("revokes when the admin session was deleted", async () => {
    await reset();
    await database.delete(session).where(eq(session.id, ids.session));
    await expect(
      isPtySessionAuthorized(database, attachment(), NOW),
    ).resolves.toBe(false);
    await reset();
  });

  it("revokes when the user lost the admin role", async () => {
    await reset();
    await database
      .update(user)
      .set({ role: "user" })
      .where(eq(user.id, ids.admin));
    await expect(
      isPtySessionAuthorized(database, attachment(), NOW),
    ).resolves.toBe(false);
    await reset();
  });

  it("revokes when the server is disabled", async () => {
    await reset();
    await database
      .update(server)
      .set({ enabled: false })
      .where(eq(server.id, ids.server));
    await expect(
      isPtySessionAuthorized(database, attachment(), NOW),
    ).resolves.toBe(false);
    await reset();
  });

  it("revokes when the agent reconnected on a new connection", async () => {
    await reset();
    await database
      .update(server)
      .set({ wsConnectedAt: new Date("2026-11-19T00:10:00.000Z") })
      .where(eq(server.id, ids.server));
    await expect(
      isPtySessionAuthorized(database, attachment(), NOW),
    ).resolves.toBe(false);
    await reset();
  });

  it("revokes when the session now belongs to another user", async () => {
    await reset();
    await expect(
      isPtySessionAuthorized(
        database,
        attachment({
          actor: {
            id: `someone-else-${tag}`,
            email: null,
            impersonatedBy: null,
            ip: null,
            userAgent: null,
          },
        }),
        NOW,
      ),
    ).resolves.toBe(false);
  });
});
