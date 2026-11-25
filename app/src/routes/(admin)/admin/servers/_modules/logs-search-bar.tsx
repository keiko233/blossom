"use client";

import { ChevronDownIcon, SearchIcon, XIcon } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Kbd } from "@/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@/components/ui/tooltip";
import { m } from "@/paraglide/messages";

export interface LogsSearchBarProps {
  query: string;
  onQueryChange(value: string): void;
  since: string;
  onSinceChange(value: string): void;
  until: string;
  onUntilChange(value: string): void;
  rangeInvalid: boolean;
  onSubmit(event: React.FormEvent<HTMLFormElement>): void;
  onClose(): void;
  disabled: boolean;
  /** Bumped when a shortcut asks the already-open input to take focus. */
  focusNonce: number;
}

export function LogsSearchBar({
  query,
  onQueryChange,
  since,
  onSinceChange,
  until,
  onUntilChange,
  rangeInvalid,
  onSubmit,
  onClose,
  disabled,
  focusNonce,
}: LogsSearchBarProps): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [rangeOpen, setRangeOpen] = useState(false);
  const rangeSet = since.length > 0 || until.length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, [focusNonce]);

  return (
    <div
      data-slot="logs-search-bar"
      className="flex h-9 shrink-0 items-center gap-2 border-b bg-background px-2"
    >
      <form
        className="flex min-w-0 flex-1 items-center gap-2"
        onSubmit={onSubmit}
      >
        <InputGroup className="h-7 min-w-0 flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            ref={inputRef}
            type="search"
            value={query}
            maxLength={256}
            disabled={disabled}
            placeholder={m.agent_logs_search_placeholder()}
            aria-label={m.agent_logs_search_label()}
            aria-invalid={rangeInvalid}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onClose();
              }
            }}
          />
          <InputGroupAddon align="inline-end">
            <Kbd>Ctrl</Kbd>
            <Kbd>F</Kbd>
          </InputGroupAddon>
        </InputGroup>

        <Popover open={rangeOpen} onOpenChange={setRangeOpen}>
          <PopoverTrigger
            render={
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={disabled}
                aria-label={m.agent_logs_search_bar_range()}
              />
            }
          >
            {m.agent_logs_search_bar_range()}
            {rangeSet ? (
              <span
                aria-label={m.agent_logs_search_bar_range_set()}
                className="size-1.5 rounded-full bg-primary"
              />
            ) : null}
            <ChevronDownIcon />
          </PopoverTrigger>
          <PopoverPopup className="w-72 p-3" align="end">
            <div className="flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {m.agent_logs_search_from()}
                <Input
                  type="datetime-local"
                  value={since}
                  disabled={disabled}
                  onChange={(event) => onSinceChange(event.target.value)}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-muted-foreground">
                {m.agent_logs_search_until()}
                <Input
                  type="datetime-local"
                  value={until}
                  disabled={disabled}
                  onChange={(event) => onUntilChange(event.target.value)}
                />
              </label>
              {rangeInvalid ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {m.agent_logs_search_invalid_range()}
                </p>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={!rangeSet}
                onClick={() => {
                  onSinceChange("");
                  onUntilChange("");
                }}
              >
                {m.agent_logs_search_bar_range_clear()}
              </Button>
            </div>
          </PopoverPopup>
        </Popover>

        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="submit"
                size="xs"
                disabled={disabled}
                aria-label={m.agent_logs_action_search()}
              />
            }
          >
            <SearchIcon />
            <span className="max-lg:sr-only">
              {m.agent_logs_action_search()}
            </span>
          </TooltipTrigger>
          <TooltipPopup>{m.agent_logs_search_bar_submit_hint()}</TooltipPopup>
        </Tooltip>
      </form>

      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={m.agent_logs_search_bar_close()}
              onClick={onClose}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup>{m.agent_logs_search_bar_close()}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
