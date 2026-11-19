import {
  adminMetricsClientMessageSchema,
  type AdminMetricsServerMessage,
} from "./admin-metrics-protocol";
import type { AdminMetricsAcceptContext } from "./admin-metrics-relay-types";
import type { LiveMetricSample } from "./live-metrics";
import { getRealtimeHub, attachCrosswsHooks } from "./realtime-hub";

interface MetricsPeer {
  id: string;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

interface MetricsMessage {
  text(): string;
}

export const ADMIN_METRICS_AUTHORITY_INTERVAL_MS = 30_000;

function send(peer: MetricsPeer, message: AdminMetricsServerMessage): void {
  try {
    peer.send(JSON.stringify(message));
  } catch {
    // A stale peer is removed by its close hook.
  }
}

/**
 * Nitro target of the same-origin admin metric stream. The hub coalesces one
 * sampler per server and session; every browser viewer on this instance
 * receives the same samples.
 */
export async function acceptAdminMetrics(
  request: Request,
  context: AdminMetricsAcceptContext,
): Promise<Response> {
  const hub = getRealtimeHub();
  const response = new Response(null, {
    status: 426,
    headers: { Connection: "Upgrade", Upgrade: "websocket" },
  });

  let unsubscribe: (() => void) | undefined;
  let authorityTimer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let closed = false;

  return attachCrosswsHooks(response, request, {
    open: async (peer) => {
      send(peer, {
        type: "state",
        state: "connected",
        protocol: context.protocol,
        connectedAt: context.connectedAt,
      });
      unsubscribe = hub.subscribeLiveMetrics(
        {
          serverId: context.serverId,
          connectedAt: context.connectedAt,
          sessionId: context.sessionId,
          protocol: context.protocol,
        },
        (sample: LiveMetricSample) => send(peer, { type: "sample", sample }),
      );

      authorityTimer = setInterval(() => {
        if (checking || closed) return;
        checking = true;
        void context
          .verifyAuthority()
          .then((allowed) => {
            if (allowed || closed) return;
            closed = true;
            send(peer, {
              type: "error",
              code: "unauthorized",
              message: "admin metric stream authorization was revoked",
            });
            peer.close(1008, "authorization revoked");
          })
          .catch(() => undefined)
          .finally(() => {
            checking = false;
          });
      }, ADMIN_METRICS_AUTHORITY_INTERVAL_MS);
      (authorityTimer as { unref?: () => void }).unref?.();
    },
    message: async (peer, message) => {
      const parsed = parseClientMessage(message);
      if (parsed?.type !== "inspect") return;
      const reply = await hub.inspectTelemetry(
        context.serverId,
        context.connectedAt,
        context.sessionId,
      );
      if (reply?.kind === "snapshot") {
        send(peer, {
          type: "snapshot",
          requestId: parsed.requestId,
          snapshot: reply.data,
        });
      } else {
        send(peer, {
          type: "error",
          code: "unavailable",
          message: "telemetry inspection is unavailable",
        });
      }
    },
    close: () => {
      closed = true;
      if (authorityTimer) clearInterval(authorityTimer);
      unsubscribe?.();
      unsubscribe = undefined;
    },
    error: (peer, error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`admin metric websocket error (${peer.id}): ${message}`);
    },
  });
}

function parseClientMessage(message: MetricsMessage) {
  try {
    const parsed = adminMetricsClientMessageSchema.safeParse(
      JSON.parse(message.text()),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
