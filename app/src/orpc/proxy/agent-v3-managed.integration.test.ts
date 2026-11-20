/**
 * Task 07 pointer coherence and managed compile on a REAL, disposable
 * PostgreSQL. Skipped unless BLOSSOM_TEST_PG_URL names a loopback database
 * (`blossom_disposable_*`). The public schema is dropped and rebuilt.
 */
import type { ManagedStageIntent } from "@blossom/contracts/agent-config-v3";
import { managedStageIntentSchema } from "@blossom/contracts/agent-config-v3";
import { MANAGED_NETWORKING_AGENT_CAPABILITY } from "@blossom/domain/managed-networking";
import { eq } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "@/db";
import type { Server } from "@/db/proxy-schema";
import { server } from "@/db/proxy-schema";
import { encryptCertificateSecret } from "@/lib/certificate-crypto";
import { encryptManagedPeerCredential } from "@/lib/managed-credential-crypto";
import {
  buildAgentConfigV3Output,
  buildAgentDesiredState,
} from "@/orpc/proxy/agent-desired-state";
import {
  ManagedCompileError,
  ManagedNetworkingRequiresV2Error,
} from "@/orpc/proxy/managed-singbox";
import {
  computeManagedStageIntentDigest,
  computeManagedStateFingerprint,
} from "@/orpc/proxy/singbox";

const PG_URL = process.env.BLOSSOM_TEST_PG_URL;
const MIGRATIONS = fileURLToPath(new URL("../../../drizzle/", import.meta.url));
const KEY = Buffer.alloc(32, 5);
const FP_A = "a".repeat(64);
const FP_B = "b".repeat(64);
const SERVER_ID = "srv-managed-int";
const LEGACY_SERVER_ID = "srv-legacy-int";
const SEQ = 7;
const SRS_BYTES = Buffer.from([0x53, 0x52, 0x53, 0x01]);

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
  for (const statement of readFileSync(
    `${MIGRATIONS}${folder}/migration.sql`,
    "utf8",
  ).split("--> statement-breakpoint")) {
    if (statement.trim()) await pool.query(statement);
  }
}

function managedIntent(): ManagedStageIntent {
  return managedStageIntentSchema.parse({
    schemaVersion: 1,
    configVersionId: "mcv-int-1",
    serverId: SERVER_ID,
    version: 1,
    topologyGeneration: 1,
    subscriberInbounds: [],
    peerInbounds: [
      {
        inboundId: "pin-int",
        runtimeTag: "peer-in-pin-int",
        protocol: "vless",
        listenAddress: "::",
        listenPort: 9443,
        advertisedAddress: "198.51.100.10",
        advertisedPort: 9443,
        tlsServerName: "peer-a.internal.example.com",
        certificateId: "cert-peer-a-int",
        certificateGeneration: 2,
        certificateFingerprintSha256: FP_A,
        admissions: [
          {
            linkId: "link-in-int",
            sourceServerId: LEGACY_SERVER_ID,
            credentialGeneration: 1,
          },
        ],
      },
    ],
    outbounds: [
      {
        outboundId: "dprof-int",
        runtimeTag: "direct-dprof-int",
        kind: "direct_profile",
        dialOptions: { bind_interface: "eth0" },
      },
      {
        outboundId: "pout-int",
        runtimeTag: "peer-out-pout-int",
        kind: "peer_link",
        dialOptions: {},
        linkId: "link-int",
        destinationServerId: LEGACY_SERVER_ID,
        destinationInboundId: "pin-remote-int",
        protocol: "trojan",
        serverAddress: "203.0.113.20",
        serverPort: 9443,
        tlsServerName: "peer-b.internal.example.com",
        credentialGeneration: 1,
        trustMode: "managed_certificate",
        trustedCertificates: [
          {
            certificateId: "cert-peer-b-int",
            generation: 5,
            fingerprintSha256: FP_B,
          },
        ],
      },
    ],
    routingPolicy: {
      finalOutboundTag: "direct",
      rules: [
        {
          ruleId: "rule-int-to-peer",
          inboundTags: ["peer-in-pin-int"],
          sniff: true,
          resolveStrategy: "prefer_ipv4",
          network: "tcp",
          ruleSetTags: ["rule-set-rs-int"],
          action: "route",
          outboundTag: "peer-out-pout-int",
        },
      ],
    },
    ruleSets: [
      {
        runtimeTag: "rule-set-rs-int",
        ruleSetId: "rs-int",
        version: "v1",
        format: "binary",
        sha256: createHash("sha256").update(SRS_BYTES).digest("hex"),
        sizeBytes: SRS_BYTES.byteLength,
      },
    ],
    stageExpectations: {
      requiredRuntimeTags: [
        "peer-in-pin-int",
        "direct-dprof-int",
        "peer-out-pout-int",
      ],
      removedRuntimeTags: [],
    },
  });
}

describe.skipIf(!PG_URL)("managed V3 compile from stage pointer", () => {
  const pool = PG_URL ? new Pool({ connectionString: PG_URL }) : null;
  let database: Database;
  let serverRow: Server;

  beforeAll(async () => {
    assertDisposable(PG_URL!);
    process.env.DATABASE_URL = PG_URL;
    process.env.BETTER_AUTH_URL = "http://localhost:3000";
    process.env.CERTIFICATE_MASTER_KEY = KEY.toString("base64url");
    await pool!.query(
      "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;",
    );
    const folders = readdirSync(MIGRATIONS)
      .filter((entry) => !entry.endsWith(".json"))
      .sort();
    for (const folder of folders) await apply(pool!, folder);

    const srsSha256 = createHash("sha256").update(SRS_BYTES).digest("hex");
    const intent = managedIntent();

    await pool!.query(
      `INSERT INTO server (id, name, address, desired_revision_seq)
       VALUES ($1, 'managed', 'a.example.test', $2), ($3, 'legacy', 'l.example.test', 0)`,
      [SERVER_ID, SEQ, LEGACY_SERVER_ID],
    );
    await pool!.query(
      `INSERT INTO managed_certificate (id, name, kind, domains)
       VALUES ('cert-peer-a-int', 'peer-a', 'self_signed', '["peer-a.internal.example.com"]'),
              ('cert-peer-b-int', 'peer-b', 'self_signed', '["peer-b.internal.example.com"]')`,
    );
    const certAad = (id: string, part: "certificate" | "private-key") =>
      `certificate:${id}:${part}`;
    await pool!.query(
      `INSERT INTO certificate_material
         (id, certificate_id, version, certificate_ciphertext, private_key_ciphertext, domains, not_before, not_after, fingerprint_sha256)
       VALUES
         ('cm-a', 'cert-peer-a-int', 2, $1, $2, '["peer-a.internal.example.com"]', '2026-01-01', '2027-01-01', $3),
         ('cm-b', 'cert-peer-b-int', 5, $4, $5, '["peer-b.internal.example.com"]', '2026-01-01', '2027-01-01', $6)`,
      [
        encryptCertificateSecret(
          "PEER-A-CERT",
          certAad("cm-a", "certificate"),
          KEY,
        ),
        encryptCertificateSecret(
          "PEER-A-KEY",
          certAad("cm-a", "private-key"),
          KEY,
        ),
        FP_A,
        encryptCertificateSecret(
          "PEER-B-PUBLIC-CERT",
          certAad("cm-b", "certificate"),
          KEY,
        ),
        encryptCertificateSecret(
          "PEER-B-UNUSED-KEY",
          certAad("cm-b", "private-key"),
          KEY,
        ),
        FP_B,
      ],
    );
    await pool!.query(
      `INSERT INTO peer_inbound
         (id, server_id, name, runtime_tag, protocol, listen_address, listen_port,
          advertised_address, advertised_port, tls_server_name, certificate_id)
       VALUES ('pin-int', $1, 'peer', 'peer-in-pin-int', 'vless', '::', 9443, '198.51.100.10', 9443, 'peer-a.internal.example.com', 'cert-peer-a-int'),
              ('pin-remote-int', $2, 'remote peer', 'peer-in-pin-remote-int', 'vless', '::', 9444, '198.51.100.20', 9444, 'peer-b.internal.example.com', 'cert-peer-b-int')`,
      [SERVER_ID, LEGACY_SERVER_ID],
    );
    await pool!.query(
      `INSERT INTO peer_link (id, source_server_id, destination_inbound_id)
       VALUES ('link-int', $1, 'pin-remote-int')`,
      [SERVER_ID],
    );
    await pool!.query(
      `INSERT INTO peer_link (id, source_server_id, destination_inbound_id)
       VALUES ('link-in-int', $1, 'pin-int')`,
      [LEGACY_SERVER_ID],
    );
    await pool!.query(
      `INSERT INTO peer_link_credential (link_id, generation, state, credential_ciphertext)
       VALUES ('link-int', 1, 'active', $1),
              ('link-in-int', 1, 'active', $2)`,
      [
        encryptManagedPeerCredential(
          "link-int",
          1,
          "550e8400-e29b-41d4-a716-446655440000",
          KEY,
        ),
        encryptManagedPeerCredential(
          "link-in-int",
          1,
          "550e8400-e29b-41d4-a716-446655440001",
          KEY,
        ),
      ],
    );
    await pool!.query(
      `INSERT INTO managed_rule_set_asset
         (rule_set_id, version, format, source, content_base64, size_bytes, sha256)
       VALUES ('rs-int', 'v1', 'binary', 'test', $1, $2, $3)`,
      [SRS_BYTES.toString("base64"), SRS_BYTES.byteLength, srsSha256],
    );
    const intentDigest = computeManagedStageIntentDigest(intent);
    const fingerprint = computeManagedStateFingerprint(intent);
    await pool!.query(
      `INSERT INTO managed_config_version
         (id, server_id, version, schema_version, intent, intent_digest, subscriber_node_ids)
       VALUES ('mcv-int-1', $1, 1, 1, $2, $3, '[]')`,
      [SERVER_ID, JSON.stringify(intent), intentDigest],
    );
    await pool!.query(
      `INSERT INTO managed_server_state
         (server_id, desired_config_version_id, desired_ordinal, desired_min_revision_seq, desired_managed_fingerprint)
       VALUES ($1, 'mcv-int-1', 1, $2, $3)`,
      [SERVER_ID, SEQ, fingerprint],
    );

    database = drizzleNodePg({ client: pool! }) as unknown as Database;
    const [row] = await database
      .select()
      .from(server)
      .where(eq(server.id, SERVER_ID));
    serverRow = row!;
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("reads the sequence and pointer coherently and compiles the managed extension", async () => {
    const desired = await buildAgentDesiredState(serverRow, {
      database,
      advanceCertificates: false,
      managedDelivery: "v2",
      agentCapabilities: [MANAGED_NETWORKING_AGENT_CAPABILITY],
    });
    expect(desired.desiredRevisionSeq).toBe(SEQ);
    expect(desired.desiredRevision.startsWith(`${SEQ}:sha256:`)).toBe(true);
    expect(desired.managed?.configVersionId).toBe("mcv-int-1");
    expect(desired.managed?.managedFingerprint).toBe(
      computeManagedStateFingerprint(managedIntent()),
    );
    expect(desired.managed?.tlsBindings).toHaveLength(2);
    expect(desired.managed?.probeBindings).toEqual([
      {
        linkId: "link-in-int",
        credentialGeneration: 1,
        sourceServerId: LEGACY_SERVER_ID,
        destinationServerId: SERVER_ID,
        sourceOutboundTag: null,
        destinationInboundTag: "peer-in-pin-int",
      },
      {
        linkId: "link-int",
        credentialGeneration: 1,
        sourceServerId: SERVER_ID,
        destinationServerId: LEGACY_SERVER_ID,
        sourceOutboundTag: "peer-out-pout-int",
        destinationInboundTag: null,
      },
    ]);
    expect(desired.managed?.peerTrustArtifacts[0]).not.toHaveProperty(
      "privateKeyPem",
    );
    expect(
      desired.certificateArtifacts.map((artifact) => artifact.certificateId),
    ).toContain("cert-peer-a-int");
    const output = buildAgentConfigV3Output(serverRow, desired);
    expect(
      (output.singboxConfig as { inbounds: { tag: string }[] }).inbounds.map(
        (inbound) => inbound.tag,
      ),
    ).toContain("peer-in-pin-int");
    expect(JSON.stringify(output)).not.toContain("PEER-B-UNUSED-KEY");
  });

  it("refuses legacy delivery and unsupported agents without compiling a legacy payload", async () => {
    await expect(
      buildAgentDesiredState(serverRow, {
        database,
        advanceCertificates: false,
      }),
    ).rejects.toBeInstanceOf(ManagedNetworkingRequiresV2Error);

    await expect(
      buildAgentDesiredState(serverRow, {
        database,
        advanceCertificates: false,
        managedDelivery: "v2",
        agentCapabilities: ["config-v3"],
      }),
    ).rejects.toMatchObject({
      name: "ManagedCompileError",
      code: "unsupported_agent",
    });
  });

  it("fails closed on a pointer/fingerprint mismatch", async () => {
    await pool!.query(
      `UPDATE managed_server_state SET desired_managed_fingerprint = $1 WHERE server_id = $2`,
      [`sha256:${"c".repeat(64)}`, SERVER_ID],
    );
    await expect(
      buildAgentDesiredState(serverRow, {
        database,
        advanceCertificates: false,
        managedDelivery: "v2",
        agentCapabilities: [MANAGED_NETWORKING_AGENT_CAPABILITY],
      }),
    ).rejects.toBeInstanceOf(ManagedCompileError);
    await pool!.query(
      `UPDATE managed_server_state SET desired_managed_fingerprint = $1 WHERE server_id = $2`,
      [computeManagedStateFingerprint(managedIntent()), SERVER_ID],
    );
  });

  it("returns the unchanged legacy shape for a server without managed state", async () => {
    const [legacy] = await database
      .select()
      .from(server)
      .where(eq(server.id, LEGACY_SERVER_ID));
    const desired = await buildAgentDesiredState(legacy!, {
      database,
      advanceCertificates: false,
    });
    expect(desired.managed).toBeUndefined();
    expect(desired.desiredRevision.startsWith("0:sha256:")).toBe(true);
    const output = buildAgentConfigV3Output(legacy!, desired);
    expect(output).not.toHaveProperty("managed");
    expect(output.managedTlsBindings).toEqual([]);
  });
});
