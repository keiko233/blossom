import type { ManagedStageIntent } from "@blossom/contracts/agent-config-v3";
import { drizzle } from "drizzle-orm/node-postgres";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
/**
 * Task 09 draft CRUD, immutable routing draft and stable workspace reads on a
 * REAL, DISPOSABLE PostgreSQL. Skipped unless BLOSSOM_TEST_PG_URL names a
 * loopback database (`blossom_disposable_*`); the public schema is dropped and
 * rebuilt from `app/drizzle/`.
 */
import { describe, expect, it, beforeAll, afterAll, vi } from "vitest";

import type { Database } from "@/db";
import { computeManagedStageIntentDigest } from "@/orpc/proxy/singbox";
import {
  buildServerIntent,
  readNetworkingWorkspace,
  readServerRouting,
} from "@/query/networking-read";
import {
  createPeerLinkDraft,
  deletePeerLinkDraft,
  importRuleSetAssetDraft,
  rotatePeerLinkCredentialDraft,
  savePeerInboundDraft,
  saveRoutingDraft,
} from "@/query/networking-write";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;

vi.hoisted(() => {
  process.env.DATABASE_URL ??= process.env.BLOSSOM_TEST_PG_URL;
  process.env.BETTER_AUTH_URL ??= "http://localhost:3000";
  process.env.CERTIFICATE_MASTER_KEY ??=
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
});

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

const migrationsDir = fileURLToPath(new URL("../../drizzle/", import.meta.url));

async function applyMigrations(pool: Pool) {
  await pool.query(
    `DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;`,
  );
  for (const folder of readdirSync(migrationsDir)
    .filter((entry) => !entry.endsWith(".json"))
    .sort()) {
    const text = readFileSync(
      `${migrationsDir}${folder}/migration.sql`,
      "utf8",
    );
    for (const statement of text.split("--> statement-breakpoint")) {
      if (statement.trim()) await pool.query(statement);
    }
  }
}

describe.skipIf(!PG_URL)("Networking workspace drafts", () => {
  let pool: Pool;
  let database: Database;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    pool = new Pool({ connectionString: PG_URL, max: 6 });
    database = drizzle({ client: pool }) as unknown as Database;
    await applyMigrations(pool);
    await pool.query(`
      INSERT INTO server (id, name, address, enabled) VALUES
        ('srv-a', 'Alpha', 'a.example.test', true),
        ('srv-b', 'Beta', 'b.example.test', true);
      INSERT INTO node (id, name, server_id, listen_port, protocol, settings, enabled)
      VALUES ('node-a', 'A ingress', 'srv-a', 10001, 'trojan', '{}', true);
      INSERT INTO managed_certificate
        (id, name, kind, domains, active_material_version, state)
      VALUES ('cert-b', 'B peer cert', 'self_signed', '["b.example.test"]', 1, 'active');
      INSERT INTO certificate_material
        (id, certificate_id, version, certificate_ciphertext, private_key_ciphertext,
         domains, not_before, not_after, fingerprint_sha256)
      VALUES ('cert-material-b', 'cert-b', 1, 'ciphertext', 'ciphertext',
              '["b.example.test"]', now() - interval '1 day', now() + interval '30 days',
              'abcdef0123456789');
    `);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates a signed draft link, rotates its credential and reads the topology", async () => {
    const inbound = await savePeerInboundDraft(
      {
        serverId: "srv-b",
        expectedTopologyGeneration: 0,
        name: "Transit ingress",
        protocol: "vless",
        listenAddress: "0.0.0.0",
        listenPort: 20001,
        advertisedAddress: "b.example.test",
        advertisedPort: 20001,
        tlsServerName: "b.example.test",
        certificateId: "cert-b",
        network: "both",
        settings: {},
      },
      database,
    );
    expect(inbound.ok).toBe(true);
    if (!inbound.ok) throw new Error(inbound.message ?? inbound.reason);

    const link = await createPeerLinkDraft(
      {
        sourceServerId: "srv-a",
        destinationInboundId: inbound.inboundId,
        name: "A to B",
        expectedTopologyGeneration: inbound.generation,
      },
      database,
    );
    if (!link.ok)
      throw new Error("message" in link ? link.message : link.reason);
    expect(link.ok).toBe(true);

    const rotated = await rotatePeerLinkCredentialDraft(
      link.linkId,
      link.generation,
      database,
    );
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) throw new Error(rotated.message);
    expect(rotated.generationNumber).toBe(2);

    const workspace = await readNetworkingWorkspace(database, false);
    expect(workspace.servers.map((row) => row.name)).toEqual(["Alpha", "Beta"]);
    expect(workspace.peerInbounds[0]).toMatchObject({
      id: inbound.inboundId,
      serverId: "srv-b",
      protocol: "vless",
      linkIds: [link.linkId],
    });
    expect(workspace.links[0]).toMatchObject({
      id: link.linkId,
      sourceServerId: "srv-a",
      destinationInboundId: inbound.inboundId,
      outboundName: "A to B",
      credentialGeneration: 2,
      phase: "draft",
    });
    expect(workspace.topologyGeneration).toBe(3);
    expect(workspace.activationEnabled).toBe(false);
  });

  it("saves an immutable routing draft that references the link and blocks deletion", async () => {
    const routing = await readServerRouting("srv-a", database, false);
    const link = routing.links[0]!;
    const version = 1;
    const built = await buildServerIntent(
      "srv-a",
      {
        configVersionId: "cfg-1",
        version,
        topologyGeneration: routing.topologyGeneration,
        rules: [
          {
            ruleId: "rule-1",
            inboundTags: ["node-node-a"],
            sniff: true,
            resolveStrategy: null,
            network: "tcp",
            domains: ["example.test"],
            domainSuffixes: [],
            domainKeywords: [],
            ipCidrs: [],
            ports: [443],
            ruleSetTags: [],
            action: "route",
            outboundTag: link.outboundTag,
          },
        ],
        finalOutboundTag: "direct",
      },
      database,
      false,
    );
    if (!built.ok) throw new Error(JSON.stringify(built.issues));
    expect(built.ok).toBe(true);
    expect(built.intent).not.toBeNull();
    const intent = built.intent as ManagedStageIntent;
    expect(computeManagedStageIntentDigest(intent)).toBe(built.intentDigest);

    const saved = await saveRoutingDraft(
      {
        configVersionId: "cfg-1",
        serverId: "srv-a",
        version,
        intent: intent as unknown as import("@/orpc/proxy/schema").JsonValue,
        intentDigest: built.intentDigest!,
        subscriberNodeIds: ["node-a"],
        expectedTopologyGeneration: routing.topologyGeneration,
      },
      database,
    );
    expect(saved.ok).toBe(true);

    const read = await readServerRouting("srv-a", database, false);
    expect(read.routing).toMatchObject({
      configVersionId: "cfg-1",
      version: 1,
      finalOutboundTag: "direct",
    });
    expect(read.routing?.rules[0]?.outboundTag).toBe(link.outboundTag);
    expect(read.routing?.managedFingerprint).toMatch(/^sha256:/);

    const removed = await deletePeerLinkDraft(
      link.id,
      saved.ok ? saved.generation : 4,
      database,
    );
    expect(removed).toMatchObject({ ok: false, reason: "referenced" });
  });

  it("imports a bounded immutable rule-set asset and exposes it in routing", async () => {
    const bytes = Buffer.from("fake-srs");
    const imported = await importRuleSetAssetDraft(
      {
        ruleSetId: "geoip-cn",
        version: "2026.11.20",
        source: "curated/geoip/cn",
        contentBase64: bytes.toString("base64"),
      },
      database,
    );
    expect(imported).toMatchObject({
      ok: true,
      ruleSetId: "geoip-cn",
      version: "2026.11.20",
      sizeBytes: bytes.length,
    });

    const workspace = await readNetworkingWorkspace(database, false);
    expect(workspace.ruleSets[0]).toMatchObject({
      ruleSetId: "geoip-cn",
      version: "2026.11.20",
      format: "binary",
    });
  });
});
