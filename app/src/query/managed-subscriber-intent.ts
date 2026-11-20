import type { AffectedGroupCascadePlan } from "@blossom/domain/group-membership";
import { z } from "zod";

import type { Node } from "@/db/proxy-schema";

/**
 * Persisted shape of a staged subscriber change in
 * `managed_rollout_stage.subscriber_intent`. The stage-advance command is the
 * only writer of subscriber rows while a rollout holds its claims, so the
 * intent must be complete enough to execute without re-reading an admin draft.
 *
 * A stage carries exactly one subscriber node mutation. A node deletion also
 * carries the task-02 group-membership cascade. Group membership changes that
 * are independent of the node row remain task 02's ordered command.
 */
export const MANAGED_SUBSCRIBER_INTENT_VERSION = 1;

const nodeFieldsSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  remark: z.string().nullable().optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  serverId: z.string().min(1),
  address: z.string().nullable().optional(),
  listenPort: z.number().int().min(1).max(65535),
  protocol: z.string().min(1),
  certificateId: z.string().nullable().optional(),
  tlsServerName: z.string().nullable().optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
const nodePatchSchema = nodeFieldsSchema
  .omit({
    id: true,
    name: true,
    serverId: true,
    listenPort: true,
    protocol: true,
  })
  .partial()
  .extend({
    name: z.string().min(1).optional(),
    serverId: z.string().min(1).optional(),
    listenPort: z.number().int().min(1).max(65535).optional(),
    protocol: z.string().min(1).optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "update_node patch must not be empty",
  });

export interface ManagedSubscriberNodeCreate {
  kind: "create_node";
  node: z.infer<typeof nodeFieldsSchema>;
}

export interface ManagedSubscriberNodeUpdate {
  kind: "update_node";
  nodeId: string;
  patch: z.infer<typeof nodePatchSchema>;
}

export interface ManagedSubscriberNodeDelete {
  kind: "delete_node";
  nodeId: string;
}

export type ManagedSubscriberIntent =
  | ManagedSubscriberNodeCreate
  | ManagedSubscriberNodeUpdate
  | ManagedSubscriberNodeDelete;

const intentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create_node"),
    node: nodeFieldsSchema,
  }),
  z.object({
    kind: z.literal("update_node"),
    nodeId: z.string().min(1),
    patch: nodePatchSchema,
  }),
  z.object({
    kind: z.literal("delete_node"),
    nodeId: z.string().min(1),
  }),
]);

/**
 * Parsed pre-change state stored in
 * `managed_rollout_stage.subscriber_previous` by a stage commit. Compensation
 * restores `node`, applies `plans` only while the affected group still has the
 * revision the commit left behind, and never replaces newer entitlement
 * changes.
 */
export interface ManagedSubscriberPrevious {
  version: typeof MANAGED_SUBSCRIBER_INTENT_VERSION;
  intent: ManagedSubscriberIntent;
  node: Node | null;
  plans: AffectedGroupCascadePlan[];
}

export type ParseManagedSubscriberIntentResult =
  | { ok: true; intent: ManagedSubscriberIntent }
  | { ok: false; reason: "invalid_intent"; message: string };

export function parseManagedSubscriberIntent(
  value: unknown,
): ParseManagedSubscriberIntentResult | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = intentSchema.safeParse(value);
  if (!parsed.success) {
    return {
      ok: false,
      reason: "invalid_intent",
      message: parsed.error.issues.map((issue) => issue.message).join("; "),
    };
  }
  return { ok: true, intent: parsed.data };
}

/** Narrows the persisted JSON into the typed previous-record shape. */
export function isManagedSubscriberPrevious(
  value: unknown,
): value is ManagedSubscriberPrevious {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ManagedSubscriberPrevious>;
  return (
    record.version === MANAGED_SUBSCRIBER_INTENT_VERSION &&
    typeof record.intent === "object" &&
    record.intent !== null &&
    (record.node === null || typeof record.node === "object") &&
    Array.isArray(record.plans)
  );
}
