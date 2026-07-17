import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import {
  certificateMaterial,
  certificateServer,
  managedCertificate,
} from "@/db/proxy-schema";
import { decryptCertificateSecret } from "@/lib/certificate-crypto";
import { advanceCertificateIssuance } from "@/lib/certificate-issuance";

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
    .where(eq(certificateServer.serverId, serverId));
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

export async function recordCertificateAgentEvent(
  serverId: string,
  input: {
    actionId: string;
    certificateId: string;
    generation: number;
    state:
      | "issuing"
      | "waiting_dns"
      | "active"
      | "renewing"
      | "error"
      | "expired"
      | "removed";
    notBefore?: string;
    notAfter?: string;
    fingerprintSha256?: string;
    challenge?: Array<{ name: string; type: "TXT"; value: string }>;
    error?: string;
  },
): Promise<void> {
  const [policy] = await db
    .select()
    .from(managedCertificate)
    .where(eq(managedCertificate.id, input.certificateId));
  if (!policy) throw new Error("Certificate not found");
  const [binding] = await db
    .select()
    .from(certificateServer)
    .where(
      and(
        eq(certificateServer.certificateId, input.certificateId),
        eq(certificateServer.serverId, serverId),
      ),
    );
  if (!binding) throw new Error("Certificate is not bound to this server");
  if (input.state === "removed") {
    if (binding.enabled) {
      await db
        .update(certificateServer)
        .set({ appliedGeneration: null, state: "pending" })
        .where(
          and(
            eq(certificateServer.certificateId, input.certificateId),
            eq(certificateServer.serverId, serverId),
          ),
        );
    } else {
      await db
        .delete(certificateServer)
        .where(
          and(
            eq(certificateServer.certificateId, input.certificateId),
            eq(certificateServer.serverId, serverId),
          ),
        );
    }
    return;
  }

  await db
    .update(certificateServer)
    .set({
      state: input.state,
      appliedGeneration:
        input.state === "active" ? input.generation : binding.appliedGeneration,
      lastError: input.error?.slice(0, 4096) ?? null,
      lastActionId: input.actionId,
    })
    .where(
      and(
        eq(certificateServer.certificateId, input.certificateId),
        eq(certificateServer.serverId, serverId),
      ),
    );

  if (policy.activeMaterialVersion !== null) {
    await db
      .update(certificateServer)
      .set({ desiredGeneration: policy.activeMaterialVersion })
      .where(eq(certificateServer.certificateId, policy.id));
  }
}
