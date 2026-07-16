import { createServerFn } from "@tanstack/react-start";
import { count, desc, eq } from "drizzle-orm";

import { db } from "@/db";
import { user } from "@/db/auth-schema";
import { mcpToolAudit } from "@/db/mcp-schema";
import { oauthClient, oauthConsent } from "@/db/oauth-schema";
import { ensureAdmin } from "@/lib/ensure-admin";
import { getServerEnv } from "@/lib/env";

export const MCP_ADMIN_QUERY_KEY = ["admin", "mcp"] as const;

export const getMcpAdminOverview = createServerFn({ method: "GET" }).handler(
  async () => {
    await ensureAdmin();

    const [
      clients,
      consents,
      audits,
      [{ value: clientCount }],
      [{ value: consentCount }],
      [{ value: auditCount }],
    ] = await Promise.all([
      db
        .select({
          clientId: oauthClient.clientId,
          name: oauthClient.name,
          uri: oauthClient.uri,
          disabled: oauthClient.disabled,
          scopes: oauthClient.scopes,
          redirectUris: oauthClient.redirectUris,
          isPublic: oauthClient.isPublic,
          requirePKCE: oauthClient.requirePKCE,
          tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
          createdAt: oauthClient.createdAt,
        })
        .from(oauthClient)
        .orderBy(desc(oauthClient.createdAt))
        .limit(100),
      db
        .select({
          clientId: oauthConsent.clientId,
          clientName: oauthClient.name,
          userId: oauthConsent.userId,
          userName: user.name,
          userEmail: user.email,
          scopes: oauthConsent.scopes,
          createdAt: oauthConsent.createdAt,
        })
        .from(oauthConsent)
        .leftJoin(oauthClient, eq(oauthConsent.clientId, oauthClient.clientId))
        .leftJoin(user, eq(oauthConsent.userId, user.id))
        .orderBy(desc(oauthConsent.createdAt))
        .limit(100),
      db
        .select({
          id: mcpToolAudit.id,
          actorUserId: mcpToolAudit.actorUserId,
          actorName: user.name,
          actorEmail: user.email,
          source: mcpToolAudit.source,
          tool: mcpToolAudit.tool,
          status: mcpToolAudit.status,
          durationMs: mcpToolAudit.durationMs,
          redactedError: mcpToolAudit.redactedError,
          createdAt: mcpToolAudit.createdAt,
        })
        .from(mcpToolAudit)
        .leftJoin(user, eq(mcpToolAudit.actorUserId, user.id))
        .orderBy(desc(mcpToolAudit.createdAt))
        .limit(100),
      db.select({ value: count() }).from(oauthClient),
      db.select({ value: count() }).from(oauthConsent),
      db.select({ value: count() }).from(mcpToolAudit),
    ]);

    const origin = getServerEnv().BETTER_AUTH_URL.replace(/\/$/, "");

    return {
      connection: {
        endpoint: `${origin}/api/mcp`,
        authorizationServerMetadata: `${origin}/.well-known/oauth-authorization-server/api/auth`,
        protectedResourceMetadata: `${origin}/.well-known/oauth-protected-resource/api/mcp`,
      },
      stats: { clientCount, consentCount, auditCount },
      clients,
      consents,
      audits,
    };
  },
);

export type McpAdminOverview = Awaited<ReturnType<typeof getMcpAdminOverview>>;
