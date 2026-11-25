import { z } from "zod";

/**
 * Client-safe input contracts for L4 port forwarding (`relay-in-<id>`).
 * The server functions in `query/port-forwards.ts` validate with the same
 * schemas the editor uses; persistence rows stay in
 * `db/managed-network-schema.ts`.
 */

const idSchema = z.string().trim().min(1).max(128);
const nameSchema = z.string().trim().min(1).max(128);
const hostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      !value.includes("/") &&
      !value.includes("://") &&
      !/\s/.test(value) &&
      !value.includes("@"),
    { message: "Use a host name or IP address without a scheme or path" },
  );
const outboundTagSchema = z.string().trim().min(1).max(128);

export const PORT_FORWARD_NETWORKS = ["tcp", "udp", "both"] as const;
export type PortForwardNetwork = (typeof PORT_FORWARD_NETWORKS)[number];

export const savePortForwardSchema = z
  .object({
    id: idSchema.optional(),
    serverId: idSchema,
    expectedTopologyGeneration: z.number().int().min(0),
    name: nameSchema,
    enabled: z.boolean().default(true),
    listenAddress: hostSchema.default("::"),
    listenPort: z.number().int().min(1).max(65_535),
    network: z.enum(PORT_FORWARD_NETWORKS).default("both"),
    /**
     * A managed exit node target. Mutually exclusive with
     * `targetAddress`/`targetPort`, which describe an external host.
     */
    targetNodeId: idSchema.optional(),
    targetAddress: hostSchema.optional(),
    targetPort: z.number().int().min(1).max(65_535).optional(),
    outboundTag: outboundTagSchema.nullable().optional(),
  })
  .superRefine((value, context) => {
    const targetsManagedNode = value.targetNodeId !== undefined;
    const hasExternalAddress = value.targetAddress !== undefined;
    const hasExternalPort = value.targetPort !== undefined;

    if (targetsManagedNode && (hasExternalAddress || hasExternalPort)) {
      context.addIssue({
        code: "custom",
        message:
          "A port forward targets either a managed node or an external host:port, not both",
        path: ["targetNodeId"],
      });
      return;
    }
    if (!targetsManagedNode && !(hasExternalAddress && hasExternalPort)) {
      context.addIssue({
        code: "custom",
        message:
          "A port forward requires targetNodeId or both targetAddress and targetPort",
        path: ["targetNodeId"],
      });
    }
  });

export type SavePortForwardInput = z.infer<typeof savePortForwardSchema>;

export const deletePortForwardSchema = z.object({
  id: idSchema,
  expectedTopologyGeneration: z.number().int().min(0),
});

export type DeletePortForwardInput = z.infer<typeof deletePortForwardSchema>;
