import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  certificateMaterial,
  certificateServer,
  managedCertificate,
} from "@/db/proxy-schema";
import { decryptCertificateSecret } from "@/lib/certificate-crypto";
import { advanceCertificateIssuance } from "@/lib/certificate-issuance";
import { BINDING_GENERATION_RESET_WRITE } from "@/lib/node-certificate-binding";
import { decideCertificateDeployment } from "@/orpc/proxy/singbox";

export async function getCertificateAgentContext(serverId: string) {
  // Serverless runtimes have no resident scheduler. Any agent config poll is a
  // wake-up signal for the global, lease-protected server-side issuer; the
  // calling agent never performs issuance or handles DNS credentials.
  await advanceCertificateIssuance();
  const rows = await db
    .select({ certificate: managedCertificate, binding: certificateServer })
    .from(certificateServer)
    .innerJoin(
      managedCertificate,
      eq(managedCertificate.id, certificateServer.certificateId),
    )
    .where(
      and(
        eq(certificateServer.serverId, serverId),
        eq(certificateServer.enabled, true),
      ),
    );
  const result = [];
  for (const row of rows) {
    const activeVersion = row.certificate.activeMaterialVersion;
    let material:
      | {
          certificatePem: string;
          privateKeyPem: string;
          notBefore: string;
          notAfter: string;
          fingerprintSha256: string;
        }
      | undefined;
    if (activeVersion !== null) {
      const [stored] = await db
        .select()
        .from(certificateMaterial)
        .where(
          and(
            eq(certificateMaterial.certificateId, row.certificate.id),
            eq(certificateMaterial.version, activeVersion),
          ),
        );
      if (stored) {
        material = {
          certificatePem: decryptCertificateSecret(
            stored.certificateCiphertext,
            `certificate:${stored.id}:certificate`,
          ),
          privateKeyPem: decryptCertificateSecret(
            stored.privateKeyCiphertext,
            `certificate:${stored.id}:private-key`,
          ),
          notBefore: stored.notBefore.toISOString(),
          notAfter: stored.notAfter.toISOString(),
          fingerprintSha256: stored.fingerprintSha256,
        };
      }
    }
    result.push({ ...row, material });
  }
  return result;
}

export interface AgentCertificateDeployment {
  certificateId: string;
  generation: number;
  fingerprintSha256: string;
  installed: boolean;
  inUse: boolean;
  errorPhase?: string;
  errorMessage?: string;
}

/**
 * Applies heartbeat `certificateDeployments` to the server's certificate
 * bindings, stale-safely. Only an accepted deployment — enabled binding,
 * generation equal to the desired generation, fingerprint matching the active
 * certificate material — writes anything. Accepted deployments make the
 * binding truthful: `active`/`appliedGeneration` only while installed and in
 * use, `error` when a not-in-use deployment reports an error, otherwise
 * `pending` with applied state cleared; an `installed=false` report clears the
 * installed metadata. Every other entry is ignored and nothing is ever cleared
 * by absence, so a missing or stale deployment cannot falsify a previously
 * valid one.
 */
export async function applyAgentCertificateDeployments(
  serverId: string,
  deployments: AgentCertificateDeployment[],
): Promise<void> {
  if (deployments.length === 0) {
    return;
  }
  const bindingRows = await db
    .select()
    .from(certificateServer)
    .where(eq(certificateServer.serverId, serverId));
  const bindingByCertId = new Map(
    bindingRows.map((binding) => [binding.certificateId, binding]),
  );

  const certificateIds = [...new Set(deployments.map((d) => d.certificateId))];
  const certificateRows = await db
    .select()
    .from(managedCertificate)
    .where(inArray(managedCertificate.id, certificateIds));
  const activeVersionByCertId = new Map<string, number | null>();
  const activeFingerprintByCertId = new Map<string, string | null>();
  for (const policy of certificateRows) {
    if (policy.activeMaterialVersion === null) {
      activeVersionByCertId.set(policy.id, null);
      activeFingerprintByCertId.set(policy.id, null);
      continue;
    }
    const [material] = await db
      .select()
      .from(certificateMaterial)
      .where(
        and(
          eq(certificateMaterial.certificateId, policy.id),
          eq(certificateMaterial.version, policy.activeMaterialVersion),
        ),
      );
    activeVersionByCertId.set(policy.id, policy.activeMaterialVersion);
    activeFingerprintByCertId.set(
      policy.id,
      material?.fingerprintSha256 ?? null,
    );
  }

  const now = new Date();
  for (const deployment of deployments) {
    const binding = bindingByCertId.get(deployment.certificateId);
    if (!binding) {
      continue;
    }
    // Reconcile the binding's desired generation to the active material we
    // actually shipped. The old certificate-event sync is gone, so without
    // this a renewed certificate would never match the stored desired
    // generation and every subsequent deployment would be rejected as stale.
    const activeVersion =
      activeVersionByCertId.get(deployment.certificateId) ?? null;
    if (activeVersion !== null && binding.desiredGeneration !== activeVersion) {
      await db
        .update(certificateServer)
        .set({
          desiredGeneration: activeVersion,
          ...BINDING_GENERATION_RESET_WRITE,
        })
        .where(
          and(
            eq(certificateServer.certificateId, deployment.certificateId),
            eq(certificateServer.serverId, serverId),
          ),
        );
      binding.desiredGeneration = activeVersion;
      binding.state = "pending";
      binding.appliedGeneration = null;
      binding.inUseAt = null;
      binding.lastErrorPhase = null;
      binding.lastError = null;
    }
    const decision = decideCertificateDeployment(
      deployment,
      {
        enabled: binding.enabled,
        desiredGeneration: binding.desiredGeneration,
      },
      activeFingerprintByCertId.get(deployment.certificateId) ?? null,
    );
    if (decision === null) {
      continue;
    }

    const set: Partial<typeof certificateServer.$inferInsert> = {
      state: decision.state,
      appliedGeneration: decision.appliedGeneration,
      inUseAt:
        decision.appliedGeneration === null
          ? null
          : binding.state === "active" &&
              binding.appliedGeneration === decision.appliedGeneration
            ? (binding.inUseAt ?? now)
            : now,
      installedGeneration: decision.installedGeneration,
      installedFingerprintSha256: decision.installedFingerprintSha256,
      installedAt:
        decision.installedGeneration === null
          ? null
          : binding.installedGeneration === decision.installedGeneration &&
              binding.installedFingerprintSha256 ===
                decision.installedFingerprintSha256
            ? (binding.installedAt ?? now)
            : now,
      lastErrorPhase: decision.errorPhase,
      lastError: decision.errorMessage?.slice(0, 4096) ?? null,
    };
    await db
      .update(certificateServer)
      .set(set)
      .where(
        and(
          eq(certificateServer.certificateId, deployment.certificateId),
          eq(certificateServer.serverId, serverId),
        ),
      );
  }
}
