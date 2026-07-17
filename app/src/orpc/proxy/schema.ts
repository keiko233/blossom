import { z } from "zod";

import { managedCertificateInsertSchema } from "@/db/proxy-schema";

import {
  isNodeProtocol,
  NODE_PROTOCOLS,
  settingsSchemaFor,
} from "./sing-box-registry";

export { NODE_PROTOCOLS };
export type { NodeProtocol } from "./sing-box-registry";

/**
 * Server input schemas. A server is one physical host: name/remark/address/
 * enabled + the manageable agent credentials (write-only on create/reset; the
 * plaintext is returned exactly once). Specified separately from nodes so the
 * admin UI can manage servers and their tokens independently of the inbounds
 * the host runs.
 */

/** Serializable JSON value — used for jsonb columns that cross the server-fn boundary. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const serverMetaSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(512).optional(),
  enabled: z.boolean().default(true),
  address: z.string().min(1),
  configPollIntervalSeconds: z.number().int().min(5).max(86_400).default(60),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300).default(30),
  certificateIds: z.array(z.string().min(1)).default([]),
});

export const createServerSchema = serverMetaSchema;

export const updateServerSchema = serverMetaSchema.partial().extend({
  id: z.string().min(1),
});

export const serverIdSchema = z.object({ id: z.string().min(1) });

export type CreateServerInput = z.infer<typeof createServerSchema>;
export type UpdateServerInput = z.infer<typeof updateServerSchema>;

/**
 * Node input schemas. Protocol-specific configuration lives in `settings`, a native
 * sing-box inbound fragment validated against the schema for the chosen `protocol`
 * (see `sing-box-registry`). There is no hand-written per-protocol shape — the
 * sing-box schema is the single source of truth.
 */

const protocolSchema = z
  .string()
  .refine(isNodeProtocol, { message: "Unsupported protocol" });

// The stored settings fragment. Validated loosely here (it's protocol-dependent) and
// then strictly re-validated against `settingsSchemaFor(protocol)` in `parseNodeInput`.
const settingsSchema = z.record(z.string(), z.json());

const serverRefSchema = z.string().min(1);

const nodeMetaSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(512).optional(),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  serverId: serverRefSchema,
  // Optional override; null/undefined means "use server.address".
  address: z.string().min(1).nullable().optional(),
  listenPort: z.number().int().min(1).max(65535),
  protocol: protocolSchema,
  certificateId: z.string().min(1).nullable().optional(),
  tlsServerName: z.string().min(1).nullable().optional(),
  settings: settingsSchema,
});

export const createNodeSchema = nodeMetaSchema;

export const updateNodeSchema = nodeMetaSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateNodeInput = z.infer<typeof createNodeSchema>;
export type UpdateNodeInput = z.infer<typeof updateNodeSchema>;

/**
 * Strictly validates `settings` against the sing-box schema for `protocol`, returning
 * the parsed (schema-normalized) fragment. Call this in the server functions after the
 * coarse zod validation above.
 */
export function parseNodeSettings(
  protocol: string,
  settings: unknown,
): Record<string, JsonValue> {
  if (!isNodeProtocol(protocol)) {
    throw new Error(`Unsupported protocol: ${protocol}`);
  }
  return settingsSchemaFor(protocol).parse(settings) as Record<
    string,
    JsonValue
  >;
}

export const nodeIdSchema = z.object({ id: z.string().min(1) });

// --- Groups ------------------------------------------------------------------

const groupMetaSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(512).optional(),
  sortOrder: z.number().int().default(0),
  // Full membership list; create/update replace the node_group rows with it.
  nodeIds: z.array(z.string().min(1)).default([]),
});

export const createGroupSchema = groupMetaSchema;

export const updateGroupSchema = groupMetaSchema.partial().extend({
  id: z.string().min(1),
});

export type CreateGroupInput = z.infer<typeof createGroupSchema>;
export type UpdateGroupInput = z.infer<typeof updateGroupSchema>;

export const groupIdSchema = z.object({ id: z.string().min(1) });

// --- Managed certificates ---------------------------------------------------

const certificatePolicyBaseSchema = managedCertificateInsertSchema.pick({
  name: true,
  kind: true,
  domains: true,
  acmeEmail: true,
  acmeStaging: true,
  selfSignedValidityDays: true,
  renewalDaysBeforeExpiry: true,
});

export const createCertificateSchema = certificatePolicyBaseSchema;
export const updateCertificateSchema = certificatePolicyBaseSchema
  .partial()
  .extend({
    id: z.string().min(1),
  });
export const certificateIdSchema = z.object({ id: z.string().min(1) });

export const certificateEventSchema = z.object({
  actionId: z.string().min(1),
  certificateId: z.string().min(1),
  generation: z.number().int().min(1),
  state: z.enum([
    "issuing",
    "waiting_dns",
    "active",
    "renewing",
    "error",
    "expired",
    "removed",
  ]),
  notBefore: z.iso.datetime().optional(),
  notAfter: z.iso.datetime().optional(),
  fingerprintSha256: z.string().max(256).optional(),
  challenge: z
    .array(
      z.object({
        name: z.string().min(1).max(512),
        type: z.literal("TXT"),
        value: z.string().min(1).max(2048),
      }),
    )
    .max(200)
    .optional(),
  error: z.string().max(4096).optional(),
});

export type CreateCertificateInput = z.infer<typeof createCertificateSchema>;
export type UpdateCertificateInput = z.infer<typeof updateCertificateSchema>;

// --- Agent -----------------------------------------------------------------

export const heartbeatSchema = z.object({
  agentVersion: z.string().optional(),
  singBoxVersion: z.string().optional(),
  runtimeState: z
    .enum(["unknown", "starting", "running", "stopped", "crash_loop"])
    .optional(),
  configState: z
    .enum(["unknown", "applied", "rejected", "apply_failed"])
    .optional(),
  observedRevision: z.string().max(128).optional(),
  appliedRevision: z.string().max(128).optional(),
  activeNodeIds: z.array(z.string().min(1)).max(10_000).optional(),
  clearActiveNodeIds: z.boolean().optional(),
  effectiveConfigPollIntervalSeconds: z
    .number()
    .int()
    .min(1)
    .max(86_400)
    .optional(),
  effectiveHeartbeatIntervalSeconds: z
    .number()
    .int()
    .min(1)
    .max(3_600)
    .optional(),
  appliedAt: z.iso.datetime().optional(),
  clearError: z.boolean().optional(),
  error: z
    .object({
      phase: z.string().min(1).max(64),
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(16_384),
      nodeId: z.string().min(1).optional(),
      occurredAt: z.iso.datetime().optional(),
    })
    .optional(),
});

/**
 * Traffic deltas the agent reads from sing-box's v2ray_api stats and reports
 * per user. Sing-box user names are subscription ids, so each entry maps
 * straight to a subscription row. Deltas, not totals: the agent resets the
 * stat counters on read (`reset=true`) and posts what accumulated.
 */
export const trafficReportSchema = z.object({
  // Reporting window bounds as stated by the agent; optional metadata.
  windowStartedAt: z.iso.datetime().optional(),
  windowEndedAt: z.iso.datetime().optional(),
  entries: z
    .array(
      z.object({
        subscriptionId: z.string().min(1),
        uplinkBytes: z.number().int().min(0),
        downlinkBytes: z.number().int().min(0),
      }),
    )
    .max(10_000),
});

export type TrafficReportInput = z.infer<typeof trafficReportSchema>;
