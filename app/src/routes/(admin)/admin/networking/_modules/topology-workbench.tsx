import { ClientOnly, Link } from "@tanstack/react-router";
import { PlusIcon, ServerOffIcon } from "lucide-react";
import type React from "react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";

import {
  WorkbenchBody,
  WorkbenchCanvas,
  WorkbenchRail,
  WorkbenchStatusBar,
} from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusDot } from "@/components/ui/status-dot";
import { useMediaQuery } from "@/hooks/use-media-query";
import {
  buildTopologyGraph,
  buildTopologyList,
  matchedServerIds,
  visibleSelection,
  type TopologyInput,
  type TopologySelection,
} from "@/lib/networking-topology";
import { layoutLayered } from "@/lib/networking-topology-layout";
import {
  clearTopologyPositions,
  effectiveTopologyPositions,
  readRailState,
  readTopologyPositions,
  writeRailState,
  writeTopologyPositions,
  type TopologyPosition,
  type TopologyPositions,
  type TopologyRailState,
  type TopologyStorage,
} from "@/lib/topology-positions";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import type { NetworkingWorkspaceData } from "@/query/networking-read";

import type { TopologyGraphApi } from "./topology-graph";
import { TopologyList } from "./topology-list";
import { TopologyRailContent, type TopologyRailTab } from "./topology-rail";
import {
  TopologyToolbar,
  useTopologyShortcuts,
  type TopologyView,
} from "./topology-toolbar";

const TopologyGraphCanvas = lazy(() => import("./topology-graph"));

/** In-pane placeholder while the lazy canvas chunk loads; not a full viewport. */
function TopologyCanvasSkeleton(): React.ReactElement {
  return (
    <div
      aria-busy="true"
      className="flex h-full w-full items-center justify-center"
      data-slot="topology-canvas-skeleton"
      role="status"
    >
      <span className="sr-only">{m.admin_ui_loading()}</span>
      <Skeleton className="h-16 w-56 rounded-lg" />
      <Skeleton className="ms-6 h-16 w-56 rounded-lg" />
      <Skeleton className="ms-6 h-16 w-56 rounded-lg" />
    </div>
  );
}

function browserStorage(): TopologyStorage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function toTopologyInput(data: NetworkingWorkspaceData): TopologyInput {
  return {
    servers: data.servers.map((row) => ({
      id: row.id,
      name: row.name,
      enabled: row.enabled,
    })),
    peerInbounds: data.peerInbounds.map((row) => ({
      id: row.id,
      serverId: row.serverId,
      name: row.name,
      protocol: row.protocol,
    })),
    links: data.links.map((row) => ({
      id: row.id,
      sourceServerId: row.sourceServerId,
      destinationInboundId: row.destinationInboundId,
      phase: row.phase,
      health: row.health,
    })),
  };
}

interface StatusCounts {
  servers: number;
  links: number;
  degraded: number;
  pending: number;
}

function countLinkStates(
  links: readonly { phase: string; health: string }[],
): Pick<StatusCounts, "degraded" | "pending"> {
  let degraded = 0;
  let pending = 0;
  for (const link of links) {
    if (
      link.health === "degraded" ||
      link.phase === "failed" ||
      link.phase === "stalled"
    ) {
      degraded += 1;
    }
    if (link.phase === "pending" || link.phase === "applying") {
      pending += 1;
    }
  }
  return { degraded, pending };
}

export interface TopologyWorkbenchProps {
  data: NetworkingWorkspaceData;
}

/**
 * Full-bleed topology workbench: toolbar, canvas or list, docked rail and
 * status bar. Owns view state, search, selection and the per-viewer
 * position/rail preferences. The React Flow canvas is a lazy client-only
 * chunk, so the route never ships or server-renders it.
 */
export function TopologyWorkbench({
  data,
}: TopologyWorkbenchProps): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const graphApiRef = useRef<TopologyGraphApi | null>(null);
  const storageRef = useRef<TopologyStorage | null>(browserStorage());
  const isNarrow = useMediaQuery("max-lg");
  const isCompact = useMediaQuery("max-md");

  const [query, setQuery] = useState("");
  const [viewState, setViewState] = useState<TopologyView | null>(null);
  const [selection, setSelection] = useState<TopologySelection | null>(null);
  const [railTab, setRailTab] = useState<TopologyRailTab>("inspector");
  const [railState, setRailState] = useState<TopologyRailState>("open");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [layoutEpoch, setLayoutEpoch] = useState(0);
  const [persisted, setPersisted] = useState<TopologyPositions>({});
  const persistedRef = useRef<TopologyPositions>({});
  const serverIds = data.servers.map((row) => row.id).join("\u0000");

  // Preferences live in `localStorage`, so read them after hydration only:
  // reading during the first render would mismatch the server markup.
  useEffect(() => {
    const storage = storageRef.current;
    if (!storage) return;
    setRailState(readRailState(storage));
    const stored = readTopologyPositions(
      storage,
      data.servers.map((row) => row.id),
    );
    persistedRef.current = stored;
    setPersisted(stored);
    // Only re-read when the set of servers changes, not on every refetch.
  }, [serverIds]);

  const input = toTopologyInput(data);
  const fullList = buildTopologyList(input);
  const list = query.trim() ? buildTopologyList(input, query) : fullList;
  const matched = matchedServerIds(fullList, query);
  const runtime = new Map(
    data.servers.map((row) => [
      row.id,
      { runtimeState: row.runtimeState, configState: row.configState },
    ]),
  );
  const graph = buildTopologyGraph(
    input,
    fullList,
    selection,
    matched,
    runtime,
  );
  const layout = layoutLayered(
    graph.nodes.map((node) => ({ id: node.id, name: node.data.name })),
    graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
    })),
  );
  const positions = effectiveTopologyPositions(layout.positions, persisted);
  const counts: StatusCounts = {
    servers: data.servers.length,
    links: data.links.length,
    ...countLinkStates(data.links),
  };
  const railOpen = railState === "open";
  const showDockedRail = railOpen && !isNarrow;
  const isEmpty = data.servers.length === 0;
  // Narrow screens start in the accessible list; an explicit toggle wins.
  const view: TopologyView = viewState ?? (isCompact ? "list" : "graph");

  const select = (next: TopologySelection | null) => {
    setSelection(next);
    if (!next) return;
    setRailTab("inspector");
    if (isNarrow) setSheetOpen(true);
    else setRailState("open");
  };

  const setView = (next: TopologyView) => {
    setViewState(next);
    if (next === "graph") graphApiRef.current?.fitViewSoon();
  };

  const fit = () => {
    if (view === "graph") graphApiRef.current?.fitView();
  };

  const autoLayout = () => {
    if (storageRef.current) clearTopologyPositions(storageRef.current);
    persistedRef.current = {};
    setPersisted({});
    setLayoutEpoch((epoch) => epoch + 1);
    setViewState("graph");
    graphApiRef.current?.fitViewSoon();
  };

  const toggleRail = () => {
    if (isNarrow) {
      setSheetOpen((open) => !open);
      return;
    }
    setRailState((current) => {
      const next: TopologyRailState = current === "open" ? "closed" : "open";
      if (storageRef.current) writeRailState(storageRef.current, next);
      return next;
    });
  };

  useTopologyShortcuts({
    containerRef,
    searchRef,
    onKey: (key) => {
      if (key === "search") searchRef.current?.focus();
      else if (key === "fit") fit();
      else if (key === "rail") toggleRail();
      else if (key === "clear") {
        setSelection(null);
        searchRef.current?.blur();
      }
    },
  });

  const handlePositionsChange = (
    changes: readonly { id: string; position: TopologyPosition }[],
  ) => {
    const next: Record<string, TopologyPosition> = { ...persistedRef.current };
    for (const change of changes) next[change.id] = change.position;
    persistedRef.current = next;
    setPersisted(next);
    if (storageRef.current) writeTopologyPositions(storageRef.current, next);
  };

  const rail = (
    <TopologyRailContent
      list={fullList}
      onTabChange={setRailTab}
      selection={selection}
      tab={railTab}
      workspace={data}
    />
  );

  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col"
      data-slot="topology-workbench"
      ref={containerRef}
    >
      <TopologyToolbar
        disabled={isEmpty}
        linkCount={counts.links}
        onAutoLayout={autoLayout}
        onFit={fit}
        onQueryChange={setQuery}
        onToggleRail={toggleRail}
        onViewChange={setView}
        query={query}
        railOpen={isNarrow ? sheetOpen : railOpen}
        searchRef={searchRef}
        serverCount={counts.servers}
        view={view}
      />

      {data.activationEnabled ? null : (
        <p
          className="flex h-8 shrink-0 items-center border-b bg-info/8 px-3 text-xs text-info-foreground"
          data-slot="topology-activation-notice"
          role="status"
        >
          {m.admin_networking_activation_disabled_title()}
        </p>
      )}

      <WorkbenchBody>
        <WorkbenchCanvas>
          {isEmpty ? (
            <Empty className="absolute inset-0">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <ServerOffIcon aria-hidden />
                </EmptyMedia>
                <EmptyTitle>{m.admin_networking_no_servers()}</EmptyTitle>
                <EmptyDescription>
                  {m.admin_networking_topology_empty()}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button
                  size="sm"
                  variant="outline"
                  render={<Link to="/admin/networking/links" />}
                >
                  <PlusIcon />
                  {m.admin_networking_action_add_link()}
                </Button>
              </EmptyContent>
            </Empty>
          ) : view === "graph" ? (
            <ClientOnly fallback={<TopologyCanvasSkeleton />}>
              <Suspense fallback={<TopologyCanvasSkeleton />}>
                <TopologyGraphCanvas
                  apiRef={graphApiRef}
                  graph={graph}
                  layoutEpoch={layoutEpoch}
                  onPositionsChange={handlePositionsChange}
                  onSelectionChange={select}
                  positions={positions}
                />
              </Suspense>
            </ClientOnly>
          ) : (
            <TopologyList
              filtered={query.trim().length > 0}
              list={list}
              onSelectionChange={select}
              selection={visibleSelection(list.servers, selection)}
            />
          )}
        </WorkbenchCanvas>

        {showDockedRail ? (
          <WorkbenchRail className="overflow-hidden">{rail}</WorkbenchRail>
        ) : null}
      </WorkbenchBody>

      <WorkbenchStatusBar data-slot="topology-status-bar">
        <span className="flex items-center gap-1.5">
          <StatusDot
            label={
              counts.degraded > 0
                ? m.admin_networking_topology_wb_status_degraded({
                    count: counts.degraded,
                  })
                : m.admin_networking_topology_wb_status_healthy()
            }
            tone={counts.degraded > 0 ? "warning" : "success"}
          />
          {m.admin_networking_topology_wb_status_servers({
            count: counts.servers,
          })}
        </span>
        <span>
          {m.admin_networking_topology_wb_status_links({ count: counts.links })}
        </span>
        {counts.degraded > 0 ? (
          <span className="text-warning-foreground">
            {m.admin_networking_topology_wb_status_degraded({
              count: counts.degraded,
            })}
          </span>
        ) : null}
        {counts.pending > 0 ? (
          <span>
            {m.admin_networking_topology_wb_status_pending({
              count: counts.pending,
            })}
          </span>
        ) : null}
        {fullList.unresolvedLinkIds.length > 0 ? (
          <span className="text-warning-foreground">
            {m.admin_networking_topology_wb_status_unresolved({
              count: fullList.unresolvedLinkIds.length,
            })}
          </span>
        ) : null}
        <span className={cn("ms-auto hidden xl:block")}>
          {m.admin_networking_topology_wb_shortcuts()}
        </span>
      </WorkbenchStatusBar>

      {isNarrow ? (
        <Sheet onOpenChange={setSheetOpen} open={sheetOpen}>
          <SheetPopup className="w-[22rem] max-w-full" side="right">
            <SheetHeader>
              <SheetTitle>{m.admin_networking_topology_wb_rail()}</SheetTitle>
              <SheetDescription>
                {m.admin_networking_topology_select_prompt()}
              </SheetDescription>
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">{rail}</div>
          </SheetPopup>
        </Sheet>
      ) : null}
    </div>
  );
}
