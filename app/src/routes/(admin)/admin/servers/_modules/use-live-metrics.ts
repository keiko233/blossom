import { useEffect, useRef, useState } from "react";

import { adminMetricsServerMessageSchema } from "@/lib/admin-metrics-protocol";
import { appendLiveSample, type LiveMetricSample } from "@/lib/live-metrics";
import type { ServerLivePhase } from "@/lib/server-live-state";

export interface UseLiveMetricsOptions {
  serverId: string;
  /** False when the server cannot stream; no socket is opened. */
  enabled: boolean;
  /** Pausing closes the socket but keeps the frozen samples visible. */
  paused: boolean;
}

export interface LiveStream {
  phase: ServerLivePhase;
  protocol: "v1" | "v2" | null;
  samples: LiveMetricSample[];
  error: string | null;
}

/**
 * Same-origin admin metric stream. The server coalesces sampling and sends one
 * sample per interval regardless of how many admins watch. The browser keeps a
 * bounded window; pausing closes the socket and resuming starts a new series
 * so no continuity is fabricated across the gap.
 */
export function useLiveMetrics({
  serverId,
  enabled,
  paused,
}: UseLiveMetricsOptions): LiveStream {
  const [phase, setPhase] = useState<ServerLivePhase>("idle");
  const [protocol, setProtocol] = useState<"v1" | "v2" | null>(null);
  const [samples, setSamples] = useState<LiveMetricSample[]>([]);
  const [error, setError] = useState<string | null>(null);
  const attempts = useRef(0);

  useEffect(() => {
    if (!enabled) {
      setPhase("idle");
      setSamples([]);
      setProtocol(null);
      setError(null);
      return;
    }
    if (paused) {
      setPhase("paused");
      return;
    }

    let disposed = false;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let announced = false;

    // A fresh connection (mount, resume after pause, or server switch) starts
    // a new series rather than joining the previous window.
    attempts.current = 0;
    setSamples([]);
    setProtocol(null);
    setError(null);
    setPhase("connecting");

    const connect = () => {
      if (disposed) return;
      if (announced) setPhase("reconnecting");
      announced = true;
      const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(
        `${scheme}//${window.location.host}/api/admin/servers/${encodeURIComponent(serverId)}/metrics/ws`,
      );
      socket.addEventListener("open", () => {
        setPhase("connecting");
        setError(null);
      });
      socket.addEventListener("message", (event) => {
        let raw: unknown;
        try {
          raw = JSON.parse(String(event.data));
        } catch {
          return;
        }
        const parsed = adminMetricsServerMessageSchema.safeParse(raw);
        if (!parsed.success) return;
        const message = parsed.data;
        if (message.type === "state") {
          setProtocol(message.protocol);
          setPhase("connected");
          setError(null);
          return;
        }
        if (message.type === "sample") {
          setSamples((current) => appendLiveSample(current, message.sample));
          return;
        }
        if (message.type === "error") {
          setError(message.message);
          setPhase("error");
        }
      });
      socket.addEventListener("close", () => {
        if (disposed) return;
        setPhase("reconnecting");
        setSamples([]);
        const delay = Math.min(30_000, 1_000 * 2 ** attempts.current);
        attempts.current += 1;
        retry = setTimeout(connect, delay);
      });
      socket.addEventListener("error", () => setPhase("error"));
    };

    connect();
    return () => {
      disposed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [enabled, paused, serverId]);

  return { phase, protocol, samples, error };
}
