import { Link } from "@tanstack/react-router";
import {
  LayoutGridIcon,
  ListIcon,
  MaximizeIcon,
  PanelRightIcon,
  PlusIcon,
  SearchIcon,
  WorkflowIcon,
} from "lucide-react";
import type React from "react";
import { useEffect, useRef } from "react";

import { WorkbenchBar } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Tooltip,
  TooltipPopup,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages";

import { TopologyLegend } from "./topology-legend";

export type TopologyView = "graph" | "list";

export interface TopologyToolbarProps {
  query: string;
  onQueryChange: (query: string) => void;
  view: TopologyView;
  onViewChange: (view: TopologyView) => void;
  /** True when there is nothing to draw yet; only Add link stays enabled. */
  disabled?: boolean;
  serverCount: number;
  linkCount: number;
  onFit: () => void;
  onAutoLayout: () => void;
  railOpen: boolean;
  onToggleRail: () => void;
  searchRef: React.RefObject<HTMLInputElement | null>;
}

function SearchInput({
  query,
  onQueryChange,
  searchRef,
  disabled,
}: Pick<
  TopologyToolbarProps,
  "query" | "onQueryChange" | "searchRef" | "disabled"
>): React.ReactElement {
  return (
    <InputGroup className="h-8 w-40 shrink-0 lg:w-56">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={searchRef}
        type="search"
        size="sm"
        aria-label={m.admin_networking_topology_search_label()}
        disabled={disabled}
        placeholder={m.admin_networking_topology_wb_search_placeholder()}
        value={query}
        onValueChange={(value) => onQueryChange(value)}
      />
      <InputGroupAddon align="inline-end">
        <Kbd>/</Kbd>
      </InputGroupAddon>
    </InputGroup>
  );
}

function ToolbarTip({
  label,
  children,
}: {
  label: string;
  children: React.ReactElement;
}): React.ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger render={children} />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

export function TopologyToolbar({
  query,
  onQueryChange,
  view,
  onViewChange,
  disabled = false,
  serverCount,
  linkCount,
  onFit,
  onAutoLayout,
  railOpen,
  onToggleRail,
  searchRef,
}: TopologyToolbarProps): React.ReactElement {
  const handleViewChange = (value: string[]) => {
    const next = value[0];
    if (next === "graph" || next === "list") onViewChange(next);
  };

  return (
    <TooltipProvider>
      <WorkbenchBar data-slot="topology-toolbar">
        <SearchInput
          query={query}
          onQueryChange={onQueryChange}
          searchRef={searchRef}
          disabled={disabled}
        />
        <ToggleGroup
          aria-label={m.admin_networking_topology_wb_view_toggle()}
          className="ms-1"
          disabled={disabled}
          size="sm"
          value={[view]}
          onValueChange={handleViewChange}
        >
          <ToggleGroupItem
            aria-label={m.admin_networking_topology_wb_view_graph()}
            value="graph"
          >
            <WorkflowIcon aria-hidden />
          </ToggleGroupItem>
          <ToggleGroupItem
            aria-label={m.admin_networking_topology_wb_view_list()}
            value="list"
          >
            <ListIcon aria-hidden />
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="flex items-center gap-0.5">
          <ToolbarTip label={m.admin_networking_topology_wb_fit()}>
            <Button
              size="xs"
              variant="ghost"
              aria-label={m.admin_networking_topology_wb_fit()}
              disabled={disabled || view !== "graph"}
              onClick={onFit}
            >
              <MaximizeIcon />
              <span className="hidden xl:inline">
                {m.admin_networking_topology_wb_fit()}
              </span>
            </Button>
          </ToolbarTip>
          <ToolbarTip label={m.admin_networking_topology_wb_layout()}>
            <Button
              size="xs"
              variant="ghost"
              aria-label={m.admin_networking_topology_wb_layout()}
              disabled={disabled}
              onClick={onAutoLayout}
            >
              <LayoutGridIcon />
              <span className="hidden 2xl:inline">
                {m.admin_networking_topology_wb_layout()}
              </span>
            </Button>
          </ToolbarTip>
          <TopologyLegend disabled={disabled} />
        </div>

        <p className="ms-auto hidden text-xs text-muted-foreground tabular-nums xl:block">
          {m.admin_networking_topology_wb_summary({
            servers: serverCount,
            links: linkCount,
          })}
        </p>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/admin/networking/links" />}
        >
          <PlusIcon />
          {m.admin_networking_action_add_link()}
        </Button>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={m.admin_networking_topology_wb_rail()}
          aria-pressed={railOpen}
          aria-keyshortcuts="]"
          disabled={disabled}
          onClick={onToggleRail}
        >
          <PanelRightIcon />
        </Button>
      </WorkbenchBar>
    </TooltipProvider>
  );
}

/** Editor shortcuts: single keys, inactive inside text fields. */
const WORKBENCH_KEYS: Record<string, "search" | "fit" | "rail" | "clear"> = {
  "/": "search",
  f: "fit",
  F: "fit",
  "]": "rail",
  Escape: "clear",
};

function isTextTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

export interface UseTopologyShortcutsOptions {
  containerRef: React.RefObject<HTMLElement | null>;
  searchRef: React.RefObject<HTMLInputElement | null>;
  onKey: (key: "search" | "fit" | "rail" | "clear") => void;
}

/**
 * Binds the workbench's single-key shortcuts while focus is inside the
 * workbench. Text fields keep their own keys, so typing `f` in the search box
 * never changes the viewport.
 */
export function useTopologyShortcuts({
  containerRef,
  searchRef,
  onKey,
}: UseTopologyShortcutsOptions): void {
  const handlerRef = useRef(onKey);
  handlerRef.current = onKey;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (!container.contains(document.activeElement)) return;
      if (isTextTarget(event.target) && event.key !== "Escape") return;

      const action = WORKBENCH_KEYS[event.key];
      if (!action) return;

      if (action === "search") {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (action === "clear") {
        event.preventDefault();
        handlerRef.current("clear");
        if (isTextTarget(event.target)) searchRef.current?.blur();
        return;
      }
      event.preventDefault();
      handlerRef.current(action);
    };

    container.addEventListener("keydown", onKeyDown);
    return () => container.removeEventListener("keydown", onKeyDown);
  }, [containerRef, searchRef]);
}
