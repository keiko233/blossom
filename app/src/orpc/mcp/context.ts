import { z } from "zod";

export const READ_SCOPE = "blossom:mcp:read" as const;
export const WRITE_SCOPE = "blossom:mcp:write" as const;

export interface MCPContext {
  actorUserId: string;
  scopes: string[];
  source: "external";
}

export const confirmLiteral = z.literal(true);

export const listInput = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50),
});

export const idInput = z.object({
  id: z.string().min(1),
});

const serverMetaWrite = z.object({
  name: z.string().min(1).max(128).optional(),
  remark: z.string().max(512).optional(),
  enabled: z.boolean().optional(),
  address: z.string().min(1).optional(),
  configPollIntervalSeconds: z.number().int().min(5).max(86400).optional(),
  heartbeatIntervalSeconds: z.number().int().min(5).max(300).optional(),
});

export const updateServerInput = idInput
  .merge(serverMetaWrite)
  .extend({ confirm: confirmLiteral });

export const serverIdInput = idInput.extend({ confirm: confirmLiteral });

export const banUserInput = z.object({
  userId: z.string().min(1),
  reason: z.string().max(512).optional(),
  expiresInDays: z.number().int().min(1).optional(),
  confirm: confirmLiteral,
});

export const unbanUserInput = idInput.extend({ confirm: confirmLiteral });

export const setUserRoleInput = z.object({
  userId: z.string().min(1),
  role: z.enum(["admin", "user"]),
  confirm: confirmLiteral,
});

export const createNodeInput = z.object({
  name: z.string().min(1).max(128),
  serverId: z.string().min(1),
  listenPort: z.number().int().min(1).max(65535),
  protocol: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
  remark: z.string().max(512).optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  address: z.string().min(1).nullable().optional(),
  confirm: confirmLiteral,
});

export const updateNodeInput = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(128).optional(),
  serverId: z.string().min(1).optional(),
  listenPort: z.number().int().min(1).max(65535).optional(),
  protocol: z.string().min(1).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  remark: z.string().max(512).optional(),
  tags: z.array(z.string()).optional(),
  enabled: z.boolean().optional(),
  address: z.string().min(1).nullable().optional(),
  confirm: confirmLiteral,
});

export const deleteNodeInput = idInput.extend({ confirm: confirmLiteral });

export const deleteServerInput = idInput.extend({ confirm: confirmLiteral });

export const updateSubscriptionInput = z.object({
  id: z.string().min(1),
  status: z.enum(["active", "expired", "cancelled"]).optional(),
  expiresAt: z.string().optional(),
  trafficUsedBytes: z.number().int().min(0).optional(),
  confirm: confirmLiteral,
});

export const cancelSubscriptionInput = idInput.extend({
  confirm: confirmLiteral,
});
