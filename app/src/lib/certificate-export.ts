export const CERTIFICATE_EXPORT_PARTS = ["fullchain", "private-key"] as const;
export type CertificateExportPart = (typeof CERTIFICATE_EXPORT_PARTS)[number];

export interface CertificateExportSession {
  user: { role?: string | null };
}

export type CertificateExportLookup =
  | { status: "not_found" }
  | { status: "no_active_material" }
  | { status: "ok"; name: string; pem: string };

export interface CertificateExportDependencies {
  getSession: () => Promise<CertificateExportSession | null>;
  getMaterial: (
    certificateId: string,
    part: CertificateExportPart,
  ) => Promise<CertificateExportLookup>;
}

export function isCertificateExportPart(
  value: string,
): value is CertificateExportPart {
  return CERTIFICATE_EXPORT_PARTS.includes(value as CertificateExportPart);
}

export function certificateExportFilename(
  name: string,
  certificateId: string,
  part: CertificateExportPart,
): string {
  const sanitized = name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base =
    sanitized ||
    certificateId.replace(/[^a-zA-Z0-9-]/g, "-").replace(/-+/g, "-");
  const suffix = part === "fullchain" ? "fullchain" : "private-key";
  return `${base}-${suffix}.pem`;
}

export async function handleCertificateExport(
  certificateId: string,
  partValue: string,
  dependencies: CertificateExportDependencies,
): Promise<Response> {
  const session = await dependencies.getSession();
  if (!session) return new Response("Unauthorized", { status: 401 });
  if (session.user.role !== "admin") {
    return new Response("Forbidden", { status: 403 });
  }
  if (!isCertificateExportPart(partValue)) {
    return new Response("Not Found", { status: 404 });
  }

  const result = await dependencies.getMaterial(certificateId, partValue);
  if (result.status === "not_found") {
    return new Response("Not Found", { status: 404 });
  }
  if (result.status === "no_active_material") {
    return new Response("Conflict", { status: 409 });
  }

  const filename = certificateExportFilename(
    result.name,
    certificateId,
    partValue,
  );
  return new Response(result.pem, {
    headers: {
      "Content-Type": "application/x-pem-file; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
