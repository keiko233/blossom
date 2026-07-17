import "reflect-metadata";
import {
  ExtendedKeyUsageExtension,
  KeyUsageFlags,
  KeyUsagesExtension,
  PemConverter,
  SubjectAlternativeNameExtension,
  X509CertificateGenerator,
} from "@peculiar/x509";
import * as acme from "acme-client";
import { and, desc, eq, isNull, lt, notInArray, or } from "drizzle-orm";
import { createHash, randomUUID, webcrypto } from "node:crypto";

import { db } from "@/db";
import {
  certificateMaterial,
  certificateServer,
  managedCertificate,
} from "@/db/proxy-schema";
import {
  decryptCertificateSecret,
  encryptCertificateSecret,
} from "@/lib/certificate-crypto";
import { getServerEnv } from "@/lib/env";

type CertificatePolicy = typeof managedCertificate.$inferSelect;

interface DnsRecord {
  name: string;
  type: "TXT";
  value: string;
}

interface CloudflareRecord {
  recordId: string;
}

interface AcmeState {
  accountKeyPem: string;
  accountUrl: string;
  order: Parameters<acme.Client["getOrder"]>[0];
  certificateKeyPem: string;
  csrBase64: string;
  challenges: Array<{
    challenge: Parameters<acme.Client["completeChallenge"]>[0];
    record: DnsRecord;
  }>;
  cloudflareRecords: CloudflareRecord[];
  submittedCount: number;
  phase: "dns_creating" | "prepared" | "submitted" | "finalized";
  preparedAt: string;
}

const LEASE_MS = 25_000;
const DNS_SETTLE_MS = 30_000;

const acmeAxios = (
  acme as typeof acme & {
    axios: { defaults: { adapter?: string | string[] } };
  }
).axios;
acmeAxios.defaults.adapter = "fetch";

export function getCertificateDnsCapability(): {
  automatic: boolean;
  incomplete: boolean;
} {
  const env = getServerEnv();
  const hasToken = Boolean(env.CLOUDFLARE_DNS_API_TOKEN);
  const hasZone = Boolean(env.CLOUDFLARE_DNS_ZONE_ID);
  return { automatic: hasToken && hasZone, incomplete: hasToken !== hasZone };
}

function cloudflareConfig(): { token: string; zoneId: string } {
  const env = getServerEnv();
  if (!env.CLOUDFLARE_DNS_API_TOKEN || !env.CLOUDFLARE_DNS_ZONE_ID) {
    throw new Error("Cloudflare DNS automation is not configured");
  }
  return {
    token: env.CLOUDFLARE_DNS_API_TOKEN,
    zoneId: env.CLOUDFLARE_DNS_ZONE_ID,
  };
}

function pemPrivateKey(raw: ArrayBuffer): string {
  return PemConverter.encode(raw, "PRIVATE KEY");
}

function issuanceAad(certificateId: string): string {
  return `certificate:${certificateId}:issuance`;
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
) {
  const version = policy.desiredGeneration;
  const existing = await db
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
    await db.insert(certificateMaterial).values({
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
      notBefore: material.notBefore,
      notAfter: material.notAfter,
      fingerprintSha256: material.fingerprintSha256,
    });
    const retained = await db
      .select({ id: certificateMaterial.id })
      .from(certificateMaterial)
      .where(eq(certificateMaterial.certificateId, policy.id))
      .orderBy(desc(certificateMaterial.version))
      .limit(2);
    if (retained.length === 2) {
      await db.delete(certificateMaterial).where(
        and(
          eq(certificateMaterial.certificateId, policy.id),
          notInArray(
            certificateMaterial.id,
            retained.map((item) => item.id),
          ),
        ),
      );
    }
  }
  await db
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
    .where(eq(managedCertificate.id, policy.id));
  await db
    .update(certificateServer)
    .set({ desiredGeneration: version, state: "pending", lastError: null })
    .where(eq(certificateServer.certificateId, policy.id));
}

async function issueSelfSigned(policy: CertificatePolicy) {
  const algorithm = { name: "ECDSA", namedCurve: "P-256" } as const;
  const keys = await webcrypto.subtle.generateKey(algorithm, true, [
    "sign",
    "verify",
  ]);
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(
    notBefore.getTime() + policy.selfSignedValidityDays * 86_400_000,
  );
  const certificate = await X509CertificateGenerator.createSelfSigned(
    {
      serialNumber: createHash("sha256")
        .update(randomUUID())
        .digest("hex")
        .slice(0, 32),
      name: `CN=${policy.domains[0]}`,
      notBefore,
      notAfter,
      signingAlgorithm: { name: "ECDSA", hash: "SHA-256" },
      keys,
      extensions: [
        new SubjectAlternativeNameExtension(
          policy.domains.map((value) => ({ type: "dns" as const, value })),
        ),
        new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true),
        new ExtendedKeyUsageExtension(["1.3.6.1.5.5.7.3.1"]),
      ],
    },
    webcrypto as Crypto,
  );
  const privateKey = await webcrypto.subtle.exportKey("pkcs8", keys.privateKey);
  await persistMaterial(policy, {
    certificatePem: certificate.toString("pem"),
    privateKeyPem: pemPrivateKey(privateKey),
    notBefore,
    notAfter,
    fingerprintSha256: createHash("sha256")
      .update(Buffer.from(certificate.rawData))
      .digest("hex"),
  });
}

async function createCloudflareRecord(record: DnsRecord) {
  const { token, zoneId } = cloudflareConfig();
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "TXT",
        name: record.name,
        content: record.value,
        ttl: 60,
      }),
    },
  );
  if (!response.ok)
    throw new Error(`Cloudflare TXT creation failed (${response.status})`);
  const result = (await response.json()) as { result?: { id?: string } };
  if (!result.result?.id)
    throw new Error("Cloudflare did not return a record id");
  return { recordId: result.result.id };
}

async function cleanupCloudflare(records: CloudflareRecord[]) {
  const { token, zoneId } = cloudflareConfig();
  await Promise.allSettled(
    records.map((record) =>
      fetch(
        `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.recordId}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      ),
    ),
  );
}

function acmeClient(policy: CertificatePolicy, state: AcmeState) {
  return new acme.Client({
    directoryUrl: policy.acmeStaging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production,
    accountKey: state.accountKeyPem,
    accountUrl: state.accountUrl,
    backoffAttempts: 1,
  });
}

async function prepareAcme(policy: CertificatePolicy): Promise<AcmeState> {
  const accountKey = (
    await acme.crypto.createPrivateEcdsaKey("P-256")
  ).toString();
  const client = new acme.Client({
    directoryUrl: policy.acmeStaging
      ? acme.directory.letsencrypt.staging
      : acme.directory.letsencrypt.production,
    accountKey,
    backoffAttempts: 1,
  });
  await client.createAccount({
    termsOfServiceAgreed: true,
    contact: policy.acmeEmail ? [`mailto:${policy.acmeEmail}`] : undefined,
  });
  const certificateKey = await acme.crypto.createPrivateEcdsaKey("P-256");
  const [, csr] = await acme.crypto.createCsr(
    { commonName: policy.domains[0], altNames: policy.domains },
    certificateKey,
  );
  const order = await client.createOrder({
    identifiers: policy.domains.map((value) => ({ type: "dns", value })),
  });
  const authorizations = await client.getAuthorizations(order);
  const challenges = await Promise.all(
    authorizations.map(async (authorization) => {
      const challenge = authorization.challenges.find(
        (item) => item.type === "dns-01",
      );
      if (!challenge) throw new Error("ACME server did not offer dns-01");
      const value = await client.getChallengeKeyAuthorization(challenge);
      const domain = authorization.identifier.value.replace(/^\*\./, "");
      return {
        challenge,
        record: {
          name: `_acme-challenge.${domain}`,
          type: "TXT" as const,
          value,
        },
      };
    }),
  );
  return {
    accountKeyPem: accountKey,
    accountUrl: client.getAccountUrl(),
    order,
    certificateKeyPem: certificateKey.toString(),
    csrBase64: csr.toString("base64"),
    challenges,
    cloudflareRecords: [],
    submittedCount: 0,
    phase: policy.dnsMode === "cloudflare" ? "dns_creating" : "prepared",
    preparedAt: new Date().toISOString(),
  };
}

async function saveAcmeState(
  policy: CertificatePolicy,
  state: AcmeState,
  status: "issuing" | "waiting_dns" = "issuing",
) {
  await db
    .update(managedCertificate)
    .set({
      state: status,
      challenge: state.challenges.map((item) => item.record),
      lastError: null,
      issuanceStateCiphertext: encryptCertificateSecret(
        JSON.stringify(state),
        issuanceAad(policy.id),
      ),
    })
    .where(eq(managedCertificate.id, policy.id));
}

async function advanceAcme(policy: CertificatePolicy) {
  let state: AcmeState | null = policy.issuanceStateCiphertext
    ? JSON.parse(
        decryptCertificateSecret(
          policy.issuanceStateCiphertext,
          issuanceAad(policy.id),
        ),
      )
    : null;
  if (!state) {
    state = await prepareAcme(policy);
    await saveAcmeState(
      policy,
      state,
      policy.dnsMode === "manual" ? "waiting_dns" : "issuing",
    );
    return;
  }

  const client = acmeClient(policy, state);
  if (state.phase === "dns_creating") {
    const item = state.challenges[state.cloudflareRecords.length];
    if (item)
      state.cloudflareRecords.push(await createCloudflareRecord(item.record));
    if (state.cloudflareRecords.length === state.challenges.length) {
      state.phase = "prepared";
      state.preparedAt = new Date().toISOString();
    }
  } else if (state.phase === "prepared") {
    const canSubmit =
      (policy.dnsMode === "manual" && policy.challengeApprovedAt !== null) ||
      (policy.dnsMode === "cloudflare" &&
        Date.now() - new Date(state.preparedAt).getTime() >= DNS_SETTLE_MS);
    if (!canSubmit) {
      await saveAcmeState(policy, state, "waiting_dns");
      return;
    }
    const item = state.challenges[state.submittedCount];
    if (item) {
      await client.completeChallenge(item.challenge);
      state.submittedCount += 1;
    }
    if (state.submittedCount === state.challenges.length)
      state.phase = "submitted";
  } else if (state.phase === "submitted") {
    const authorizations = await client.getAuthorizations(state.order);
    const invalidAuthorization = authorizations.find(
      (item) => item.status === "invalid",
    );
    if (invalidAuthorization) {
      if (policy.dnsMode === "cloudflare")
        await cleanupCloudflare(state.cloudflareRecords);
      await db
        .update(managedCertificate)
        .set({
          issuanceStateCiphertext: null,
          challenge: null,
          challengeApprovedAt: null,
        })
        .where(eq(managedCertificate.id, policy.id));
      throw new Error("ACME DNS authorization failed");
    }
    if (!authorizations.every((item) => item.status === "valid")) return;
    state.order = await client.finalizeOrder(
      state.order,
      Buffer.from(state.csrBase64, "base64"),
    );
    state.phase = "finalized";
  } else {
    state.order = await client.getOrder(state.order);
    if (state.order.status !== "valid") return;
    const certificatePem = await client.getCertificate(state.order);
    const info = acme.crypto.readCertificateInfo(certificatePem);
    await persistMaterial(policy, {
      certificatePem,
      privateKeyPem: state.certificateKeyPem,
      notBefore: info.notBefore,
      notAfter: info.notAfter,
      fingerprintSha256: createHash("sha256")
        .update(Buffer.from(acme.crypto.splitPemChain(certificatePem)[0]!))
        .digest("hex"),
    });
    if (policy.dnsMode === "cloudflare")
      await cleanupCloudflare(state.cloudflareRecords);
    return;
  }
  await saveAcmeState(policy, state);
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
    if (policy.kind === "acme" && policy.issuanceStateCiphertext === null) {
      const dnsMode = getCertificateDnsCapability().automatic
        ? "cloudflare"
        : "manual";
      if (policy.dnsMode !== dnsMode) {
        const [updated] = await db
          .update(managedCertificate)
          .set({ dnsMode })
          .where(eq(managedCertificate.id, policy.id))
          .returning();
        if (updated) policy = updated;
      }
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
    const [material] = await db
      .select({ id: certificateMaterial.id })
      .from(certificateMaterial)
      .where(
        and(
          eq(certificateMaterial.certificateId, policy.id),
          eq(certificateMaterial.version, policy.desiredGeneration),
        ),
      );
    if (material) continue;
    const waitingForManualDns =
      policy.kind === "acme" &&
      policy.dnsMode === "manual" &&
      policy.issuanceStateCiphertext !== null &&
      policy.challengeApprovedAt === null &&
      policy.state === "waiting_dns";
    if (waitingForManualDns) continue;

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
    if (!claimed) continue;
    try {
      if (policy.kind === "self_signed") await issueSelfSigned(claimed);
      else await advanceAcme(claimed);
    } catch (error) {
      await db
        .update(managedCertificate)
        .set({ state: "error", lastError: String(error).slice(0, 4096) })
        .where(eq(managedCertificate.id, policy.id));
    } finally {
      await db
        .update(managedCertificate)
        .set({ issuanceLeaseExpiresAt: null })
        .where(eq(managedCertificate.id, policy.id));
    }
  }
}
