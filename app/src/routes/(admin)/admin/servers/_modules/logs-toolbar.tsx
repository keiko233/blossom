"use client";

import type {
  AgentWsV2LogLevel,
  AgentWsV2LogSource,
} from "@blossom/contracts/agent-ws-v2-logs";
import {
  CopyIcon,
  PauseIcon,
  PlayIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  XIcon,
} from "lucide-react";
import type React from "react";

import { WorkbenchBar } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { StatusDot } from "@/components/ui/status-dot";
import { Toggle } from "@/components/ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import type { LogPolicyToolbarTone } from "@/lib/admin-logs-view";
import { m } from "@/paraglide/messages";

const SOURCE_OPTIONS = ["all", "agent", "sing-box"] as const;
const LEVEL_OPTIONS = ["trace", "debug", "info", "warn", "error"] as const;

function sourceLabel(source: (typeof SOURCE_OPTIONS)[number]): string {
  switch (source) {
    case "all":
      return m.agent_logs_filter_source_all();
    case "agent":
      return m.agent_logs_filter_source_agent();
    case "sing-box":
      return m.agent_logs_filter_source_sing_box();
  }
}

const policyToneToDot: Record<
  Exclude<LogPolicyToolbarTone, null>,
  "warning" | "info" | "danger"
> = {
  warning: "warning",
  info: "info",
  danger: "danger",
};

function policyToneLabel(tone: Exclude<LogPolicyToolbarTone, null>): string {
  switch (tone) {
    case "warning":
      return m.agent_logs_toolbar_policy_pending();
    case "info":
      return m.agent_logs_toolbar_policy_applying();
    case "danger":
      return m.agent_logs_toolbar_policy_error();
  }
}

export interface LogsToolbarProps {
  following: boolean;
  followDisabled: boolean;
  controlsDisabled: boolean;
  source: AgentWsV2LogSource | undefined;
  minLevel: AgentWsV2LogLevel | undefined;
  onUpdateSource(value: string | null): void;
  onUpdateLevel(value: string | null): void;
  onFollowChange(pressed: boolean): void;
  searchOpen: boolean;
  searchDisabled: boolean;
  onToggleSearch(): void;
  policyTone: LogPolicyToolbarTone;
  onOpenPolicy(): void;
  selectedCount: number;
  copying: boolean;
  onCopy(): void;
  onClearSelection(): void;
}

export function LogsToolbar({
  following,
  followDisabled,
  controlsDisabled,
  source,
  minLevel,
  onUpdateSource,
  onUpdateLevel,
  onFollowChange,
  searchOpen,
  searchDisabled,
  onToggleSearch,
  policyTone,
  onOpenPolicy,
  selectedCount,
  copying,
  onCopy,
  onClearSelection,
}: LogsToolbarProps): React.ReactElement {
  return (
    <WorkbenchBar data-slot="logs-toolbar" aria-label={m.agent_logs_title()}>
      <Tooltip>
        <TooltipTrigger
          render={
            <Toggle
              size="sm"
              variant="outline"
              pressed={following}
              disabled={followDisabled}
              aria-keyshortcuts="F"
              onPressedChange={onFollowChange}
            />
          }
        >
          {following ? <PauseIcon /> : <PlayIcon />}
          <span className="hidden lg:inline">
            {following
              ? m.agent_logs_action_pause()
              : m.agent_logs_action_resume()}
          </span>
        </TooltipTrigger>
        <TooltipPopup>
          <span className="inline-flex items-center gap-1.5">
            {following
              ? m.agent_logs_toolbar_pause_hint()
              : m.agent_logs_toolbar_follow_hint()}
            <Kbd>F</Kbd>
          </span>
        </TooltipPopup>
      </Tooltip>

      <Select
        items={SOURCE_OPTIONS.map((value) => ({
          label: sourceLabel(value),
          value,
        }))}
        value={source ?? "all"}
        onValueChange={onUpdateSource}
        disabled={controlsDisabled}
      >
        <SelectTrigger
          size="sm"
          className="w-28"
          aria-label={m.agent_logs_filter_source()}
          disabled={controlsDisabled}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {SOURCE_OPTIONS.map((value) => (
            <SelectItem key={value} value={value}>
              {sourceLabel(value)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <Select
        items={LEVEL_OPTIONS.map((value) => ({ label: value, value }))}
        value={minLevel ?? "trace"}
        onValueChange={onUpdateLevel}
        disabled={controlsDisabled}
      >
        <SelectTrigger
          size="sm"
          className="w-24"
          aria-label={m.agent_logs_filter_level()}
          disabled={controlsDisabled}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {LEVEL_OPTIONS.map((value) => (
            <SelectItem key={value} value={value}>
              {value}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>

      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-pressed={searchOpen}
            aria-keyshortcuts="Control+F Meta+F"
            aria-label={m.agent_logs_toolbar_search()}
            disabled={searchDisabled}
            onClick={onToggleSearch}
          >
            <SearchIcon />
          </Button>
        </TooltipTrigger>
        <TooltipPopup>
          {searchDisabled
            ? m.agent_logs_toolbar_search_unsupported()
            : m.agent_logs_toolbar_search_hint()}
        </TooltipPopup>
      </Tooltip>

      <div className="ms-auto flex min-w-0 items-center gap-1">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                aria-label={m.agent_logs_policy_title()}
                onClick={onOpenPolicy}
              />
            }
          >
            <SlidersHorizontalIcon />
            <span className="hidden xl:inline">
              {m.agent_logs_policy_title()}
            </span>
            {policyTone ? (
              <StatusDot
                tone={policyToneToDot[policyTone]}
                label={policyToneLabel(policyTone)}
              />
            ) : null}
          </TooltipTrigger>
          <TooltipPopup>
            {policyTone
              ? policyToneLabel(policyTone)
              : m.agent_logs_toolbar_policy_hint()}
          </TooltipPopup>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                loading={copying}
                disabled={selectedCount === 0}
                onClick={onCopy}
              />
            }
          >
            <CopyIcon />
            <span className="max-lg:sr-only">
              {m.agent_logs_action_copy_selected({ count: selectedCount })}
            </span>
          </TooltipTrigger>
          <TooltipPopup>{m.agent_logs_toolbar_copy_hint()}</TooltipPopup>
        </Tooltip>

        {selectedCount > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={m.agent_logs_action_clear_selection()}
                  onClick={onClearSelection}
                />
              }
            >
              <XIcon />
            </TooltipTrigger>
            <TooltipPopup>{m.agent_logs_toolbar_clear_hint()}</TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
    </WorkbenchBar>
  );
}
