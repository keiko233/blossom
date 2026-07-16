import { mcpHandler as oauthMcpHandler } from "@better-auth/oauth-provider";
import { createFileRoute } from "@tanstack/react-router";
import { createMcpHandler } from "mcp-handler";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";
import { createMCPClient } from "@/orpc/mcp";
import {
  getActorFromExtra,
  sanitizeError,
  type AuthInfo,
} from "@/orpc/mcp/auth-context";

function buildHandler(): (req: Request) => Promise<Response> {
  const env = getServerEnv();
  const origin = env.BETTER_AUTH_URL.replace(/\/$/, "");
  const issuer = `${origin}/api/auth`;
  const audience = `${origin}/api/mcp`;
  const jwksUrl = `${origin}/api/auth/jwks`;

  const rawMcpHandler = createMcpHandler(
    async (server) => {
      server.registerTool(
        "listUsers",
        {
          title: "List users",
          description:
            "List all users. Never returns passwords, sessions, or subscription credentials.",
          inputSchema: { limit: z.number().int().min(1).max(200).optional() },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.listUsers({ limit: args.limit ?? 50 });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "getUser",
        {
          title: "Get user",
          description:
            "Get a single user by ID. Never returns passwords or secrets.",
          inputSchema: { id: z.string().min(1) },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.getUser({ id: args.id });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "listNodes",
        {
          title: "List nodes",
          description: "List proxy nodes.",
          inputSchema: { limit: z.number().int().min(1).max(200).optional() },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.listNodes({ limit: args.limit ?? 50 });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "getNode",
        {
          title: "Get node",
          description: "Get a single proxy node by ID.",
          inputSchema: { id: z.string().min(1) },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.getNode({ id: args.id });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "listServers",
        {
          title: "List servers",
          description: "List proxy servers. Never returns agent token hashes.",
          inputSchema: { limit: z.number().int().min(1).max(200).optional() },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.listServers({
              limit: args.limit ?? 50,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "getServer",
        {
          title: "Get server",
          description:
            "Get a single proxy server by ID. Never returns agent token hash.",
          inputSchema: { id: z.string().min(1) },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.getServer({ id: args.id });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "listPlans",
        {
          title: "List plans",
          description: "List subscription plans.",
          inputSchema: { limit: z.number().int().min(1).max(200).optional() },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.listPlans({ limit: args.limit ?? 50 });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "listSubscriptions",
        {
          title: "List subscriptions",
          description:
            "List subscriptions. Never returns credential UUIDs, passwords, or tokens.",
          inputSchema: { limit: z.number().int().min(1).max(200).optional() },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.listSubscriptions({
              limit: args.limit ?? 50,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "searchSingBoxDocs",
        {
          title: "Search sing-box documentation",
          description:
            "Search the sing-box documentation catalog. Returns matching page paths and titles.",
          inputSchema: { query: z.string().max(256) },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.searchDocs({ query: args.query });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      server.registerTool(
        "getSingBoxDoc",
        {
          title: "Get sing-box documentation page",
          description:
            "Fetch a sing-box documentation page by path. Only allows sing-box.sets.dev paths.",
          inputSchema: { path: z.string().min(1).max(256) },
        },
        async (args, extra) => {
          try {
            const { actorUserId, scopes } = getActorFromExtra(extra);
            const client = createMCPClient({
              actorUserId,
              scopes,
              source: "external",
            });
            const result = await client.getDoc({ path: args.path });
            return {
              content: [{ type: "text", text: JSON.stringify(result) }],
            };
          } catch (err) {
            return {
              isError: true,
              content: [{ type: "text", text: sanitizeError(err) }],
            };
          }
        },
      );

      const writeTools: Array<{
        name: string;
        title: string;
        description: string;
        schema: z.ZodObject<z.ZodRawShape>;
      }> = [
        {
          name: "banUser",
          title: "Ban user",
          description: "Ban a user. Revokes all their sessions.",
          schema: z.object({
            userId: z.string().min(1),
            reason: z.string().max(512).optional(),
            expiresInDays: z.number().int().min(1).optional(),
            confirm: z.literal(true),
          }),
        },
        {
          name: "unbanUser",
          title: "Unban user",
          description: "Unban a user.",
          schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }),
        },
        {
          name: "setUserRole",
          title: "Set user role",
          description: "Change a user's role to admin or user.",
          schema: z.object({
            userId: z.string().min(1),
            role: z.enum(["admin", "user"]),
            confirm: z.literal(true),
          }),
        },
        {
          name: "createNode",
          title: "Create node",
          description:
            "Create a new proxy node with sing-box validated settings.",
          schema: z.object({
            name: z.string().min(1).max(128),
            serverId: z.string().min(1),
            listenPort: z.number().int().min(1).max(65535),
            protocol: z.string().min(1),
            settings: z.record(z.string(), z.unknown()),
            remark: z.string().max(512).optional(),
            tags: z.array(z.string()).optional(),
            enabled: z.boolean().optional(),
            address: z.string().nullable().optional(),
            confirm: z.literal(true),
          }),
        },
        {
          name: "updateNode",
          title: "Update node",
          description: "Update an existing proxy node.",
          schema: z.object({
            id: z.string().min(1),
            name: z.string().min(1).max(128).optional(),
            serverId: z.string().min(1).optional(),
            listenPort: z.number().int().min(1).max(65535).optional(),
            protocol: z.string().min(1).optional(),
            settings: z.record(z.string(), z.unknown()).optional(),
            remark: z.string().max(512).optional(),
            tags: z.array(z.string()).optional(),
            enabled: z.boolean().optional(),
            address: z.string().nullable().optional(),
            confirm: z.literal(true),
          }),
        },
        {
          name: "deleteNode",
          title: "Delete node",
          description: "Delete a proxy node.",
          schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }),
        },
        {
          name: "updateServer",
          title: "Update server",
          description: "Update a proxy server configuration.",
          schema: z.object({
            id: z.string().min(1),
            name: z.string().min(1).max(128).optional(),
            remark: z.string().max(512).optional(),
            enabled: z.boolean().optional(),
            address: z.string().min(1).optional(),
            configPollIntervalSeconds: z
              .number()
              .int()
              .min(5)
              .max(86400)
              .optional(),
            heartbeatIntervalSeconds: z
              .number()
              .int()
              .min(5)
              .max(300)
              .optional(),
            confirm: z.literal(true),
          }),
        },
        {
          name: "enableServer",
          title: "Enable server",
          description: "Enable a proxy server.",
          schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }),
        },
        {
          name: "disableServer",
          title: "Disable server",
          description: "Disable a proxy server.",
          schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }),
        },
        {
          name: "deleteServer",
          title: "Delete server",
          description:
            "Delete a proxy server. Fails if the server still has nodes.",
          schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }),
        },
        {
          name: "updateSubscription",
          title: "Update subscription",
          description:
            "Update a subscription's status, expiry, or traffic usage.",
          schema: z.object({
            id: z.string().min(1),
            status: z.enum(["active", "expired", "cancelled"]).optional(),
            expiresAt: z.string().optional(),
            trafficUsedBytes: z.number().int().min(0).optional(),
            confirm: z.literal(true),
          }),
        },
        {
          name: "cancelSubscription",
          title: "Cancel subscription",
          description: "Cancel a subscription.",
          schema: z.object({ id: z.string().min(1), confirm: z.literal(true) }),
        },
      ];

      for (const tool of writeTools) {
        server.registerTool(
          tool.name,
          {
            title: tool.title,
            description: `${tool.description} Requires blossom:mcp:write scope.`,
            inputSchema: tool.schema.shape,
          },
          async (args, extra) => {
            try {
              const { actorUserId, scopes } = getActorFromExtra(extra);
              const client = createMCPClient({
                actorUserId,
                scopes,
                source: "external",
              });
              const result = await (
                client as Record<string, (input: unknown) => Promise<unknown>>
              )[tool.name](args);
              return {
                content: [{ type: "text", text: JSON.stringify(result) }],
              };
            } catch (err) {
              return {
                isError: true,
                content: [{ type: "text", text: sanitizeError(err) }],
              };
            }
          },
        );
      }
    },
    { serverInfo: { name: "blossom-mcp", version: "1.0.0" } },
    { basePath: "/api" },
  );

  return oauthMcpHandler(
    {
      verifyOptions: { audience, issuer },
      jwksUrl,
    },
    async (req, jwt) => {
      const scopes = Array.isArray(jwt.scope)
        ? jwt.scope
        : typeof jwt.scope === "string"
          ? jwt.scope.split(" ")
          : [];

      (req as Request & { auth?: AuthInfo }).auth = {
        token: (req.headers.get("Authorization") ?? "").replace(
          /^Bearer\s+/i,
          "",
        ),
        clientId: ((jwt.client_id ?? jwt.azp) as string) ?? "",
        scopes,
        expiresAt: jwt.exp as number | undefined,
        extra: { ...jwt, sub: jwt.sub, scopes },
      };

      return rawMcpHandler(req);
    },
    {
      resourceMetadataMappings: {
        [audience]: `${origin}/.well-known/oauth-protected-resource`,
      },
    },
  );
}

export const Route = createFileRoute("/api/mcp")({
  server: {
    handlers: {
      GET: async ({ request }) => buildHandler()(request),
      POST: async ({ request }) => buildHandler()(request),
      DELETE: async ({ request }) => buildHandler()(request),
      OPTIONS: async () => {
        return new Response(null, {
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers":
              "Authorization, Content-Type, Mcp-Session-Id",
            "Access-Control-Max-Age": "86400",
          },
        });
      },
    },
  },
});
