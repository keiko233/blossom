import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { PauseIcon, PlayIcon, ScanSearchIcon } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";

import { PageContent, PageToolbar } from "@/components/app-shell/page-header";
import {
  ChartSkeleton,
  StatStripSkeleton,
} from "@/components/app-shell/skeletons";
import { WorkspaceViewport } from "@/components/app-shell/workspace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { StatusDot } from "@/components/ui/status-dot";
import { liveStateOf, streamTone } from "@/lib/server-live-state";
import { m } from "@/paraglide/messages";
import type { ServerDTO } from "@/query/servers";

import { LiveCharts, LiveChartsEmpty } from "./live-charts";
import { LiveEnvironment, LiveGauges } from "./live-gauges";
import { type Inspection, NetworkInspection } from "./network-inspection";
import { useLiveMetrics } from "./use-live-metrics";

const transportLabel = {
  connected: m.server_live_connected,
  fallback: m.server_live_fallback,
  legacy: m.server_live_legacy,
  disabled: m.server_live_disabled,
  unavailable: m.server_live_unavailable,
};

const emptyReason = {
  fallback: m.server_live_fallback,
  legacy: m.server_live_legacy,
  disabled: m.server_live_disabled,
  unavailable: m.server_live_unavailable,
};

async function fetchInspection(
  serverId: string,
  signal?: AbortSignal,
): Promise<Inspection> {
  const path = `/api/admin/servers/${encodeURIComponent(serverId)}/stream?inspect=1`;
  const response = await fetch(path, { cache: "no-store", signal });
  if (!response.ok) throw new Error("Telemetry inspection failed");
  const body = (await response.json()) as {
    snapshot?: Inspection;
  };
  if (!body.snapshot) throw new Error("Telemetry inspection unavailable");
  return body.snapshot;
}

export interface ServerLiveTabProps {
  server: ServerDTO;
}

/**
 * Live tab: owns the admin metrics WebSocket. Pausing closes the socket and
 * keeps the frozen samples; resuming starts a new series.
 */
export function ServerLiveTab({
  server,
}: ServerLiveTabProps): React.ReactElement {
  const state = liveStateOf(server);
  const [paused, setPaused] = useState(false);
  const [waitingElapsed, setWaitingElapsed] = useState(false);

  const live = useLiveMetrics({
    serverId: server.id,
    enabled: state === "connected",
    paused,
  });
  const inspection = useMutation({
    mutationFn: () => fetchInspection(server.id),
    gcTime: 0,
  });
  const latest = live.samples.at(-1);
  const waitingForSamples =
    state === "connected" && live.samples.length === 0 && !paused;

  useEffect(() => {
    if (!waitingForSamples) {
      setWaitingElapsed(false);
      return;
    }
    const timer = setTimeout(() => setWaitingElapsed(true), 5_000);
    return () => clearTimeout(timer);
  }, [waitingForSamples]);

  const phaseText =
    state !== "connected"
      ? transportLabel[state]()
      : live.error
        ? live.error
        : paused
          ? m.admin_server_ws_paused()
          : live.phase === "connected"
            ? m.admin_server_ws_streaming()
            : live.phase === "reconnecting"
              ? m.server_live_stream_reconnecting()
              : live.phase === "error"
                ? m.server_live_unavailable()
                : m.server_live_stream_connecting();

  return (
    <WorkspaceViewport
      scrollId={`server-${server.id}-live`}
      className="[--page-header-h:0px]"
    >
      <PageToolbar>
        <span
          role="status"
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <StatusDot
            label={phaseText}
            tone={state === "connected" ? streamTone(live.phase) : "muted"}
            pulse={
              state === "connected" &&
              (live.phase === "connecting" || live.phase === "reconnecting")
            }
          />
          <span className="truncate">{phaseText}</span>
        </span>
        {live.protocol ? (
          <Badge size="sm" variant="secondary">
            {live.protocol}
          </Badge>
        ) : null}
        <Badge size="sm" variant="outline">
          {transportLabel[state]()}
        </Badge>
        <div className="ms-auto flex shrink-0 items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={state !== "connected"}
            onClick={() => setPaused((value) => !value)}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? m.admin_server_ws_resume() : m.admin_server_ws_pause()}
          </Button>
          <Button
            size="xs"
            variant="outline"
            loading={inspection.isPending}
            disabled={state !== "connected"}
            onClick={() => inspection.mutate()}
          >
            <ScanSearchIcon />
            <span className="max-sm:sr-only">{m.server_live_inspect()}</span>
          </Button>
        </div>
      </PageToolbar>

      <PageContent>
        {state !== "connected" ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{emptyReason[state]()}</EmptyTitle>
              <EmptyDescription>
                {m.admin_server_ws_connection_hint()}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                variant="outline"
                render={
                  <Link
                    to="/admin/servers/$serverId/connection"
                    params={{ serverId: server.id }}
                  />
                }
              >
                {m.admin_server_ws_open_connection()}
              </Button>
            </EmptyContent>
          </Empty>
        ) : waitingForSamples && !waitingElapsed ? (
          <>
            <StatStripSkeleton items={3} />
            <div className="grid gap-6 md:grid-cols-2">
              <ChartSkeleton />
              <ChartSkeleton />
              <ChartSkeleton />
              <ChartSkeleton />
            </div>
          </>
        ) : (
          <>
            {latest ? (
              <>
                <LiveGauges sample={latest} />
                <LiveEnvironment sample={latest} />
              </>
            ) : null}
            {live.samples.length > 0 ? (
              <LiveCharts samples={live.samples} />
            ) : (
              <LiveChartsEmpty />
            )}
            <NetworkInspection
              isError={inspection.isError}
              isPending={inspection.isPending}
              snapshot={inspection.data}
            />
          </>
        )}
      </PageContent>
    </WorkspaceViewport>
  );
}
