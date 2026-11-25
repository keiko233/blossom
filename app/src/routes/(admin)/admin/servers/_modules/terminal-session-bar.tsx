"use client";

import {
  EraserIcon,
  Maximize2Icon,
  SquareTerminalIcon,
  UnplugIcon,
} from "lucide-react";
import type React from "react";

import { WorkbenchBar } from "@/components/app-shell/workspace";
import { Button } from "@/components/ui/button";
import { Group } from "@/components/ui/group";
import { StatusDot } from "@/components/ui/status-dot";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import {
  clampTerminalFontSize,
  formatTerminalIdentity,
  TERMINAL_FONT_SIZE,
  terminalPhasePulse,
  terminalPhaseTone,
  type TerminalPhase,
} from "@/lib/terminal-view";
import { m } from "@/paraglide/messages";

export interface TerminalIdentity {
  shell: string;
  user: string;
}

export interface TerminalSessionBarProps {
  fontSize: number;
  host: string;
  identity: TerminalIdentity | null;
  onClear(): void;
  onConnect(): void;
  onDisconnect(): void;
  onFontSizeChange(next: number): void;
  onRefit(): void;
  opening: boolean;
  phase: TerminalPhase;
  terminalMounted: boolean;
  unavailable: boolean;
}

function phaseLabel(phase: TerminalPhase): string {
  switch (phase) {
    case "connecting":
      return m.agent_terminal_status_connecting();
    case "connected":
      return m.agent_terminal_status_connected();
    case "error":
      return m.agent_terminal_status_error();
    case "closed":
      return m.agent_terminal_status_closed();
    default:
      return m.agent_terminal_status_idle();
  }
}

export function TerminalSessionBar({
  fontSize,
  host,
  identity,
  onClear,
  onConnect,
  onDisconnect,
  onFontSizeChange,
  onRefit,
  opening,
  phase,
  terminalMounted,
  unavailable,
}: TerminalSessionBarProps): React.ReactElement {
  const showDisconnect =
    terminalMounted && (phase === "connected" || phase === "connecting");

  return (
    <WorkbenchBar
      aria-label={m.agent_terminal_bar_label()}
      className="gap-2 px-3"
      data-slot="terminal-session-bar"
    >
      <span className="flex min-w-0 items-center gap-1.5" role="status">
        <StatusDot
          pulse={terminalPhasePulse(phase)}
          tone={terminalPhaseTone(phase)}
        />
        <span className="shrink-0 text-xs font-medium">
          {phaseLabel(phase)}
        </span>
      </span>

      {phase === "connected" && identity ? (
        <span
          className="min-w-0 truncate font-mono text-xs text-muted-foreground"
          data-slot="terminal-identity"
        >
          {formatTerminalIdentity(identity.user, identity.shell, host)}
        </span>
      ) : null}

      <div className="ms-auto flex shrink-0 items-center gap-1">
        {showDisconnect ? (
          <Button
            aria-label={m.agent_terminal_action_disconnect()}
            size="xs"
            variant="outline"
            onClick={onDisconnect}
          >
            <UnplugIcon />
            <span className="max-lg:sr-only">
              {m.agent_terminal_action_disconnect()}
            </span>
          </Button>
        ) : (
          <Button
            aria-label={
              terminalMounted
                ? m.agent_terminal_empty_reconnect()
                : m.agent_terminal_action_connect()
            }
            size="xs"
            disabled={unavailable || opening}
            loading={opening}
            onClick={onConnect}
          >
            <SquareTerminalIcon />
            <span className="max-lg:sr-only">
              {terminalMounted
                ? m.agent_terminal_empty_reconnect()
                : m.agent_terminal_action_connect()}
            </span>
          </Button>
        )}

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={m.agent_terminal_action_clear()}
                disabled={!terminalMounted}
                size="icon-xs"
                variant="ghost"
                onClick={onClear}
              />
            }
          >
            <EraserIcon />
          </TooltipTrigger>
          <TooltipPopup>{m.agent_terminal_action_clear()}</TooltipPopup>
        </Tooltip>

        <Group aria-label={m.agent_terminal_font_label()}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={m.agent_terminal_font_decrease()}
                  disabled={
                    !terminalMounted || fontSize <= TERMINAL_FONT_SIZE.min
                  }
                  size="icon-xs"
                  variant="ghost"
                  onClick={() => onFontSizeChange(fontSize - 1)}
                />
              }
            >
              <span aria-hidden>−</span>
            </TooltipTrigger>
            <TooltipPopup>{m.agent_terminal_font_decrease()}</TooltipPopup>
          </Tooltip>
          <span
            className="w-6 text-center text-xs text-muted-foreground tabular-nums"
            data-slot="terminal-font-size"
          >
            {fontSize}
          </span>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  aria-label={m.agent_terminal_font_increase()}
                  disabled={
                    !terminalMounted || fontSize >= TERMINAL_FONT_SIZE.max
                  }
                  size="icon-xs"
                  variant="ghost"
                  onClick={() =>
                    onFontSizeChange(clampTerminalFontSize(fontSize + 1))
                  }
                />
              }
            >
              <span aria-hidden>+</span>
            </TooltipTrigger>
            <TooltipPopup>{m.agent_terminal_font_increase()}</TooltipPopup>
          </Tooltip>
        </Group>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={m.agent_terminal_bar_refit()}
                disabled={!terminalMounted}
                size="icon-xs"
                variant="ghost"
                onClick={onRefit}
              />
            }
          >
            <Maximize2Icon />
          </TooltipTrigger>
          <TooltipPopup>{m.agent_terminal_bar_refit()}</TooltipPopup>
        </Tooltip>
      </div>
    </WorkbenchBar>
  );
}
