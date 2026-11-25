"use client";

import { SquareTerminalIcon } from "lucide-react";
import type React from "react";

import { Button } from "@/components/ui/button";
import type { TerminalPhase } from "@/lib/terminal-view";
import { m } from "@/paraglide/messages";

export interface TerminalEmptyStateProps {
  notice: string | null;
  onConnect(): void;
  opening: boolean;
  phase: TerminalPhase;
  unavailable: string | null;
}

export function TerminalEmptyState({
  notice,
  onConnect,
  opening,
  phase,
  unavailable,
}: TerminalEmptyStateProps): React.ReactElement {
  const ended = phase === "error" || phase === "closed";
  const message =
    unavailable ??
    (ended && notice
      ? notice
      : phase === "connecting"
        ? m.agent_terminal_status_connecting()
        : m.agent_terminal_empty_idle());
  const role =
    ended && notice ? (phase === "error" ? "alert" : "status") : undefined;

  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-terminal p-6 text-center text-[color:var(--terminal-foreground)]"
      data-slot="terminal-empty-state"
    >
      <SquareTerminalIcon className="size-8 opacity-60" />
      <p className="max-w-md text-sm" role={role}>
        {message}
      </p>
      <Button
        disabled={Boolean(unavailable) || opening}
        loading={opening}
        onClick={onConnect}
      >
        {ended
          ? m.agent_terminal_empty_reconnect()
          : m.agent_terminal_action_connect()}
      </Button>
      {!unavailable && !ended ? (
        <p className="max-w-md text-xs opacity-60">
          {m.agent_terminal_opt_in_note()}
        </p>
      ) : null}
    </div>
  );
}
