import type {
  ManagedPeerTlsBinding,
  ManagedPeerTrustArtifact,
  ManagedRuleSetArtifact,
  ManagedStageIntent,
} from "@blossom/contracts/agent-config-v3";
import {
  formatManagedPeerTlsBindingId,
  MANAGED_STAGE_INTENT_SCHEMA_VERSION,
  managedRuleSetArtifactSchema,
  managedStageIntentSchema,
} from "@blossom/contracts/agent-config-v3";
import { eq, inArray } from "drizzle-orm";

import { type Database, db } from "@/db";
import {
  managedConfigVersion,
  managedOutbound,
  managedRuleSetAsset,
  managedServerState,
  peerLinkCredential,
} from "@/db/managed-network-schema";
import { certificateMaterial } from "@/db/proxy-schema";
import { server } from "@/db/proxy-schema";
import { decryptCertificateSecret } from "@/lib/certificate-crypto";
import { ManagedCompileError } from "@/lib/managed-compile-error";
import {
  decryptManagedCustomProxySecret,
  decryptManagedPeerCredential,
} from "@/lib/managed-credential-crypto";
import {
  managedPeerCredentialKey,
  type ManagedPeerTlsMaterial,
} from "@/orpc/proxy/managed-singbox";
import {
  computeManagedStageIntentDigest,
  computeManagedStateFingerprint,
  type CertificateArtifact,
} from "@/orpc/proxy/singbox";

/**
 * Task 07 compile-state reader.
 *
 * - The sequence and the per-server desired pointer are read in ONE SQL
 *   statement, so the identifier can never pair an older sequence with a newer
 *   stage. The immutable `managed_config_version` row is loaded through that
 *   pointer only.
 * - Dynamic subscriber users/certificates stay live and are read by the caller.
 * - Task 08 owns rollout transitions (stage issue/confirm/recovery), probes and
 *   notification. This module only resolves the current pointer for delivery.
 */

export interface ManagedCompileState {
  serverId: string;
  desiredRevisionSeq: number;
  configVersionId: string;
  desiredRolloutId: string | null;
  desiredOrdinal: number | null;
  desiredManagedFingerprint: string;
  appliedConfigVersionId: string | null;
  intent: ManagedStageIntent;
  intentDigest: string;
  managedFingerprint: string;
  ruleSetArtifacts: ManagedRuleSetArtifact[];
  peerCredentials: Map<string, string>;
  customOutboundSecrets: Map<string, Record<string, unknown>>;
  tlsMaterial: ManagedPeerTlsMaterial;
  /** Deterministic identifier usable when a compile must be refused. */
  fallbackRevision: string;
}

interface RawCompileRow {
  desiredRevisionSeq: number;
  state: typeof managedServerState.$inferSelect | null;
  version: typeof managedConfigVersion.$inferSelect | null;
}

/** Reads the server sequence + pointer + immutable intent from one snapshot. */
async function readRawCompileState(
  serverId: string,
  database: Database,
): Promise<RawCompileRow> {
  const [row] = await database
    .select({
      desiredRevisionSeq: server.desiredRevisionSeq,
      state: managedServerState,
      version: managedConfigVersion,
    })
    .from(server)
    .leftJoin(managedServerState, eq(managedServerState.serverId, server.id))
    .leftJoin(
      managedConfigVersion,
      eq(managedConfigVersion.id, managedServerState.desiredConfigVersionId),
    )
    .where(eq(server.id, serverId));
  if (!row) {
    throw new ManagedCompileError(
      "managed_state_unavailable",
      `server ${serverId} no longer exists`,
    );
  }
  return row;
}

function fallbackRevision(
  desiredRevisionSeq: number,
  fingerprint: string | null,
): string {
  return `${desiredRevisionSeq}:${fingerprint ?? `sha256:${"0".repeat(64)}`}`;
}

/**
 * True when this server has a managed desired or last-known-good
 * configuration. Legacy HTTP/v1 delivery must be refused in that case even
 * before a pointer is compileable, so a legacy compile cannot replace serving
 * peer state.
 */
export async function hasManagedConfiguration(
  serverId: string,
  database: Database = db,
): Promise<boolean> {
  const [row] = await database
    .select({
      desiredConfigVersionId: managedServerState.desiredConfigVersionId,
      appliedConfigVersionId: managedServerState.appliedConfigVersionId,
    })
    .from(managedServerState)
    .where(eq(managedServerState.serverId, serverId));
  return Boolean(row?.desiredConfigVersionId || row?.appliedConfigVersionId);
}

/**
 * Resolves the current managed compile inputs, or `null` for a legacy server.
 * Throws `ManagedCompileError` when a pointer exists but its frozen intent,
 * fingerprints or artifacts are inconsistent; callers must not fall back to
 * a legacy compile in that case.
 */
export async function loadManagedCompileState(
  serverId: string,
  database: Database = db,
): Promise<ManagedCompileState | null> {
  const raw = await readRawCompileState(serverId, database);
  const state = raw.state;
  const version = raw.version;

  if (!state?.desiredConfigVersionId) {
    if (state?.appliedConfigVersionId) {
      throw new ManagedCompileError(
        "managed_state_unavailable",
        "managed last-known-good state exists without a desired pointer",
        fallbackRevision(
          raw.desiredRevisionSeq,
          state.appliedManagedFingerprint,
        ),
        raw.desiredRevisionSeq,
      );
    }
    return null;
  }
  if (!version) {
    throw new ManagedCompileError(
      "managed_state_unavailable",
      `managed config version ${state.desiredConfigVersionId} is missing`,
      fallbackRevision(raw.desiredRevisionSeq, state.desiredManagedFingerprint),
      raw.desiredRevisionSeq,
    );
  }

  const parsed = managedStageIntentSchema.safeParse(version.intent);
  if (!parsed.success) {
    throw new ManagedCompileError(
      "managed_state_inconsistent",
      `managed config version ${version.id} has an invalid intent: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
      fallbackRevision(raw.desiredRevisionSeq, state.desiredManagedFingerprint),
      raw.desiredRevisionSeq,
    );
  }
  const intent = parsed.data;
  if (
    version.schemaVersion !== MANAGED_STAGE_INTENT_SCHEMA_VERSION ||
    intent.schemaVersion !== version.schemaVersion ||
    intent.configVersionId !== version.id ||
    intent.serverId !== serverId ||
    intent.version !== version.version
  ) {
    throw new ManagedCompileError(
      "managed_state_inconsistent",
      `managed config version ${version.id} does not match its pointer or server`,
      fallbackRevision(raw.desiredRevisionSeq, state.desiredManagedFingerprint),
      raw.desiredRevisionSeq,
    );
  }

  const intentDigest = computeManagedStageIntentDigest(intent);
  const managedFingerprint = computeManagedStateFingerprint(intent);
  const expectedFallback = fallbackRevision(
    raw.desiredRevisionSeq,
    managedFingerprint,
  );
  if (version.intentDigest !== intentDigest) {
    throw new ManagedCompileError(
      "managed_state_inconsistent",
      `managed config version ${version.id} intent digest does not match its frozen intent`,
      expectedFallback,
      raw.desiredRevisionSeq,
    );
  }
  if (state.desiredManagedFingerprint !== managedFingerprint) {
    throw new ManagedCompileError(
      "managed_state_inconsistent",
      `managed server state fingerprint does not match config version ${version.id}`,
      expectedFallback,
      raw.desiredRevisionSeq,
    );
  }
  if (
    state.desiredMinRevisionSeq !== null &&
    state.desiredMinRevisionSeq > raw.desiredRevisionSeq
  ) {
    throw new ManagedCompileError(
      "managed_state_inconsistent",
      `managed stage minimum sequence ${state.desiredMinRevisionSeq} is ahead of the server sequence ${raw.desiredRevisionSeq}`,
      expectedFallback,
      raw.desiredRevisionSeq,
    );
  }

  let ruleSetArtifacts: ManagedRuleSetArtifact[];
  let peerCredentials: Map<string, string>;
  let customOutboundSecrets: Map<string, Record<string, unknown>>;
  let tlsMaterial: ManagedPeerTlsMaterial;
  try {
    [ruleSetArtifacts, peerCredentials, customOutboundSecrets, tlsMaterial] =
      await Promise.all([
        loadRuleSetArtifacts(intent, database),
        loadPeerCredentials(intent, database),
        loadCustomOutboundSecrets(intent, database),
        loadPeerTlsMaterial(intent, database),
      ]);
  } catch (error) {
    if (error instanceof ManagedCompileError) {
      throw new ManagedCompileError(
        error.code,
        error.message,
        expectedFallback,
        raw.desiredRevisionSeq,
      );
    }
    throw error;
  }

  return {
    serverId,
    desiredRevisionSeq: raw.desiredRevisionSeq,
    configVersionId: version.id,
    desiredRolloutId: state.desiredRolloutId,
    desiredOrdinal: state.desiredOrdinal,
    desiredManagedFingerprint: managedFingerprint,
    appliedConfigVersionId: state.appliedConfigVersionId,
    intent,
    intentDigest,
    managedFingerprint,
    ruleSetArtifacts,
    peerCredentials,
    customOutboundSecrets,
    tlsMaterial,
    fallbackRevision: expectedFallback,
  };
}

async function loadRuleSetArtifacts(
  intent: ManagedStageIntent,
  database: Database,
): Promise<ManagedRuleSetArtifact[]> {
  if (intent.ruleSets.length === 0) {
    return [];
  }
  const ids = [...new Set(intent.ruleSets.map((binding) => binding.ruleSetId))];
  const rows = await database
    .select()
    .from(managedRuleSetAsset)
    .where(inArray(managedRuleSetAsset.ruleSetId, ids));
  const byKey = new Map(
    rows.map((row) => [`${row.ruleSetId}:${row.version}`, row]),
  );
  return intent.ruleSets.map((binding) => {
    const row = byKey.get(`${binding.ruleSetId}:${binding.version}`);
    if (!row) {
      throw new ManagedCompileError(
        "missing_rule_set_artifact",
        `rule-set artifact ${binding.ruleSetId}:${binding.version} is missing`,
      );
    }
    const artifact = managedRuleSetArtifactSchema.safeParse({
      ruleSetId: row.ruleSetId,
      version: row.version,
      format: row.format,
      sha256: row.sha256,
      sizeBytes: row.sizeBytes,
      contentBase64: row.contentBase64,
    });
    if (!artifact.success) {
      throw new ManagedCompileError(
        "invalid_rule_set_artifact",
        `rule-set artifact ${binding.ruleSetId}:${binding.version} is invalid: ${artifact.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      );
    }
    return artifact.data;
  });
}

async function loadPeerCredentials(
  intent: ManagedStageIntent,
  database: Database,
): Promise<Map<string, string>> {
  const linkIds = new Set<string>();
  for (const peer of intent.peerInbounds) {
    for (const admission of peer.admissions) {
      linkIds.add(admission.linkId);
    }
  }
  for (const outbound of intent.outbounds) {
    if (outbound.kind === "peer_link" && outbound.linkId) {
      linkIds.add(outbound.linkId);
    }
  }
  if (linkIds.size === 0) {
    return new Map();
  }
  const rows = await database
    .select()
    .from(peerLinkCredential)
    .where(inArray(peerLinkCredential.linkId, [...linkIds]));
  const credentials = new Map<string, string>();
  for (const row of rows) {
    // Retired rows must never re-enter a materialized config. Retiring rows
    // remain valid receiver admissions until the reverse-order stage removes
    // them; the sender selects only the exact generation named by its intent.
    if (row.state === "retired") {
      continue;
    }
    try {
      credentials.set(
        managedPeerCredentialKey(row.linkId, row.generation),
        decryptManagedPeerCredential(
          row.credentialCiphertext,
          row.linkId,
          row.generation,
        ),
      );
    } catch {
      throw new ManagedCompileError(
        "managed_state_inconsistent",
        `peer credential ${row.linkId}:${row.generation} cannot be decrypted`,
      );
    }
  }
  return credentials;
}

async function loadCustomOutboundSecrets(
  intent: ManagedStageIntent,
  database: Database,
): Promise<Map<string, Record<string, unknown>>> {
  const customOutboundIds = intent.outbounds
    .filter((outbound) => outbound.kind === "custom_proxy")
    .map((outbound) => outbound.outboundId);
  if (customOutboundIds.length === 0) {
    return new Map();
  }
  const rows = await database
    .select({
      id: managedOutbound.id,
      secretCiphertext: managedOutbound.secretCiphertext,
    })
    .from(managedOutbound)
    .where(inArray(managedOutbound.id, customOutboundIds));
  const secrets = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!row.secretCiphertext) continue;
    try {
      secrets.set(
        row.id,
        decryptManagedCustomProxySecret(row.secretCiphertext, row.id),
      );
    } catch {
      throw new ManagedCompileError(
        "managed_state_inconsistent",
        `custom proxy outbound ${row.id} secrets cannot be decrypted`,
      );
    }
  }
  return secrets;
}

interface CertificateRow {
  id: string;
  certificateId: string;
  version: number;
  certificateCiphertext: string;
  privateKeyCiphertext: string;
  domains: string[];
  notBefore: Date;
  notAfter: Date;
  fingerprintSha256: string;
}

async function loadCertificateRows(
  refs: readonly { certificateId: string; generation: number }[],
  database: Database,
): Promise<Map<string, CertificateRow>> {
  const ids = [...new Set(refs.map((ref) => ref.certificateId))];
  if (ids.length === 0) {
    return new Map();
  }
  const rows = await database
    .select()
    .from(certificateMaterial)
    .where(inArray(certificateMaterial.certificateId, ids));
  const byKey = new Map<string, CertificateRow>();
  for (const row of rows) {
    byKey.set(`${row.certificateId}:${row.version}`, row);
  }
  return byKey;
}

function decryptCertificateSecretOrFail(
  ciphertext: string,
  aad: string,
): string {
  try {
    return decryptCertificateSecret(ciphertext, aad);
  } catch {
    throw new ManagedCompileError(
      "managed_state_inconsistent",
      "managed certificate material cannot be decrypted",
    );
  }
}

async function loadPeerTlsMaterial(
  intent: ManagedStageIntent,
  database: Database,
): Promise<ManagedPeerTlsMaterial> {
  const receiverRefs = intent.peerInbounds
    .filter(
      (peer) =>
        peer.admissions.length > 0 &&
        peer.certificateId !== null &&
        peer.certificateGeneration !== null &&
        peer.tlsServerName !== null,
    )
    .map((peer) => ({
      certificateId: peer.certificateId!,
      generation: peer.certificateGeneration!,
      tlsServerName: peer.tlsServerName!,
      peer,
    }));
  const trustRefs = intent.outbounds.flatMap((outbound) => {
    if (
      outbound.kind !== "peer_link" ||
      outbound.trustMode !== "managed_certificate" ||
      outbound.tlsServerName === null
    ) {
      return [];
    }
    return outbound.trustedCertificates.map((trust) => ({
      ...trust,
      outbound,
    }));
  });
  const rows = await loadCertificateRows(
    [...receiverRefs, ...trustRefs],
    database,
  );

  const inbound: ManagedPeerTlsMaterial["inbound"] = [];
  const outboundTrust: ManagedPeerTlsMaterial["outboundTrust"] = [];
  for (const ref of receiverRefs) {
    const row = rows.get(`${ref.certificateId}:${ref.generation}`);
    if (
      !row ||
      row.fingerprintSha256 !== ref.peer.certificateFingerprintSha256
    ) {
      throw new ManagedCompileError(
        "missing_peer_tls_artifact",
        `peer inbound ${ref.peer.inboundId} certificate ${ref.certificateId}:${ref.generation} is missing or has a different fingerprint`,
      );
    }
    const artifact: CertificateArtifact = {
      certificateId: row.certificateId,
      generation: row.version,
      domains: [...row.domains],
      fingerprintSha256: row.fingerprintSha256,
      notBefore: row.notBefore.toISOString(),
      notAfter: row.notAfter.toISOString(),
      certificatePem: decryptCertificateSecretOrFail(
        row.certificateCiphertext,
        `certificate:${row.id}:certificate`,
      ),
      privateKeyPem: decryptCertificateSecretOrFail(
        row.privateKeyCiphertext,
        `certificate:${row.id}:private-key`,
      ),
    };
    const binding: ManagedPeerTlsBinding = {
      bindingId: formatManagedPeerTlsBindingId({
        direction: "inbound",
        ownerKind: "peer_inbound",
        ownerId: ref.peer.inboundId,
        certificateId: ref.certificateId,
        generation: ref.generation,
      }),
      runtimeTag: ref.peer.runtimeTag,
      direction: "inbound",
      ownerKind: "peer_inbound",
      ownerId: ref.peer.inboundId,
      certificateId: ref.certificateId,
      generation: ref.generation,
      fingerprintSha256: row.fingerprintSha256,
      serverName: ref.tlsServerName,
      usage: "identity_fullchain_and_key",
    };
    inbound.push({ binding, artifact });
  }

  for (const ref of trustRefs) {
    const row = rows.get(`${ref.certificateId}:${ref.generation}`);
    if (!row || row.fingerprintSha256 !== ref.fingerprintSha256) {
      throw new ManagedCompileError(
        "missing_peer_tls_artifact",
        `peer outbound ${ref.outbound.outboundId} trust ${ref.certificateId}:${ref.generation} is missing or has a different fingerprint`,
      );
    }
    const artifact: ManagedPeerTrustArtifact = {
      certificateId: row.certificateId,
      generation: row.version,
      domains: [...row.domains],
      fingerprintSha256: row.fingerprintSha256,
      notBefore: row.notBefore.toISOString(),
      notAfter: row.notAfter.toISOString(),
      certificatePem: decryptCertificateSecretOrFail(
        row.certificateCiphertext,
        `certificate:${row.id}:certificate`,
      ),
    };
    const serverName = ref.outbound.tlsServerName;
    if (serverName === null) {
      throw new ManagedCompileError(
        "managed_state_inconsistent",
        `peer outbound ${ref.outbound.outboundId} has no TLS server name`,
      );
    }
    const binding: ManagedPeerTlsBinding = {
      bindingId: formatManagedPeerTlsBindingId({
        direction: "outbound",
        ownerKind: "peer_outbound",
        ownerId: ref.outbound.outboundId,
        certificateId: ref.certificateId,
        generation: ref.generation,
      }),
      runtimeTag: ref.outbound.runtimeTag,
      direction: "outbound",
      ownerKind: "peer_outbound",
      ownerId: ref.outbound.outboundId,
      certificateId: ref.certificateId,
      generation: ref.generation,
      fingerprintSha256: row.fingerprintSha256,
      serverName,
      usage: "peer_ca_trust",
    };
    outboundTrust.push({ binding, artifact });
  }

  return { inbound, outboundTrust };
}
