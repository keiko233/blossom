import { ORPCError, os } from "@orpc/server";
import { z } from "zod";

import { appendMcpToolAudit } from "@/query/mcp-audit";
import {
  banUserMCP,
  cancelSubscriptionMCP,
  createNodeMCP,
  deleteNodeMCP,
  deleteServerMCP,
  disableServerMCP,
  enableServerMCP,
  getNodeMCP,
  getServerMCP,
  getSingBoxDoc,
  getUserMCP,
  listNodesMCP,
  listPlansMCP,
  listServersMCP,
  listSubscriptionsMCP,
  listUsersMCP,
  requireActorAdmin,
  searchSingBoxDocs,
  setUserRoleMCP,
  unbanUserMCP,
  updateNodeMCP,
  updateServerMCP,
  updateSubscriptionMCP,
} from "@/query/mcp-tools";

import {
  banUserInput,
  cancelSubscriptionInput,
  createNodeInput,
  deleteNodeInput,
  deleteServerInput,
  idInput,
  listInput,
  READ_SCOPE,
  serverIdInput,
  setUserRoleInput,
  type MCPContext,
  unbanUserInput,
  updateNodeInput,
  updateServerInput,
  updateSubscriptionInput,
  WRITE_SCOPE,
} from "./context";
import { redact } from "./redact";

interface MCPClientContext {
  actorUserId: string;
  scopes: string[];
  source: "external";
}

const base = os.$context<MCPClientContext>();

const mcpGuard = base.use(async ({ context, next }) => {
  await requireActorAdmin(context.actorUserId);
  return next({ context });
});

const readProcedure = mcpGuard.use(async ({ context, next }) => {
  if (!context.scopes.includes(READ_SCOPE)) {
    throw new ORPCError("FORBIDDEN");
  }
  return next({ context });
});

const writeProcedure = mcpGuard.use(async ({ context, next }) => {
  if (!context.scopes.includes(WRITE_SCOPE)) {
    throw new ORPCError("FORBIDDEN");
  }
  return next({ context });
});

async function audited<T>(
  context: MCPContext,
  tool: string,
  input: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    try {
      await appendMcpToolAudit({
        actorUserId: context.actorUserId,
        source: context.source,
        tool,
        redactedInput: redact(input),
        redactedOutput: redact(result),
        status: "success",
        durationMs: Date.now() - start,
      });
    } catch {
      // audit failure must not hide the tool result
    }
    return result;
  } catch (error) {
    try {
      await appendMcpToolAudit({
        actorUserId: context.actorUserId,
        source: context.source,
        tool,
        redactedInput: redact(input),
        redactedError: redact(
          error instanceof Error ? error.message : String(error),
        ),
        status: "error",
        durationMs: Date.now() - start,
      });
    } catch {
      // audit failure must not hide the tool error
    }
    throw error;
  }
}

// ── Read tools ────────────────────────────────────────────────────────

export const listUsers = readProcedure
  .input(listInput)
  .handler(async ({ input, context }) => {
    return audited(context, "listUsers", input, () =>
      listUsersMCP(context.actorUserId, input.limit),
    );
  });

export const getUser = readProcedure
  .input(idInput)
  .handler(async ({ input, context }) => {
    return audited(context, "getUser", input, () =>
      getUserMCP(context.actorUserId, input.id),
    );
  });

export const listNodes = readProcedure
  .input(listInput)
  .handler(async ({ input, context }) => {
    return audited(context, "listNodes", input, () =>
      listNodesMCP(context.actorUserId, input.limit),
    );
  });

export const getNode = readProcedure
  .input(idInput)
  .handler(async ({ input, context }) => {
    return audited(context, "getNode", input, () =>
      getNodeMCP(context.actorUserId, input.id),
    );
  });

export const listServers = readProcedure
  .input(listInput)
  .handler(async ({ input, context }) => {
    return audited(context, "listServers", input, () =>
      listServersMCP(context.actorUserId, input.limit),
    );
  });

export const getServer = readProcedure
  .input(idInput)
  .handler(async ({ input, context }) => {
    return audited(context, "getServer", input, () =>
      getServerMCP(context.actorUserId, input.id),
    );
  });

export const listPlans = readProcedure
  .input(listInput)
  .handler(async ({ input, context }) => {
    return audited(context, "listPlans", input, () =>
      listPlansMCP(context.actorUserId, input.limit),
    );
  });

export const listSubscriptions = readProcedure
  .input(listInput)
  .handler(async ({ input, context }) => {
    return audited(context, "listSubscriptions", input, () =>
      listSubscriptionsMCP(context.actorUserId, input.limit),
    );
  });

export const searchDocs = readProcedure
  .input(
    z.object({
      query: z.string().max(256),
    }),
  )
  .handler(async ({ input, context }) => {
    return audited(context, "searchDocs", input, () =>
      searchSingBoxDocs(context.actorUserId, input.query),
    );
  });

export const getDoc = readProcedure
  .input(
    z.object({
      path: z.string().min(1).max(256),
    }),
  )
  .handler(async ({ input, context }) => {
    return audited(context, "getDoc", input, () =>
      getSingBoxDoc(context.actorUserId, input.path),
    );
  });

// ── Write tools ───────────────────────────────────────────────────────

export const banUser = writeProcedure
  .input(banUserInput)
  .handler(async ({ input, context }) => {
    return audited(context, "banUser", input, () =>
      banUserMCP(
        context.actorUserId,
        input.userId,
        input.reason,
        input.expiresInDays,
      ),
    );
  });

export const unbanUser = writeProcedure
  .input(unbanUserInput)
  .handler(async ({ input, context }) => {
    return audited(context, "unbanUser", input, () =>
      unbanUserMCP(context.actorUserId, input.id),
    );
  });

export const setUserRole = writeProcedure
  .input(setUserRoleInput)
  .handler(async ({ input, context }) => {
    return audited(context, "setUserRole", input, () =>
      setUserRoleMCP(context.actorUserId, input.userId, input.role),
    );
  });

export const createNode = writeProcedure
  .input(createNodeInput)
  .handler(async ({ input, context }) => {
    return audited(context, "createNode", input, () =>
      createNodeMCP(context.actorUserId, input),
    );
  });

export const updateNode = writeProcedure
  .input(updateNodeInput)
  .handler(async ({ input, context }) => {
    const { id, confirm: _, ...rest } = input;
    return audited(context, "updateNode", input, () =>
      updateNodeMCP(context.actorUserId, id, rest),
    );
  });

export const deleteNode = writeProcedure
  .input(deleteNodeInput)
  .handler(async ({ input, context }) => {
    return audited(context, "deleteNode", input, () =>
      deleteNodeMCP(context.actorUserId, input.id),
    );
  });

export const updateServer = writeProcedure
  .input(updateServerInput)
  .handler(async ({ input, context }) => {
    const { id, confirm: _, ...rest } = input;
    return audited(context, "updateServer", input, () =>
      updateServerMCP(context.actorUserId, id, rest),
    );
  });

export const enableServer = writeProcedure
  .input(serverIdInput)
  .handler(async ({ input, context }) => {
    return audited(context, "enableServer", input, () =>
      enableServerMCP(context.actorUserId, input.id),
    );
  });

export const disableServer = writeProcedure
  .input(serverIdInput)
  .handler(async ({ input, context }) => {
    return audited(context, "disableServer", input, () =>
      disableServerMCP(context.actorUserId, input.id),
    );
  });

export const deleteServer = writeProcedure
  .input(deleteServerInput)
  .handler(async ({ input, context }) => {
    return audited(context, "deleteServer", input, () =>
      deleteServerMCP(context.actorUserId, input.id),
    );
  });

export const updateSubscription = writeProcedure
  .input(updateSubscriptionInput)
  .handler(async ({ input, context }) => {
    const { id, confirm: _, ...rest } = input;
    return audited(context, "updateSubscription", input, () =>
      updateSubscriptionMCP(context.actorUserId, id, rest),
    );
  });

export const cancelSubscription = writeProcedure
  .input(cancelSubscriptionInput)
  .handler(async ({ input, context }) => {
    return audited(context, "cancelSubscription", input, () =>
      cancelSubscriptionMCP(context.actorUserId, input.id),
    );
  });

// ── Router ────────────────────────────────────────────────────────────

export default {
  listUsers,
  getUser,
  listNodes,
  getNode,
  listServers,
  getServer,
  listPlans,
  listSubscriptions,
  searchDocs,
  getDoc,
  banUser,
  unbanUser,
  setUserRole,
  createNode,
  updateNode,
  deleteNode,
  updateServer,
  enableServer,
  disableServer,
  deleteServer,
  updateSubscription,
  cancelSubscription,
};
