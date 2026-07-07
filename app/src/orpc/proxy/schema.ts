import { z } from "zod";

import {
  isNodeProtocol,
  NODE_PROTOCOLS,
  settingsSchemaFor,
} from "./sing-box-registry";

export { NODE_PROTOCOLS };
export type { NodeProtocol } from "./sing-box-registry";

/**
 * Node input schemas. Protocol-specific configuration lives in `settings`, a native
 * sing-box inbound fragment validated against the schema for the chosen `protocol`
 * (see `sing-box-registry`). There is no hand-written per-protocol shape — the
 * sing-box schema is the single source of truth.
 */

/** Serializable JSON value — used for jsonb columns that cross the server-fn boundary. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

const protocolSchema = z
  .string()
  .refine(isNodeProtocol, { message: "Unsupported protocol" });

// The stored settings fragment. Validated loosely here (it's protocol-dependent) and
// then strictly re-validated against `settingsSchemaFor(protocol)` in `parseNodeInput`.
const settingsSchema = z.record(z.string(), z.json());

const nodeMetaSchema = z.object({
  name: z.string().min(1).max(128),
  remark: z.string().max(512).optional(),
  tags: z.array(z.string()).default([]),
  enabled: z.boolean().default(true),
  address: z.string().min(1),
  listenPort: z.number().int().min(1).max(65535),
  protocol: protocolSchema,
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

// --- Agent -----------------------------------------------------------------

export const heartbeatSchema = z.object({
  agentVersion: z.string().optional(),
});
