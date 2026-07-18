import { createFileRoute } from "@tanstack/react-router";

import { getAuth } from "@/lib/auth";
import { handleCertificateExport } from "@/lib/certificate-export";
import { getCertificateExportMaterial } from "@/query/certificate-export";

export const Route = createFileRoute(
  "/api/admin/certificates/$certificateId/export/$part",
)({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        return handleCertificateExport(params.certificateId, params.part, {
          getSession: () =>
            getAuth().api.getSession({ headers: request.headers }),
          getMaterial: getCertificateExportMaterial,
        });
      },
    },
  },
});
