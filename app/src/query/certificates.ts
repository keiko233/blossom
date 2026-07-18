import { createServerFn } from "@tanstack/react-start";
import { asc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

import { db } from "@/db";
import {
  certificateServer,
  managedCertificate,
  node,
  server,
} from "@/db/proxy-schema";
import {
  getCertificateAcmeProviderCapabilities,
  advanceCertificateIssuance,
  getCertificateDnsCapability,
} from "@/lib/certificate-issuance";
import { ensureAdmin } from "@/lib/ensure-admin";
import {
  certificateIdSchema,
  createCertificateSchema,
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
    return certificates.map((certificate) => ({
      ...certificate,
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
      .select({ generation: managedCertificate.desiredGeneration })
      .from(managedCertificate)
      .where(eq(managedCertificate.id, data.id));
    if (!policy) throw new Error("Not found");
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
