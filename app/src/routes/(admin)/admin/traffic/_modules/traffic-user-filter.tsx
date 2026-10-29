import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import {
  searchTrafficUsers,
  TRAFFIC_ANALYTICS_QUERY_KEY,
} from "@/query/traffic-analytics";

export interface TrafficUserFilterProps {
  /** The selected user's id from the URL, if any. */
  userId: string | undefined;
  onChange: (userId: string | undefined) => void;
}

/**
 * Filters traffic to one user: search by name or email, pick a match, and the
 * choice shows as a removable chip. The id lives in the URL.
 */
export function TrafficUserFilter({
  userId,
  onChange,
}: TrafficUserFilterProps): React.ReactElement {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  // An exact id search resolves the chip label.
  const selected = useQuery({
    queryKey: [...TRAFFIC_ANALYTICS_QUERY_KEY, "user", userId],
    queryFn: () => searchTrafficUsers({ data: { q: userId } }),
    enabled: Boolean(userId),
  });
  const results = useQuery({
    queryKey: [...TRAFFIC_ANALYTICS_QUERY_KEY, "user-search", query],
    queryFn: () => searchTrafficUsers({ data: { q: query } }),
    enabled: !userId && query.length > 0,
    placeholderData: keepPreviousData,
  });

  if (userId) {
    const match = selected.data?.find((item) => item.id === userId);
    return (
      <div className="flex h-9 items-center gap-1 rounded-lg border bg-background ps-3 pe-1 text-sm sm:h-8">
        <span className="max-w-56 truncate">{match ? match.name : userId}</span>
        <Button
          aria-label={m.admin_traffic_filter_user_clear()}
          size="icon-xs"
          variant="ghost"
          onClick={() => {
            setQuery("");
            onChange(undefined);
          }}
        >
          <XIcon />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="relative"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onFocus={() => setOpen(true)}
      onKeyDown={(event) => {
        if (event.key === "Escape") setOpen(false);
      }}
    >
      <DebouncedSearchInput
        defaultValue=""
        placeholder={m.admin_traffic_filter_user_search()}
        onSearch={(value) => {
          setQuery(value);
          setOpen(true);
        }}
      />
      {open && query.length > 0 && results.data ? (
        <ul className="absolute start-0 top-full z-20 mt-1 max-h-64 w-full min-w-64 overflow-auto rounded-lg border bg-popover p-1 text-sm text-popover-foreground shadow-md">
          {results.data.length === 0 ? (
            <li className="px-2 py-1.5 text-muted-foreground">
              {m.admin_traffic_filter_user_none()}
            </li>
          ) : (
            results.data.map((item) => (
              <li key={item.id}>
                <button
                  className="flex w-full flex-col rounded-md px-2 py-1.5 text-start hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onChange(item.id);
                  }}
                >
                  <span className="truncate">{item.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {item.email}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  );
}
