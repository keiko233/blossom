import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { certificateMaterial, managedCertificate } from "@/db/proxy-schema";
import { decryptCertificateSecret } from "@/lib/certificate-crypto";
import type {
  CertificateExportLookup,
  CertificateExportPart,
} from "@/lib/certificate-export";

export async function getCertificateExportMaterial(
  certificateId: string,
  part: CertificateExportPart,
): Promise<CertificateExportLookup> {
  const [policy] = await db
    .select({
      activeMaterialVersion: managedCertificate.activeMaterialVersion,
      name: managedCertificate.name,
    })
    .from(managedCertificate)
    .where(eq(managedCertificate.id, certificateId));
  if (!policy) return { status: "not_found" };
  if (policy.activeMaterialVersion === null) {
    return { status: "no_active_material" };
  }

  const [material] = await db
    .select({
      id: certificateMaterial.id,
      certificateCiphertext: certificateMaterial.certificateCiphertext,
      privateKeyCiphertext: certificateMaterial.privateKeyCiphertext,
    })
    .from(certificateMaterial)
    .where(
      and(
        eq(certificateMaterial.certificateId, certificateId),
        eq(certificateMaterial.version, policy.activeMaterialVersion),
      ),
    );
  if (!material) return { status: "no_active_material" };

  const pem =
    part === "fullchain"
      ? decryptCertificateSecret(
          material.certificateCiphertext,
          `certificate:${material.id}:certificate`,
        )
      : decryptCertificateSecret(
          material.privateKeyCiphertext,
          `certificate:${material.id}:private-key`,
        );
  return { status: "ok", name: policy.name, pem };
}
