import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import type React from "react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

type ProgressPhase = "idle" | "loading" | "done";

/** Requests that finish sooner than this never paint the bar, avoiding flicker. */
const SHOW_DELAY_MS = 120;

/** Keep the completed bar painted until its completion animation has finished. */
const COMPLETE_HOLD_MS = 320;

/**
 * Page-top activity bar. It paints while the router loads a match, while a
 * query fetches its first data, and while any mutation is in flight, so clicks
 * that wait on the network never look ignored.
 */
export function TopProgressBar(): React.ReactElement {
  const isRouteLoading = useRouterState({ select: (state) => state.isLoading });

  // Queries that already carry data only refetch in the background (polling,
  // invalidation) and must not keep the bar blinking.
  const pendingInitialFetches = useIsFetching({
    predicate: (query) => query.state.status === "pending",
  });
  const pendingMutations = useIsMutating();

  const busy =
    isRouteLoading || pendingInitialFetches > 0 || pendingMutations > 0;

  const [phase, setPhase] = useState<ProgressPhase>("idle");

  useEffect(() => {
    if (!busy) {
      setPhase((current) => (current === "loading" ? "done" : current));
      return;
    }

    const timeout = setTimeout(() => setPhase("loading"), SHOW_DELAY_MS);
    return () => clearTimeout(timeout);
  }, [busy]);

  useEffect(() => {
    if (phase !== "done") return;

    const timeout = setTimeout(() => setPhase("idle"), COMPLETE_HOLD_MS);
    return () => clearTimeout(timeout);
  }, [phase]);

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-x-0 top-0 z-70 h-0.5 overflow-hidden"
      data-phase={phase}
      data-slot="top-progress-bar"
    >
      <div
        className={cn(
          "h-full origin-left bg-primary",
          phase === "idle" && "scale-x-0",
          phase === "loading" && "animate-top-progress-trickle",
          phase === "done" && "animate-top-progress-complete",
        )}
        data-slot="top-progress-bar-indicator"
      />
    </div>
  );
}
