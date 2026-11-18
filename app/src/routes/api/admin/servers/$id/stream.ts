import { createFileRoute } from "@tanstack/react-router";
import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { node, server } from "@/db/proxy-schema";
import { getAdminSession } from "@/lib/ensure-admin";
import { getRealtimeHub } from "@/lib/realtime-hub";

const headers = { "cache-control": "private, no-store" };

export const Route = createFileRoute("/api/admin/servers/$id/stream")({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!(await getAdminSession())) {
          return new Response(null, { status: 403, headers });
        }
        const [row] = await db
          .select({
            enabled: server.enabled,
            transport: server.transportMode,
            connectedAt: server.wsConnectedAt,
            capabilities: server.agentCapabilities,
          })
          .from(server)
          .where(eq(server.id, params.id));
        if (!row) return new Response(null, { status: 404, headers });

        const kind =
          new URL(request.url).searchParams.get("inspect") === "1"
            ? "snapshot"
            : "sample";
        const state = !row.enabled
          ? "disabled"
          : row.transport !== "ws"
            ? "fallback"
            : !row.capabilities.includes("telemetry-v1")
              ? "legacy"
              : "connected";

        if (state !== "connected" || !row.connectedAt)
          return Response.json(
            { state: state === "connected" ? "unavailable" : state },
            { headers },
          );
        const reply = await getRealtimeHub().requestTelemetry(
          params.id,
          kind,
          row.connectedAt.toISOString(),
        );
        if (!reply) return Response.json({ state: "unavailable" }, { headers });
        if (reply.kind === "sample") {
          return Response.json({ state, sample: reply.data }, { headers });
        }

        const configured = await db
          .select({ port: node.listenPort })
          .from(node)
          .where(and(eq(node.serverId, params.id), eq(node.enabled, true)));
        const ports = new Set(configured.map(({ port }) => port));
        const snapshot = {
          ...reply.data,
          listeners: reply.data.listeners.map((listener) => ({
            ...listener,
            overlapsNode: ports.has(listener.port),
          })),
        };
        return Response.json({ state, snapshot }, { headers });
      },
    },
  },
});
