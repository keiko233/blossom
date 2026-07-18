import { createServerFn } from "@tanstack/react-start";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import {
  certificateMaterial,
  certificateServer,
  managedCertificate,
  node,
  server,
} from "@/db/proxy-schema";
import { encryptCertificateSecret } from "@/lib/certificate-crypto";
import {
  assertImportedCertificateKind,
  importedMaterialState,
  planImportedReplacement,
  planPendingImportedActivation,
  planPendingImportedDiscard,
  type ImportedCertificateState,
} from "@/lib/certificate-import-lifecycle";
import {
  getCertificateAcmeProviderCapabilities,
  advanceCertificateIssuance,
  getCertificateDnsCapability,
} from "@/lib/certificate-issuance";
import {
  classifyImportedValidity,
  parseCertificateMaterial,
  type ParsedCertificateMaterial,
} from "@/lib/certificate-material";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  certificateIdSchema,
  certificateMaterialActionSchema,
  createCertificateSchema,
  createImportedCertificateSchema,
  replaceImportedCertificateMaterialSchema,
} from "@/orpc/proxy/schema";

export const CERTIFICATES_QUERY_KEY = ["admin", "certificates"] as const;
export const CERTIFICATE_CAPABILITY_QUERY_KEY = [
  "admin",
  "certificate-capability",
] as const;

export const getCertificateCapability = createServerFn({
  method: "GET",
}).handler(async () => {
  await ensureAdmin();
  return {
    ...getCertificateDnsCapability(),
    acmeProviders: getCertificateAcmeProviderCapabilities(),
  };
});

export const listCertificates = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();
    const certificates = await db
      .select({
        id: managedCertificate.id,
        name: managedCertificate.name,
        kind: managedCertificate.kind,
        domains: managedCertificate.domains,
        acmeEmail: managedCertificate.acmeEmail,
        acmeProvider: managedCertificate.acmeProvider,
        acmeStaging: managedCertificate.acmeStaging,
        dnsMode: managedCertificate.dnsMode,
        state: managedCertificate.state,
        desiredGeneration: managedCertificate.desiredGeneration,
        activeMaterialVersion: managedCertificate.activeMaterialVersion,
        pendingMaterialVersion: managedCertificate.pendingMaterialVersion,
        notBefore: managedCertificate.notBefore,
        notAfter: managedCertificate.notAfter,
        fingerprintSha256: managedCertificate.fingerprintSha256,
        challenge: managedCertificate.challenge,
        lastError: managedCertificate.lastError,
        createdAt: managedCertificate.createdAt,
        updatedAt: managedCertificate.updatedAt,
      })
      .from(managedCertificate)
      .orderBy(asc(managedCertificate.name));
    const bindings = await db
      .select({
        certificateServer,
        server: { id: server.id, name: server.name },
      })
      .from(certificateServer)
      .innerJoin(server, eq(server.id, certificateServer.serverId));
    const pendingVersionByCertificate = new Map<string, number>();
    for (const certificate of certificates) {
      if (certificate.pendingMaterialVersion !== null) {
        pendingVersionByCertificate.set(
          certificate.id,
          certificate.pendingMaterialVersion,
        );
      }
    }
    let pendingMaterials: Array<{
      certificateId: string;
      version: number;
      domains: string[];
      notBefore: Date;
      notAfter: Date;
      fingerprintSha256: string;
    }> = [];
    if (pendingVersionByCertificate.size > 0) {
      pendingMaterials = await db
        .select({
          certificateId: certificateMaterial.certificateId,
          version: certificateMaterial.version,
          domains: certificateMaterial.domains,
          notBefore: certificateMaterial.notBefore,
          notAfter: certificateMaterial.notAfter,
          fingerprintSha256: certificateMaterial.fingerprintSha256,
        })
        .from(certificateMaterial)
        .where(
          and(
            inArray(certificateMaterial.certificateId, [
              ...pendingVersionByCertificate.keys(),
            ]),
            inArray(certificateMaterial.version, [
              ...pendingVersionByCertificate.values(),
            ]),
          ),
        );
    }
    return certificates.map((certificate) => ({
      ...certificate,
      pendingMaterial: pendingMaterials.find(
        (material) =>
          material.certificateId === certificate.id &&
          material.version === certificate.pendingMaterialVersion,
      ),
      servers: bindings
        .filter(
          (item) =>
            item.certificateServer.certificateId === certificate.id &&
            item.certificateServer.enabled,
        )
        .map((item) => ({ ...item.certificateServer, server: item.server })),
    }));
  },
);

export const reconcileCertificates = createServerFn({ method: "POST" }).handler(
  async () => {
    await ensureAdmin();
    await advanceCertificateIssuance();
    return { ok: true };
  },
);

export const createCertificate = createServerFn({ method: "POST" })
  .validator(createCertificateSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    if (data.kind === "acme") {
      const capability =
        getCertificateAcmeProviderCapabilities()[data.acmeProvider];
      if (!capability.available) {
        throw new Error(
          `${data.acmeProvider} requires deployment environment variables: ${capability.requiredEnv.join(", ")}`,
        );
      }
    }
    const id = randomUUID();
    const dnsCapability = getCertificateDnsCapability();
    const [created] = await db
      .insert(managedCertificate)
      .values({
        id,
        name: data.name,
        kind: data.kind,
        domains: [...new Set(data.domains.map((name) => name.toLowerCase()))],
        acmeEmail:
          data.kind === "acme" && data.acmeEmail ? data.acmeEmail : null,
        acmeProvider: data.kind === "acme" ? data.acmeProvider : "letsencrypt",
        acmeStaging: data.kind === "acme" && data.acmeStaging,
        dnsMode:
          data.kind === "acme"
            ? dnsCapability.automatic
              ? "cloudflare"
              : "manual"
            : null,
        selfSignedValidityDays: data.selfSignedValidityDays,
        renewalDaysBeforeExpiry: data.renewalDaysBeforeExpiry,
      })
      .returning();
    await advanceCertificateIssuance(id);
    return created!;
  });

export const deleteCertificate = createServerFn({ method: "POST" })
  .validator(certificateIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [used] = await db
      .select({ id: node.id })
      .from(node)
      .where(eq(node.certificateId, data.id));
    if (used) throw new Error("Certificate is still assigned to a node");
    const [binding] = await db
      .select({ serverId: certificateServer.serverId })
      .from(certificateServer)
      .where(eq(certificateServer.certificateId, data.id));
    if (binding) {
      throw new Error(
        "Certificate is still assigned to a server or awaiting removal",
      );
    }
    const [row] = await db
      .delete(managedCertificate)
      .where(eq(managedCertificate.id, data.id))
      .returning();
    if (!row) throw new Error("Not found");
    return row;
  });

export const renewCertificate = createServerFn({ method: "POST" })
  .validator(certificateIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const [policy] = await db
      .select({
        generation: managedCertificate.desiredGeneration,
        kind: managedCertificate.kind,
      })
      .from(managedCertificate)
      .where(eq(managedCertificate.id, data.id));
    if (!policy) throw new Error("Not found");
    if (policy.kind === "imported") {
      throw new Error("Imported certificates cannot be renewed automatically");
    }
    const generation = policy.generation + 1;
    await db
      .update(managedCertificate)
      .set({
        desiredGeneration: generation,
        state: "renewing",
        lastError: null,
      })
      .where(eq(managedCertificate.id, data.id));
    await advanceCertificateIssuance(data.id);
    return { generation };
  });

export const continueCertificateDnsChallenge = createServerFn({
  method: "POST",
})
  .validator(certificateIdSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    await db
      .update(managedCertificate)
      .set({ challengeApprovedAt: new Date(), state: "issuing" })
      .where(eq(managedCertificate.id, data.id));
    await advanceCertificateIssuance(data.id);
    return { ok: true };
  });

// --- Imported certificate lifecycle -----------------------------------------

type ManagedCertificateRow = typeof managedCertificate.$inferSelect;

async function withCertificateTransaction<T>(
  callback: (tx: typeof db) => Promise<T>,
): Promise<T> {
  if ("transaction" in db && typeof db.transaction === "function") {
    return (
      db as unknown as {
        transaction: <Result>(
          run: (tx: typeof db) => Promise<Result>,
        ) => Promise<Result>;
      }
    ).transaction(callback);
  }
  return callback(db);
}

async function lockCertificate(
  tx: typeof db,
  certificateId: string,
): Promise<ManagedCertificateRow | undefined> {
  const rows = await tx
    .select()
    .from(managedCertificate)
    .where(eq(managedCertificate.id, certificateId))
    .for("update");
  return rows[0];
}

function encryptImportedMaterial(
  materialId: string,
  certificatePem: string,
  privateKeyPem: string,
) {
  return {
    certificateCiphertext: encryptCertificateSecret(
      certificatePem,
      `certificate:${materialId}:certificate`,
    ),
    privateKeyCiphertext: encryptCertificateSecret(
      privateKeyPem,
      `certificate:${materialId}:private-key`,
    ),
  };
}

async function insertImportedMaterial(
  tx: typeof db,
  certificateId: string,
  version: number,
  parsed: ParsedCertificateMaterial,
): Promise<string> {
  const id = randomUUID();
  await tx.insert(certificateMaterial).values({
    id,
    certificateId,
    version,
    ...encryptImportedMaterial(id, parsed.certificatePem, parsed.privateKeyPem),
    domains: parsed.domains,
    notBefore: parsed.notBefore,
    notAfter: parsed.notAfter,
    fingerprintSha256: parsed.fingerprintSha256,
  });
  return id;
}

async function pruneImportedMaterial(
  tx: typeof db,
  certificateId: string,
  retainedVersions: number[],
) {
  if (retainedVersions.length === 0) return;
  await tx
    .delete(certificateMaterial)
    .where(
      and(
        eq(certificateMaterial.certificateId, certificateId),
        notInArray(certificateMaterial.version, retainedVersions),
      ),
    );
}

async function runImportedMaterialReplace(
  certificateId: string,
  parsed: ParsedCertificateMaterial,
): Promise<{ activeVersion: number | null; pendingVersion: number | null }> {
  const runInTx = async (tx: typeof db) => {
    const policy = await lockCertificate(tx, certificateId);
    if (!policy) throw new Error("Certificate not found");
    assertImportedCertificateKind(policy.kind);

    const activeVersion = policy.activeMaterialVersion;
    const pendingVersion = policy.pendingMaterialVersion;
    const plan = planImportedReplacement(
      {
        activeMaterialVersion: activeVersion,
        pendingMaterialVersion: pendingVersion,
        desiredGeneration: policy.desiredGeneration,
        state: policy.state as ImportedCertificateState,
      },
      parsed,
    );
    const targetVersion = plan.targetVersion;
    if (pendingVersion !== null) {
      await tx
        .delete(certificateMaterial)
        .where(
          and(
            eq(certificateMaterial.certificateId, certificateId),
            eq(certificateMaterial.version, targetVersion),
          ),
        );
    }

    await insertImportedMaterial(tx, certificateId, targetVersion, parsed);

    await pruneImportedMaterial(tx, certificateId, plan.retainedVersions);

    if (plan.notifyServers) {
      await tx
        .update(managedCertificate)
        .set({
          state: "active",
          activeMaterialVersion: plan.activeMaterialVersion,
          pendingMaterialVersion: plan.pendingMaterialVersion,
          desiredGeneration: plan.desiredGeneration,
          notBefore: parsed.notBefore,
          notAfter: parsed.notAfter,
          fingerprintSha256: parsed.fingerprintSha256,
          domains: parsed.domains,
          lastError: null,
        })
        .where(eq(managedCertificate.id, certificateId));
      await tx
        .update(certificateServer)
        .set({
          desiredGeneration: targetVersion,
          state: "pending",
          lastError: null,
        })
        .where(eq(certificateServer.certificateId, certificateId));
      return { activeVersion: targetVersion, pendingVersion: null };
    }

    const pendingUpdate = plan.replaceCurrentMetadata
      ? {
          state: plan.state,
          pendingMaterialVersion: plan.pendingMaterialVersion,
          notBefore: parsed.notBefore,
          notAfter: parsed.notAfter,
          fingerprintSha256: parsed.fingerprintSha256,
          domains: parsed.domains,
          lastError: null,
        }
      : {
          pendingMaterialVersion: plan.pendingMaterialVersion,
          lastError: null,
        };
    await tx
      .update(managedCertificate)
      .set(pendingUpdate)
      .where(eq(managedCertificate.id, certificateId));
    return { activeVersion, pendingVersion: targetVersion };
  };

  return withCertificateTransaction(runInTx);
}

export const importCertificate = createServerFn({ method: "POST" })
  .validator(createImportedCertificateSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const parsed = await parseCertificateMaterial(
      data.fullchainPem,
      data.privateKeyPem,
    );
    const id = randomUUID();
    const validity = classifyImportedValidity(parsed);
    const initialVersion = 1;
    const runInTx = async (tx: typeof db) => {
      const [created] = await tx
        .insert(managedCertificate)
        .values({
          id,
          name: data.name,
          kind: "imported",
          domains: parsed.domains,
          acmeProvider: "letsencrypt",
          acmeStaging: false,
          selfSignedValidityDays: 365,
          renewalDaysBeforeExpiry: 30,
          state: importedMaterialState(parsed, validity === "current"),
          desiredGeneration: initialVersion,
          activeMaterialVersion: validity === "current" ? initialVersion : null,
          pendingMaterialVersion:
            validity === "current" ? null : initialVersion,
          notBefore: parsed.notBefore,
          notAfter: parsed.notAfter,
          fingerprintSha256: parsed.fingerprintSha256,
        })
        .returning();
      await insertImportedMaterial(tx, id, initialVersion, parsed);
      return created!;
    };
    return withCertificateTransaction(runInTx);
  });

export const replaceImportedCertificate = createServerFn({
  method: "POST",
})
  .validator(replaceImportedCertificateMaterialSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const parsed = await parseCertificateMaterial(
      data.fullchainPem,
      data.privateKeyPem,
    );
    await runImportedMaterialReplace(data.certificateId, parsed);
    return { ok: true };
  });

export const activatePendingImportedCertificate = createServerFn({
  method: "POST",
})
  .validator(certificateMaterialActionSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const runInTx = async (tx: typeof db) => {
      const policy = await lockCertificate(tx, data.certificateId);
      if (!policy) throw new Error("Certificate not found");
      assertImportedCertificateKind(policy.kind);
      if (policy.pendingMaterialVersion === null) {
        throw new Error("No pending material to activate");
      }
      const pendingVersion = policy.pendingMaterialVersion;
      const [pendingMaterial] = await tx
        .select({
          domains: certificateMaterial.domains,
          notBefore: certificateMaterial.notBefore,
          notAfter: certificateMaterial.notAfter,
          fingerprintSha256: certificateMaterial.fingerprintSha256,
        })
        .from(certificateMaterial)
        .where(
          and(
            eq(certificateMaterial.certificateId, data.certificateId),
            eq(certificateMaterial.version, pendingVersion),
          ),
        );
      if (!pendingMaterial) throw new Error("Pending material not found");
      const plan = planPendingImportedActivation(
        pendingVersion,
        pendingMaterial,
      );
      await tx
        .update(managedCertificate)
        .set({
          state: plan.state,
          activeMaterialVersion: plan.activeMaterialVersion,
          pendingMaterialVersion: plan.pendingMaterialVersion,
          desiredGeneration: plan.desiredGeneration,
          domains: pendingMaterial.domains,
          notBefore: pendingMaterial.notBefore,
          notAfter: pendingMaterial.notAfter,
          fingerprintSha256: pendingMaterial.fingerprintSha256,
          lastError: null,
        })
        .where(eq(managedCertificate.id, data.certificateId));
      await tx
        .update(certificateServer)
        .set({
          desiredGeneration: pendingVersion,
          state: "pending",
          lastError: null,
        })
        .where(eq(certificateServer.certificateId, data.certificateId));
      return { activeVersion: pendingVersion };
    };
    return withCertificateTransaction(runInTx);
  });

export const discardPendingImportedCertificate = createServerFn({
  method: "POST",
})
  .validator(certificateMaterialActionSchema)
  .handler(async ({ data }) => {
    await ensureAdmin();
    const runInTx = async (tx: typeof db) => {
      const policy = await lockCertificate(tx, data.certificateId);
      if (!policy) throw new Error("Certificate not found");
      assertImportedCertificateKind(policy.kind);
      if (policy.pendingMaterialVersion === null) {
        throw new Error("No pending material to discard");
      }
      const pendingVersion = policy.pendingMaterialVersion;
      const plan = planPendingImportedDiscard({
        activeMaterialVersion: policy.activeMaterialVersion,
        state: policy.state as ImportedCertificateState,
        notBefore: policy.notBefore,
        notAfter: policy.notAfter,
      });
      await tx
        .delete(certificateMaterial)
        .where(
          and(
            eq(certificateMaterial.certificateId, data.certificateId),
            eq(certificateMaterial.version, pendingVersion),
          ),
        );
      await tx
        .update(managedCertificate)
        .set(
          plan.clearCurrentMetadata
            ? {
                pendingMaterialVersion: null,
                state: plan.state,
                domains: [],
                notBefore: null,
                notAfter: null,
                fingerprintSha256: null,
                lastError: null,
              }
            : {
                pendingMaterialVersion: null,
                state: plan.state,
                lastError: null,
              },
        )
        .where(eq(managedCertificate.id, data.certificateId));
      return { ok: true };
    };
    return withCertificateTransaction(runInTx);
  });
