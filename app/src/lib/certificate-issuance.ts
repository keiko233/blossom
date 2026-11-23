import type { AgentWsAcmeResultPayload } from "@blossom/contracts/agent-ws";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  notInArray,
  or,
} from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { type Database, db } from "@/db";
import {
  certificateIssuanceJob,
  certificateMaterial,
  certificateServer,
  managedCertificate,
  server,
} from "@/db/proxy-schema";
import type {
  AcmeProvider,
  CertificateDnsBrokerRecord,
  CertificateIssuanceJob,
  ManagedCertificate,
} from "@/db/proxy-schema";
import { ACME_PROVIDER_ENV_REQUIREMENTS } from "@/lib/acme-providers";
import {
  notifyAgentAcmeDnsAck,
  notifyAgentAcmeIssue,
  notifyAgentConfigChanged,
} from "@/lib/agent-notifications";
import {
  assertAuthorizedDnsChallenge,
  enforceAcmeJobFence,
  isAcmeCapableAgent,
  sameDomainSet,
  sanitizeCertificateIssuanceError,
} from "@/lib/certificate-acme";
import { encryptCertificateSecret } from "@/lib/certificate-crypto";
import { parseCertificateMaterial } from "@/lib/certificate-material";
import { getCloudflareDnsProvider } from "@/lib/dns-providers/cloudflare";
import type { DnsProvider } from "@/lib/dns-providers/types";
import { getServerEnv } from "@/lib/env";
import { BINDING_GENERATION_RESET_WRITE } from "@/lib/node-certificate-binding";
import { createSelfSignedCertificate } from "@/lib/self-signed-certificate";
import { invalidateDesiredConfigRevisionsAfterCommit } from "@/query/agent";

type CertificatePolicy = ManagedCertificate;
type IssuanceJob = CertificateIssuanceJob;

const LEASE_MS = 30_000;
const JOB_TTL_MS = 20 * 60_000;
const ACTIVE_JOB_STATES = ["dispatched", "awaiting_dns", "finalizing"] as const;

export function getCertificateDnsCapability(): {
  automatic: boolean;
  incomplete: boolean;
} {
  const env = getServerEnv();
  const hasToken = Boolean(env.CLOUDFLARE_DNS_API_TOKEN);
  const hasZone = Boolean(env.CLOUDFLARE_DNS_ZONE_ID);
  return { automatic: hasToken && hasZone, incomplete: hasToken !== hasZone };
}

export function getCertificateAcmeProviderCapabilities(): Record<
  AcmeProvider,
  { available: boolean; incomplete: boolean; requiredEnv: readonly string[] }
> {
  const env = getServerEnv();
  const zeroSslValues = [env.ACME_EAB_KID, env.ACME_EAB_HMAC_KEY];
  const zeroSslConfigured = zeroSslValues.filter(Boolean).length;
  return {
    letsencrypt: {
      available: true,
      incomplete: false,
      requiredEnv: ACME_PROVIDER_ENV_REQUIREMENTS.letsencrypt,
    },
    zerossl: {
      available: zeroSslConfigured === zeroSslValues.length,
      incomplete:
        zeroSslConfigured > 0 && zeroSslConfigured < zeroSslValues.length,
      requiredEnv: ACME_PROVIDER_ENV_REQUIREMENTS.zerossl,
    },
  };
}

async function persistMaterial(
  policy: CertificatePolicy,
  material: {
    certificatePem: string;
    privateKeyPem: string;
    notBefore: Date;
    notAfter: Date;
    fingerprintSha256: string;
  },
  database: Database = db,
) {
  const version = policy.desiredGeneration;
  let insertedMaterialId: string | null = null;
  const existing = await database
    .select({ id: certificateMaterial.id })
    .from(certificateMaterial)
    .where(
      and(
        eq(certificateMaterial.certificateId, policy.id),
        eq(certificateMaterial.version, version),
      ),
    );
  if (existing.length === 0) {
    const id = randomUUID();
    insertedMaterialId = id;
    await database.insert(certificateMaterial).values({
      id,
      certificateId: policy.id,
      version,
      certificateCiphertext: encryptCertificateSecret(
        material.certificatePem,
        `certificate:${id}:certificate`,
      ),
      privateKeyCiphertext: encryptCertificateSecret(
        material.privateKeyPem,
        `certificate:${id}:private-key`,
      ),
      domains: policy.domains,
      notBefore: material.notBefore,
      notAfter: material.notAfter,
      fingerprintSha256: material.fingerprintSha256,
    });
  }
  const [updated] = await database
    .update(managedCertificate)
    .set({
      state: "active",
      activeMaterialVersion: version,
      issuanceStateCiphertext: null,
      challenge: null,
      challengeApprovedAt: null,
      notBefore: material.notBefore,
      notAfter: material.notAfter,
      fingerprintSha256: material.fingerprintSha256,
      lastError: null,
    })
    .where(
      and(
        eq(managedCertificate.id, policy.id),
        eq(managedCertificate.desiredGeneration, version),
      ),
    )
    .returning({ id: managedCertificate.id });
  if (!updated) {
    if (insertedMaterialId) {
      await database
        .delete(certificateMaterial)
        .where(eq(certificateMaterial.id, insertedMaterialId));
    }
    throw new Error("Certificate generation changed before material commit");
  }
  const retained = await database
    .select({ id: certificateMaterial.id })
    .from(certificateMaterial)
    .where(eq(certificateMaterial.certificateId, policy.id))
    .orderBy(desc(certificateMaterial.version))
    .limit(2);
  if (retained.length === 2) {
    await database.delete(certificateMaterial).where(
      and(
        eq(certificateMaterial.certificateId, policy.id),
        notInArray(
          certificateMaterial.id,
          retained.map((item) => item.id),
        ),
      ),
    );
  }
  await database
    .update(certificateServer)
    .set({
      desiredGeneration: version,
      ...BINDING_GENERATION_RESET_WRITE,
    })
    .where(eq(certificateServer.certificateId, policy.id));
  // The installed material changes every bound server's compiled configuration
  // without moving its publish-gate sequence, so cached identifiers are dropped.
  await invalidateDesiredConfigRevisionsAfterCommit(undefined, database);
}

async function issueSelfSigned(policy: CertificatePolicy) {
  await persistMaterial(
    policy,
    await createSelfSignedCertificate({
      domains: policy.domains,
      validityDays: policy.selfSignedValidityDays,
    }),
  );
}

async function activeJob(
  certificateId: string,
  generation: number,
): Promise<IssuanceJob | null> {
  const [job] = await db
    .select()
    .from(certificateIssuanceJob)
    .where(
      and(
        eq(certificateIssuanceJob.certificateId, certificateId),
        eq(certificateIssuanceJob.generation, generation),
        inArray(certificateIssuanceJob.state, [...ACTIVE_JOB_STATES]),
      ),
    )
    .orderBy(desc(certificateIssuanceJob.createdAt))
    .limit(1);
  return job ?? null;
}

async function serverCanIssue(serverId: string) {
  const [row] = await db.select().from(server).where(eq(server.id, serverId));
  return row?.enabled && isAcmeCapableAgent(row.agentCapabilities) ? row : null;
}

async function resolveIssuer(policy: CertificatePolicy): Promise<{
  policy: CertificatePolicy;
  issuerServerId: string;
}> {
  if (policy.issuerServerId) {
    const issuer = await serverCanIssue(policy.issuerServerId);
    if (!issuer) {
      throw new Error(
        "The selected ACME issuer server is disabled, missing, or has not advertised acme-v1",
      );
    }
    return { policy, issuerServerId: issuer.id };
  }

  const bindings = await db
    .select({ server })
    .from(certificateServer)
    .innerJoin(server, eq(server.id, certificateServer.serverId))
    .where(
      and(
        eq(certificateServer.certificateId, policy.id),
        eq(certificateServer.enabled, true),
      ),
    );
  const issuer = bindings
    .map((binding) => binding.server)
    .find(
      (candidate) =>
        candidate.enabled && isAcmeCapableAgent(candidate.agentCapabilities),
    );
  if (!issuer) {
    throw new Error(
      "Select an enabled issuer server running a server-agent with acme-v1",
    );
  }

  const [updated] = await db
    .update(managedCertificate)
    .set({
      issuerServerId: issuer.id,
      issuanceMode: "agent_delegated",
    })
    .where(eq(managedCertificate.id, policy.id))
    .returning();
  return { policy: updated ?? policy, issuerServerId: issuer.id };
}

function acmeExternalAccountBinding(provider: AcmeProvider) {
  if (provider !== "zerossl") {
    return undefined;
  }
  const env = getServerEnv();
  if (!env.ACME_EAB_KID || !env.ACME_EAB_HMAC_KEY) {
    throw new Error(
      "ZeroSSL requires ACME_EAB_KID and ACME_EAB_HMAC_KEY in the deployment environment",
    );
  }
  return {
    kid: env.ACME_EAB_KID,
    hmacKey: env.ACME_EAB_HMAC_KEY,
  };
}

async function dispatchJob(job: IssuanceJob, policy: CertificatePolicy) {
  const provider = getCertificateAcmeProviderCapabilities()[job.acmeProvider];
  if (!provider.available) {
    throw new Error(
      `${job.acmeProvider} requires deployment environment variables: ${provider.requiredEnv.join(", ")}`,
    );
  }
  const externalAccountBinding = acmeExternalAccountBinding(job.acmeProvider);
  await notifyAgentAcmeIssue(job.issuerServerId, {
    jobId: job.id,
    certificateId: job.certificateId,
    generation: job.generation,
    domains: job.domains,
    ...(policy.acmeEmail ? { acmeEmail: policy.acmeEmail } : {}),
    acmeProvider: job.acmeProvider,
    acmeStaging: job.acmeStaging,
    challengeType: job.challengeType,
    ...(externalAccountBinding ? { externalAccountBinding } : {}),
  });
  await db
    .update(certificateIssuanceJob)
    .set({
      dispatchCount: job.dispatchCount + 1,
      lastDispatchedAt: new Date(),
    })
    .where(eq(certificateIssuanceJob.id, job.id));
  await db
    .update(managedCertificate)
    .set({
      state: policy.activeMaterialVersion ? "renewing" : "issuing",
      lastError: null,
    })
    .where(eq(managedCertificate.id, policy.id));
}

async function cleanupProviderRecords(
  records: readonly CertificateDnsBrokerRecord[],
  provider: DnsProvider | null,
): Promise<void> {
  if (!provider) {
    return;
  }
  for (const record of records) {
    if (!record.providerRecordId) {
      continue;
    }
    try {
      await provider.deleteTxt(record.providerRecordId);
    } catch (error) {
      console.warn(
        `certificate DNS cleanup failed: ${sanitizeCertificateIssuanceError(error)}`,
      );
    }
  }
}

async function expireJob(job: IssuanceJob) {
  await cleanupProviderRecords(job.dnsRecords, getCloudflareDnsProvider());
  const now = new Date();
  await db
    .update(certificateIssuanceJob)
    .set({
      state: "expired",
      dnsRecords: [],
      lastError: "Issuer agent did not complete the ACME job before expiry",
      completedAt: now,
    })
    .where(eq(certificateIssuanceJob.id, job.id));
  await db
    .update(managedCertificate)
    .set({
      state: "error",
      challenge: null,
      challengeApprovedAt: null,
      lastError: "Issuer agent did not complete the ACME job before expiry",
    })
    .where(
      and(
        eq(managedCertificate.id, job.certificateId),
        eq(managedCertificate.desiredGeneration, job.generation),
      ),
    );
}

async function createJob(policy: CertificatePolicy): Promise<void> {
  const now = new Date();
  const [claimed] = await db
    .update(managedCertificate)
    .set({
      issuanceLeaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      issuanceAttemptAt: now,
      state: policy.activeMaterialVersion ? "renewing" : "issuing",
      challenge: null,
      challengeApprovedAt: null,
      issuanceStateCiphertext: null,
      lastError: null,
    })
    .where(
      and(
        eq(managedCertificate.id, policy.id),
        or(
          isNull(managedCertificate.issuanceLeaseExpiresAt),
          lt(managedCertificate.issuanceLeaseExpiresAt, now),
        ),
      ),
    )
    .returning();
  if (!claimed) {
    return;
  }

  try {
    const existing = await activeJob(claimed.id, claimed.desiredGeneration);
    if (existing) {
      if (existing.challengeExpiresAt <= now) {
        await expireJob(existing);
      } else {
        await dispatchJob(existing, claimed);
        return;
      }
    }

    const resolved = await resolveIssuer(claimed);
    const effectivePolicy = resolved.policy;
    const [job] = await db
      .insert(certificateIssuanceJob)
      .values({
        id: randomUUID(),
        certificateId: effectivePolicy.id,
        generation: effectivePolicy.desiredGeneration,
        issuerServerId: resolved.issuerServerId,
        challengeType: effectivePolicy.challengeType,
        acmeProvider: effectivePolicy.acmeProvider,
        acmeStaging: effectivePolicy.acmeStaging,
        domains: effectivePolicy.domains,
        challengeExpiresAt: new Date(now.getTime() + JOB_TTL_MS),
      })
      .returning();
    if (!job) {
      throw new Error("Failed to create ACME issuance job");
    }
    await dispatchJob(job, effectivePolicy);
  } catch (error) {
    const message = sanitizeCertificateIssuanceError(error);
    await db
      .update(managedCertificate)
      .set({ state: "error", lastError: message })
      .where(eq(managedCertificate.id, claimed.id));
  } finally {
    await db
      .update(managedCertificate)
      .set({ issuanceLeaseExpiresAt: null })
      .where(eq(managedCertificate.id, claimed.id));
  }
}

async function hasDesiredMaterial(policy: CertificatePolicy) {
  const [material] = await db
    .select({ id: certificateMaterial.id })
    .from(certificateMaterial)
    .where(
      and(
        eq(certificateMaterial.certificateId, policy.id),
        eq(certificateMaterial.version, policy.desiredGeneration),
      ),
    );
  return Boolean(material);
}

async function advanceAcme(policy: CertificatePolicy): Promise<void> {
  if (await hasDesiredMaterial(policy)) {
    return;
  }
  const job = await activeJob(policy.id, policy.desiredGeneration);
  if (job) {
    if (job.challengeExpiresAt <= new Date()) {
      await expireJob(job);
      return;
    }
    try {
      await dispatchJob(job, policy);
    } catch (error) {
      await db
        .update(managedCertificate)
        .set({
          state: "error",
          lastError: sanitizeCertificateIssuanceError(error),
        })
        .where(eq(managedCertificate.id, policy.id));
    }
    return;
  }
  await createJob(policy);
}

async function issueOrAdvanceSelfSigned(
  policy: CertificatePolicy,
): Promise<void> {
  if (await hasDesiredMaterial(policy)) {
    return;
  }
  const now = new Date();
  const [claimed] = await db
    .update(managedCertificate)
    .set({
      issuanceLeaseExpiresAt: new Date(now.getTime() + LEASE_MS),
      issuanceAttemptAt: now,
      state: policy.activeMaterialVersion ? "renewing" : "issuing",
    })
    .where(
      and(
        eq(managedCertificate.id, policy.id),
        or(
          isNull(managedCertificate.issuanceLeaseExpiresAt),
          lt(managedCertificate.issuanceLeaseExpiresAt, now),
        ),
      ),
    )
    .returning();
  if (!claimed) {
    return;
  }
  try {
    await issueSelfSigned(claimed);
  } catch (error) {
    await db
      .update(managedCertificate)
      .set({
        state: "error",
        lastError: sanitizeCertificateIssuanceError(error),
      })
      .where(eq(managedCertificate.id, claimed.id));
  } finally {
    await db
      .update(managedCertificate)
      .set({ issuanceLeaseExpiresAt: null })
      .where(eq(managedCertificate.id, claimed.id));
  }
}

export async function advanceCertificateIssuance(
  certificateId?: string,
): Promise<void> {
  const policies = certificateId
    ? await db
        .select()
        .from(managedCertificate)
        .where(eq(managedCertificate.id, certificateId))
    : await db.select().from(managedCertificate);

  for (const selectedPolicy of policies) {
    let policy = selectedPolicy;
    if (policy.kind === "imported") {
      if (policy.notBefore !== null && policy.notAfter !== null) {
        const now = Date.now();
        const state =
          now < policy.notBefore.getTime()
            ? "not_yet_valid"
            : now >= policy.notAfter.getTime()
              ? "expired"
              : policy.activeMaterialVersion === null
                ? "pending"
                : "active";
        if (policy.state === state) continue;
        await db
          .update(managedCertificate)
          .set({ state })
          .where(eq(managedCertificate.id, policy.id));
      }
      continue;
    }

    const renewAt = policy.notAfter
      ? policy.notAfter.getTime() - policy.renewalDaysBeforeExpiry * 86_400_000
      : Number.POSITIVE_INFINITY;
    if (
      policy.activeMaterialVersion === policy.desiredGeneration &&
      renewAt <= Date.now()
    ) {
      const [renewing] = await db
        .update(managedCertificate)
        .set({
          desiredGeneration: policy.desiredGeneration + 1,
          state: "renewing",
        })
        .where(eq(managedCertificate.id, policy.id))
        .returning();
      if (renewing) policy = renewing;
    }

    if (policy.kind === "self_signed") {
      await issueOrAdvanceSelfSigned(policy);
    } else {
      await advanceAcme(policy);
    }
  }
}

async function sendDnsAck(
  job: IssuanceJob,
  fqdn: string,
  txtValue: string,
  accepted: boolean,
  error?: string,
): Promise<void> {
  await notifyAgentAcmeDnsAck(job.issuerServerId, {
    jobId: job.id,
    fqdn,
    txtValue,
    accepted,
    ...(error ? { error: error.slice(0, 2048) } : {}),
  });
}

export async function handleAcmeDnsPresent(
  serverId: string,
  payload: { jobId: string; fqdn: string; txtValue: string },
  database: Database = db,
): Promise<void> {
  const [job] = await database
    .select()
    .from(certificateIssuanceJob)
    .where(eq(certificateIssuanceJob.id, payload.jobId));
  if (!job) {
    return;
  }
  if (job.issuerServerId !== serverId) {
    await sendDnsAck(
      job,
      payload.fqdn,
      payload.txtValue,
      false,
      "issuer identity mismatch",
    );
    return;
  }
  if (
    job.state === "completed" ||
    job.state === "failed" ||
    job.state === "expired"
  ) {
    return;
  }
  const [policy] = await database
    .select()
    .from(managedCertificate)
    .where(eq(managedCertificate.id, job.certificateId));
  if (!policy) {
    await sendDnsAck(
      job,
      payload.fqdn,
      payload.txtValue,
      false,
      "certificate policy not found",
    );
    return;
  }
  try {
    enforceAcmeJobFence(
      {
        jobId: job.id,
        jobServerId: job.issuerServerId,
        jobGeneration: job.generation,
        desiredGeneration: policy.desiredGeneration,
        challengeExpiresAt: job.challengeExpiresAt,
      },
      serverId,
    );
    assertAuthorizedDnsChallenge(job.domains, payload.fqdn);
  } catch (error) {
    await sendDnsAck(
      job,
      payload.fqdn,
      payload.txtValue,
      false,
      sanitizeCertificateIssuanceError(error),
    );
    return;
  }

  const fqdn = payload.fqdn.toLowerCase();
  const existing = job.dnsRecords.find(
    (record) => record.fqdn === fqdn && record.value === payload.txtValue,
  );
  if (existing) {
    // A manual record has no provider id; the operator's approval is what
    // makes a retried present acknowledgeable.
    if (existing.providerRecordId || policy.challengeApprovedAt) {
      await sendDnsAck(job, fqdn, payload.txtValue, true);
    }
    return;
  }
  if (job.dnsRecords.length >= 100) {
    await sendDnsAck(
      job,
      fqdn,
      payload.txtValue,
      false,
      "DNS challenge bound exceeded",
    );
    return;
  }

  const provider = getCloudflareDnsProvider();
  let createdRecordId: string | null = null;
  try {
    if (provider) {
      createdRecordId = await provider.createTxt({
        fqdn,
        value: payload.txtValue,
      });
    }
    const record: CertificateDnsBrokerRecord = {
      fqdn,
      value: payload.txtValue,
      providerRecordId: createdRecordId,
    };
    const records = [...job.dnsRecords, record];
    await database
      .update(certificateIssuanceJob)
      .set({
        dnsRecords: records,
        state: provider ? "dispatched" : "awaiting_dns",
      })
      .where(eq(certificateIssuanceJob.id, job.id));
    await database
      .update(managedCertificate)
      .set({
        state: provider ? "issuing" : "waiting_dns",
        challenge: records.map(({ fqdn: name, value }) => ({
          name,
          type: "TXT",
          value,
        })),
        challengeApprovedAt: provider ? null : policy.challengeApprovedAt,
        lastError: null,
      })
      .where(eq(managedCertificate.id, policy.id));
    if (provider) {
      await sendDnsAck(job, fqdn, payload.txtValue, true);
    } else if (policy.challengeApprovedAt) {
      await sendDnsAck(job, fqdn, payload.txtValue, true);
    }
  } catch (error) {
    if (createdRecordId && provider) {
      await provider.deleteTxt(createdRecordId).catch(() => undefined);
    }
    await sendDnsAck(
      job,
      fqdn,
      payload.txtValue,
      false,
      sanitizeCertificateIssuanceError(error),
    );
  }
}

export async function handleAcmeDnsCleanup(
  serverId: string,
  payload: { jobId: string; fqdn: string; txtValue: string },
  database: Database = db,
): Promise<void> {
  const [job] = await database
    .select()
    .from(certificateIssuanceJob)
    .where(eq(certificateIssuanceJob.id, payload.jobId));
  if (!job) {
    return;
  }
  if (job.issuerServerId !== serverId) {
    return;
  }
  try {
    assertAuthorizedDnsChallenge(job.domains, payload.fqdn);
  } catch {
    return;
  }
  const fqdn = payload.fqdn.toLowerCase();
  const record = job.dnsRecords.find(
    (item) => item.fqdn === fqdn && item.value === payload.txtValue,
  );
  if (!record) {
    return;
  }
  if (record.providerRecordId) {
    const provider = getCloudflareDnsProvider();
    if (provider) {
      try {
        await provider.deleteTxt(record.providerRecordId);
      } catch (error) {
        console.warn(
          `certificate DNS cleanup failed: ${sanitizeCertificateIssuanceError(error)}`,
        );
      }
    }
  }
  await database
    .update(certificateIssuanceJob)
    .set({
      dnsRecords: job.dnsRecords.filter(
        (item) => !(item.fqdn === fqdn && item.value === payload.txtValue),
      ),
    })
    .where(eq(certificateIssuanceJob.id, job.id));
}

async function failJob(
  job: IssuanceJob,
  message: string,
  phase: string | null,
  database: Database = db,
): Promise<void> {
  const sanitized = sanitizeCertificateIssuanceError(message);
  await database
    .update(certificateIssuanceJob)
    .set({
      state: "failed",
      lastError: sanitized,
      lastErrorPhase: phase,
      completedAt: new Date(),
    })
    .where(eq(certificateIssuanceJob.id, job.id));
  await database
    .update(managedCertificate)
    .set({
      state: "error",
      challenge: null,
      challengeApprovedAt: null,
      lastError: sanitized,
    })
    .where(
      and(
        eq(managedCertificate.id, job.certificateId),
        eq(managedCertificate.desiredGeneration, job.generation),
      ),
    );
  await cleanupProviderRecords(job.dnsRecords, getCloudflareDnsProvider());
}

export async function handleAcmeResult(
  serverId: string,
  payload: AgentWsAcmeResultPayload,
  database: Database = db,
): Promise<void> {
  const [job] = await database
    .select()
    .from(certificateIssuanceJob)
    .where(eq(certificateIssuanceJob.id, payload.jobId));
  if (!job || job.issuerServerId !== serverId) {
    return;
  }
  const [policy] = await database
    .select()
    .from(managedCertificate)
    .where(eq(managedCertificate.id, job.certificateId));
  if (!policy) {
    return;
  }
  try {
    enforceAcmeJobFence(
      {
        jobId: job.id,
        jobServerId: job.issuerServerId,
        jobGeneration: job.generation,
        desiredGeneration: policy.desiredGeneration,
        challengeExpiresAt: job.challengeExpiresAt,
      },
      serverId,
    );
  } catch {
    return;
  }

  if (payload.error) {
    const claimNow = new Date();
    const [claimed] = await database
      .update(certificateIssuanceJob)
      .set({ state: "finalizing" })
      .where(
        and(
          eq(certificateIssuanceJob.id, job.id),
          eq(certificateIssuanceJob.issuerServerId, serverId),
          inArray(certificateIssuanceJob.state, [...ACTIVE_JOB_STATES]),
          gt(certificateIssuanceJob.challengeExpiresAt, claimNow),
        ),
      )
      .returning();
    if (!claimed) return;
    await failJob(job, payload.error, payload.errorPhase ?? null, database);
    return;
  }
  if (!payload.certificatePem || !payload.privateKeyPem) {
    return;
  }

  const claimNow = new Date();
  const [claimed] = await database
    .update(certificateIssuanceJob)
    .set({ state: "finalizing" })
    .where(
      and(
        eq(certificateIssuanceJob.id, job.id),
        eq(certificateIssuanceJob.issuerServerId, serverId),
        inArray(certificateIssuanceJob.state, [...ACTIVE_JOB_STATES]),
        gt(certificateIssuanceJob.challengeExpiresAt, claimNow),
      ),
    )
    .returning();
  if (!claimed) {
    return;
  }

  try {
    const material = await parseCertificateMaterial(
      payload.certificatePem,
      payload.privateKeyPem,
    );
    if (!sameDomainSet(policy.domains, material.domains)) {
      throw new Error(
        "Issued certificate names do not match the certificate policy",
      );
    }
    const now = new Date();
    if (
      material.notAfter <= now ||
      material.notBefore > new Date(now.getTime() + 300_000)
    ) {
      throw new Error(
        "Issued certificate validity is outside the accepted window",
      );
    }
    await persistMaterial(policy, material, database);
    await database
      .update(certificateIssuanceJob)
      .set({
        state: "completed",
        dnsRecords: [],
        lastError: null,
        lastErrorPhase: null,
        completedAt: now,
      })
      .where(eq(certificateIssuanceJob.id, job.id));
    await cleanupProviderRecords(job.dnsRecords, getCloudflareDnsProvider());
    const bindings = await database
      .select({ serverId: certificateServer.serverId })
      .from(certificateServer)
      .where(
        and(
          eq(certificateServer.certificateId, policy.id),
          eq(certificateServer.enabled, true),
        ),
      );
    await notifyAgentConfigChanged(
      bindings.map((binding) => binding.serverId),
      "certificate renewed",
      undefined,
      database,
    );
  } catch (error) {
    await failJob(
      job,
      sanitizeCertificateIssuanceError(error),
      payload.errorPhase ?? "certificate",
      database,
    );
  }
}

export async function continueCertificateDnsChallenge(
  certificateId: string,
): Promise<void> {
  const [policy] = await db
    .select()
    .from(managedCertificate)
    .where(eq(managedCertificate.id, certificateId));
  if (!policy) {
    throw new Error("Certificate not found");
  }
  const job = await activeJob(certificateId, policy.desiredGeneration);
  if (!job) {
    throw new Error("No active DNS challenge to approve");
  }
  const approvedAt = new Date();
  await db
    .update(certificateIssuanceJob)
    .set({ challengeApprovedAt: approvedAt })
    .where(eq(certificateIssuanceJob.id, job.id));
  await db
    .update(managedCertificate)
    .set({
      challengeApprovedAt: approvedAt,
      state: "issuing",
    })
    .where(eq(managedCertificate.id, certificateId));
  for (const record of job.dnsRecords) {
    await sendDnsAck(job, record.fqdn, record.value, true);
  }
}
