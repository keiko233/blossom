import {
  certificateArtifactSchema,
  managedPeerTlsBindingSchema,
  managedPeerTrustArtifactSchema,
  managedProbeBindingSchema,
  managedRuleSetArtifactSchema,
  managedRuleSetBindingSchema,
  managedSnapshotExtensionSchema,
  managedTlsBindingSchema,
} from "@blossom/contracts/agent-config-v3";
import { SmartCoercionPlugin } from "@orpc/json-schema";
import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { OpenAPIReferencePlugin } from "@orpc/openapi/plugins";
import { onError } from "@orpc/server";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { createFileRoute } from "@tanstack/react-router";

import router from "@/orpc/router";

// The reference document (`/api/spec.json`) and its UI are development tooling
// for `agent:spec`. Production never mounts them.
const openAPIReferencePlugins =
  process.env.NODE_ENV === "production"
    ? []
    : [
        new OpenAPIReferencePlugin({
          schemaConverters: [new ZodToJsonSchemaConverter()],
          specGenerateOptions: {
            info: {
              title: "Blossom API",
              version: "1.0.0",
            },
            commonSchemas: {
              UndefinedError: { error: "UndefinedError" },
              // Registered so the legacy `managedTlsBindings` array and the
              // managed extension's `managed.tlsBindings` array generate
              // distinct, correctly named Rust types instead of colliding on
              // `...ManagedTlsBindingsItem`.
              CertificateArtifact: {
                schema: certificateArtifactSchema,
                strategy: "output",
              },
              ManagedTlsBinding: {
                schema: managedTlsBindingSchema,
                strategy: "output",
              },
              ManagedPeerTlsBinding: {
                schema: managedPeerTlsBindingSchema,
                strategy: "output",
              },
              ManagedPeerTrustArtifact: {
                schema: managedPeerTrustArtifactSchema,
                strategy: "output",
              },
              ManagedRuleSetBinding: {
                schema: managedRuleSetBindingSchema,
                strategy: "output",
              },
              ManagedRuleSetArtifact: {
                schema: managedRuleSetArtifactSchema,
                strategy: "output",
              },
              ManagedProbeBinding: {
                schema: managedProbeBindingSchema,
                strategy: "output",
              },
              ManagedSnapshotExtension: {
                schema: managedSnapshotExtensionSchema,
                strategy: "output",
              },
            },
            security: [{ bearerAuth: [] }],
            components: {
              securitySchemes: {
                bearerAuth: {
                  type: "http",
                  scheme: "bearer",
                },
              },
            },
          },
        }),
      ];

const handler = new OpenAPIHandler(router, {
  interceptors: [
    onError((error) => {
      console.error(error);
    }),
  ],
  plugins: [
    new SmartCoercionPlugin({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }),
    ...openAPIReferencePlugins,
  ],
});

async function handle({ request }: { request: Request }) {
  const { response } = await handler.handle(request, {
    prefix: "/api",
    context: { headers: request.headers },
  });

  return response ?? new Response("Not Found", { status: 404 });
}

export const Route = createFileRoute("/api/$")({
  server: {
    handlers: {
      HEAD: handle,
      GET: handle,
      POST: handle,
      PUT: handle,
      PATCH: handle,
      DELETE: handle,
    },
  },
});
