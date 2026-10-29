import type React from "react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  bandIndexAt,
  clamp,
  labelIndices,
  niceByteTicks,
  scaleLinear,
  stackSeries,
} from "@/lib/chart-math";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface StackedBarSeries {
  label: string;
  /** Any CSS color; pass a theme variable, e.g. `var(--chart-up)`. */
  color: string;
}

export interface StackedBarPoint {
  /** Stable key and x-axis position of the bucket (e.g. epoch ms). */
  start: number;
  /** One value per series, series 0 at the bottom of the stack. */
  values: readonly number[];
}

export interface StackedBarChartLabels {
  /** Accessible name of the chart. */
  chart: string;
  /** Keyboard instructions, announced when the chart is focused. */
  hint: string;
  /** Heading of the time column in the tooltip and the screen-reader table. */
  time: string;
  total: string;
  /** Time zone suffix of times, e.g. "UTC". */
  timeZone: string;
  /** Shown over the plot when every value is zero. */
  empty: string;
}

export interface StackedBarChartProps {
  points: readonly StackedBarPoint[];
  series: readonly StackedBarSeries[];
  labels: StackedBarChartLabels;
  /** Compact x-axis label and a longer one for tooltip / table. */
  formatX: (start: number, kind: "axis" | "full") => string;
  /** Value formatter for ticks, tooltip and table; defaults to bytes. */
  formatValue?: (value: number) => string;
  /** Plot height in px (default 240). */
  height?: number;
  className?: string;
}

const MARGIN = { top: 8, right: 8, bottom: 24, left: 56 } as const;
const TOOLTIP_WIDTH = 188;
const MIN_LABEL_SPACING = 72;
const DEFAULT_WIDTH = 640;

function formatTick(value: number, formatValue: (v: number) => string): string {
  return value === 0 ? "0" : formatValue(value);
}

/**
 * Dependency-free stacked bar chart: one bar per bucket, one stacked segment
 * per series, zero buckets drawn as empty slots (never interpolated).
 *
 * - Responsive: width follows the container (`ResizeObserver`).
 * - Themed: colors come from the `series` colors and theme tokens, so it works
 *   in light and dark mode.
 * - Hover and keyboard: pointer position or Left/Right/Home/End on the focused
 *   chart picks a bucket and shows a tooltip; Escape clears it. The active
 *   bucket is also announced through a polite live region.
 * - Screen readers get a visually hidden data table with every bucket; the SVG
 *   itself is decorative.
 */
export function StackedBarChart({
  points,
  series,
  labels,
  formatX,
  formatValue = formatBytes,
  height = 240,
  className,
}: StackedBarChartProps): React.ReactElement {
  const id = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;
    const update = () => setWidth(Math.max(160, element.clientWidth));
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const layers = useMemo(
    () =>
      stackSeries(
        series.map((_, seriesIndex) =>
          points.map((point) => point.values[seriesIndex] ?? 0),
        ),
      ),
    [points, series],
  );
  const totals = useMemo(
    () =>
      points.map((point) =>
        series.reduce(
          (sum, _, seriesIndex) => sum + (point.values[seriesIndex] ?? 0),
          0,
        ),
      ),
    [points, series],
  );
  const dataMax = Math.max(0, ...totals);
  const { ticks, max: axisMax } = useMemo(
    () => niceByteTicks(dataMax),
    [dataMax],
  );

  const plotLeft = MARGIN.left;
  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const y = scaleLinear([0, axisMax], [MARGIN.top + plotHeight, MARGIN.top]);
  const count = points.length;
  const band = count > 0 ? plotWidth / count : plotWidth;
  // Leave a hairline between neighbouring bars once they are wide enough.
  const gap = band >= 6 ? Math.min(4, band * 0.2) : 0;
  const barWidth = Math.max(1, band - gap);
  const xLabels = labelIndices(count, band, MIN_LABEL_SPACING);

  const select = useCallback(
    (next: number | null) => setActive(next),
    [setActive],
  );

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    select(bandIndexAt(event.clientX - rect.left, plotLeft, plotWidth, count));
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (count === 0) return;
    const current = active ?? count - 1;
    let next: number | null | undefined;
    switch (event.key) {
      case "ArrowLeft":
        next = clamp(current - 1, 0, count - 1);
        break;
      case "ArrowRight":
        next = clamp(current + 1, 0, count - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = count - 1;
        break;
      case "Escape":
        next = null;
        break;
    }
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  };

  const activePoint = active === null ? undefined : points[active];
  const activeTotal = active === null ? 0 : (totals[active] ?? 0);
  const activeCenter =
    active === null ? 0 : plotLeft + band * active + band / 2;
  const tooltipLeft = clamp(
    activeCenter,
    TOOLTIP_WIDTH / 2,
    Math.max(TOOLTIP_WIDTH / 2, width - TOOLTIP_WIDTH / 2),
  );
  const announcement = activePoint
    ? [
        formatX(activePoint.start, "full"),
        ...series.map(
          (item, seriesIndex) =>
            `${item.label} ${formatValue(activePoint.values[seriesIndex] ?? 0)}`,
        ),
        `${labels.total} ${formatValue(activeTotal)}`,
      ].join(", ")
    : "";
  const isEmpty = dataMax === 0;

  return (
    <div
      aria-describedby={`${id}-hint`}
      aria-label={labels.chart}
      className={cn(
        "relative w-full touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
      ref={containerRef}
      role="group"
      style={{ height }}
      tabIndex={0}
      onBlur={() => select(null)}
      onFocus={(event) => {
        // Keyboard focus starts on the newest bucket; clicks keep hover control.
        if (active === null && event.currentTarget.matches(":focus-visible")) {
          select(count > 0 ? count - 1 : null);
        }
      }}
      onKeyDown={onKeyDown}
      onPointerLeave={() => select(null)}
      onPointerMove={onPointerMove}
    >
      <span className="sr-only" id={`${id}-hint`}>
        {labels.hint}
      </span>

      <svg
        aria-hidden="true"
        className="block"
        height={height}
        role="presentation"
        width={width}
      >
        {/* Horizontal grid and y tick labels */}
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              stroke="var(--border)"
              x1={plotLeft}
              x2={plotLeft + plotWidth}
              y1={y(tick)}
              y2={y(tick)}
            />
            <text
              dominantBaseline="middle"
              fill="var(--muted-foreground)"
              fontSize={11}
              textAnchor="end"
              x={plotLeft - 8}
              y={y(tick)}
            >
              {formatTick(tick, formatValue)}
            </text>
          </g>
        ))}

        {/* Active bucket highlight */}
        {active === null ? null : (
          <rect
            fill="var(--muted)"
            height={plotHeight}
            width={band}
            x={plotLeft + band * active}
            y={MARGIN.top}
          />
        )}

        {/* Bars: series 0 at the bottom. Empty buckets simply have no height. */}
        {points.map((point, pointIndex) => (
          <g key={point.start}>
            {series.map((item, seriesIndex) => {
              const segment = layers[seriesIndex]?.[pointIndex];
              if (!segment || segment.y1 <= segment.y0) return null;
              const top = y(segment.y1);
              return (
                <rect
                  fill={item.color}
                  height={Math.max(0, y(segment.y0) - top)}
                  key={seriesIndex}
                  width={barWidth}
                  x={plotLeft + band * pointIndex + gap / 2}
                  y={top}
                />
              );
            })}
          </g>
        ))}

        {/* Baseline and x labels */}
        <line
          stroke="var(--border)"
          x1={plotLeft}
          x2={plotLeft + plotWidth}
          y1={MARGIN.top + plotHeight}
          y2={MARGIN.top + plotHeight}
        />
        {xLabels.map((index) => {
          const point = points[index];
          if (!point) return null;
          // Keep the first / last label inside the SVG.
          const anchor =
            index === 0 && band < 24
              ? "start"
              : index === count - 1 && band < 24
                ? "end"
                : "middle";
          return (
            <text
              fill="var(--muted-foreground)"
              fontSize={11}
              key={point.start}
              textAnchor={anchor}
              x={
                plotLeft +
                band * index +
                (anchor === "start" ? 0 : anchor === "end" ? band : band / 2)
              }
              y={height - 6}
            >
              {formatX(point.start, "axis")}
            </text>
          );
        })}
      </svg>

      {isEmpty ? (
        <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">
          {labels.empty}
        </div>
      ) : null}

      {activePoint ? (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
          style={{
            left: tooltipLeft,
            transform: "translateX(-50%)",
            width: TOOLTIP_WIDTH,
          }}
        >
          <div className="mb-1.5 font-medium">
            {formatX(activePoint.start, "full")}
            <span className="ms-1 font-normal text-muted-foreground">
              {labels.timeZone}
            </span>
          </div>
          <ul className="flex flex-col gap-1">
            {series.map((item, seriesIndex) => (
              <li
                className="flex items-center justify-between gap-3"
                key={seriesIndex}
              >
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    aria-hidden="true"
                    className="inline-block h-0.5 w-3 rounded-full"
                    style={{ backgroundColor: item.color }}
                  />
                  {item.label}
                </span>
                <span className="font-medium tabular-nums">
                  {formatValue(activePoint.values[seriesIndex] ?? 0)}
                </span>
              </li>
            ))}
            <li className="flex items-center justify-between gap-3 border-t pt-1">
              <span className="text-muted-foreground">{labels.total}</span>
              <span className="font-semibold tabular-nums">
                {formatValue(activeTotal)}
              </span>
            </li>
          </ul>
        </div>
      ) : null}

      {/* Active bucket, announced as it changes. */}
      <div aria-live="polite" className="sr-only">
        {announcement}
      </div>

      {/* Full data for screen readers. */}
      <table className="sr-only">
        <caption>{labels.chart}</caption>
        <thead>
          <tr>
            <th scope="col">
              {labels.time} ({labels.timeZone})
            </th>
            {series.map((item, seriesIndex) => (
              <th key={seriesIndex} scope="col">
                {item.label}
              </th>
            ))}
            <th scope="col">{labels.total}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((point, pointIndex) => (
            <tr key={point.start}>
              <th scope="row">{formatX(point.start, "full")}</th>
              {series.map((_, seriesIndex) => (
                <td key={seriesIndex}>
                  {formatValue(point.values[seriesIndex] ?? 0)}
                </td>
              ))}
              <td>{formatValue(totals[pointIndex] ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
