import { cva } from "class-variance-authority";

const LOG_TIME_FALLBACK = "--:--:--.---";
const LOG_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:\d{2})?$/;

/**
 * `HH:MM:SS.mmm` for a wire timestamp. The agent sends UTC ISO strings, so the
 * value is read from the string instead of a local-time `Date`; an explicit
 * offset is normalized back to UTC. Anything else renders a placeholder rather
 * than throwing inside a virtualized row.
 */
export function formatLogTime(iso: string): string {
  const match = LOG_TIME_PATTERN.exec(iso.trim());
  if (!match) {
    return LOG_TIME_FALLBACK;
  }
  const [, stamp, zone] = match;
  if (!stamp) {
    return LOG_TIME_FALLBACK;
  }
  if (zone && zone !== "Z") {
    const parsed = new Date(`${stamp}${zone}`);
    return Number.isNaN(parsed.getTime())
      ? LOG_TIME_FALLBACK
      : parsed.toISOString().slice(11, 23);
  }
  const [clock, fraction = ""] = stamp.slice(11).split(".");
  return `${clock}.${`${fraction}000`.slice(0, 3)}`;
}

const LOG_LEVEL_WIDTH = 5;

/** Fixed-width, uppercase level label so every row aligns. */
export function padLevel(level: string): string {
  return level
    .trim()
    .toUpperCase()
    .slice(0, LOG_LEVEL_WIDTH)
    .padEnd(LOG_LEVEL_WIDTH, " ");
}

/**
 * Level colors come from semantic tokens and never carry meaning alone: the
 * padded label is always rendered next to them.
 */
export const logLevelVariants = cva(
  "inline-block whitespace-pre font-mono font-semibold",
  {
    defaultVariants: {
      level: "unknown",
    },
    variants: {
      level: {
        trace: "text-muted-foreground",
        debug: "text-muted-foreground",
        info: "text-info-foreground",
        warn: "text-warning-foreground",
        error: "text-destructive-foreground",
        unknown: "text-muted-foreground",
      },
    },
  },
);

export type LogLevelVariant = NonNullable<
  Parameters<typeof logLevelVariants>[0]
>["level"];

/** Narrows an untrusted wire level to a known variant. */
export function logLevelVariant(level: string): LogLevelVariant {
  switch (level) {
    case "trace":
    case "debug":
    case "info":
    case "warn":
    case "error":
      return level;
    default:
      return "unknown";
  }
}

/** One fixed-height grid row: gutter, time, level, source, message, marker. */
export const logRowVariants = cva(
  [
    "grid h-[26px] w-max min-w-full items-center gap-2 px-2",
    "whitespace-pre font-mono text-xs",
    "grid-cols-[1.25rem_8.5rem_3.75rem_5.5rem_minmax(0,1fr)_auto]",
  ],
  {
    defaultVariants: {
      state: "idle",
    },
    variants: {
      state: {
        idle: "hover:bg-accent/40",
        active: "bg-accent/60",
        gap: "bg-warning/8 text-warning-foreground",
      },
    },
  },
);

/** Search results dock right at `xl`; narrower panes stack them below. */
export function resultsPlacement(width: number): "right" | "bottom" {
  return width >= 1280 ? "right" : "bottom";
}
