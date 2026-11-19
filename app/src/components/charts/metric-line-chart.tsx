import type React from "react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

import { bandIndexAt, clamp, scaleLinear } from "@/lib/chart-math";
import {
  type MetricHistoryRow,
  splitMetricSegments,
} from "@/lib/server-metric-history";

export interface MetricLineSeries {
  label: string;
  /** Any CSS color; pass a theme variable, e.g. `var(--chart-up)`. */
  color: string;
  value: (point: MetricHistoryRow) => number | null;
}

export interface MetricLineAxis {
  /** Grid values, starting at 0 and ending at `max`. */
  ticks: readonly number[];
  max: number;
}

export interface MetricLineChartLabels {
  /** Accessible name of the chart. */
  chart: string;
  /** Keyboard instructions, announced when the chart is focused. */
  hint: string;
  time: string;
  timeZone: string;
  /** Shown over the plot when no bucket in the range has a value. */
  empty: string;
  /** Value of a bucket without a sample for that series. */
  missing: string;
  scopeChanged: string;
}

export interface MetricLineChartProps {
  points: readonly MetricHistoryRow[];
  series: readonly MetricLineSeries[];
  axis: MetricLineAxis;
  labels: MetricLineChartLabels;
  /** Compact x-axis label and a longer one for tooltip / table. */
  formatX: (start: number, kind: "axis" | "full") => string;
  formatValue: (value: number) => string;
  /** Plot height in px, including the x-axis band (default 176). */
  height?: number;
  className?: string;
}

const MARGIN = { top: 8, right: 8, bottom: 24, left: 56 } as const;
const TOOLTIP_WIDTH = 188;
const MIN_LABEL_SPACING = 72;
const DEFAULT_WIDTH = 640;

/**
 * Dependency-free line chart over fixed time buckets. A series breaks where a
 * bucket has no value (a gap) and where the measurement scope changes, so the
 * line never bridges missing data or joins two different denominators.
 *
 * - Responsive: width follows the container (`ResizeObserver`).
 * - Themed: series colors are passed in as theme tokens.
 * - Hover and keyboard: pointer position or Left/Right/Home/End on the focused
 *   chart selects a bucket and shows a tooltip; Escape clears it. The selected
 *   bucket is also announced through a polite live region.
 * - Screen readers get a visually hidden table with every bucket, including
 *   the buckets without data.
 */
export function MetricLineChart({
  points,
  series,
  axis,
  labels,
  formatX,
  formatValue,
  height = 176,
  className,
}: MetricLineChartProps): React.ReactElement {
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

  const plotWidth = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const y = scaleLinear([0, axis.max], [MARGIN.top + plotHeight, MARGIN.top]);
  const count = points.length;
  const band = count > 0 ? plotWidth / count : plotWidth;
  const xOf = (index: number) => MARGIN.left + band * index + band / 2;
  // Every `labelStep`-th bucket is labelled. Computed here rather than with
  // `labelIndices`, which clamps the band to 1px and under-spaces long ranges.
  const labelStep = Math.max(1, Math.ceil(MIN_LABEL_SPACING / band));
  const xLabels = Array.from(
    { length: Math.ceil(count / labelStep) },
    (_, step) => step * labelStep,
  );

  const runs = useMemo(
    () => series.map((item) => splitMetricSegments(points, item.value)),
    [points, series],
  );
  const hasValue = runs.some((segments) => segments.length > 0);

  const select = useCallback((next: number | null) => setActive(next), []);

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    select(
      bandIndexAt(event.clientX - rect.left, MARGIN.left, plotWidth, count),
    );
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
  const previousPoint = active ? points[active - 1] : undefined;
  const scopeChanged =
    activePoint !== undefined &&
    previousPoint !== undefined &&
    activePoint.samples > 0 &&
    previousPoint.samples > 0 &&
    activePoint.scopeKey !== previousPoint.scopeKey;
  const tooltipLeft = clamp(
    active === null ? 0 : xOf(active),
    TOOLTIP_WIDTH / 2,
    Math.max(TOOLTIP_WIDTH / 2, width - TOOLTIP_WIDTH / 2),
  );
  const valueText = (value: number | null) =>
    value === null ? labels.missing : formatValue(value);
  const announcement = activePoint
    ? [
        formatX(activePoint.startMs, "full"),
        ...series.map(
          (item) => `${item.label} ${valueText(item.value(activePoint))}`,
        ),
        ...(scopeChanged ? [labels.scopeChanged] : []),
      ].join(", ")
    : "";

  return (
    <div className={className}>
      {series.length > 1 ? (
        <ul className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.map((item) => (
            <li className="flex items-center gap-1.5" key={item.label}>
              <span
                aria-hidden="true"
                className="inline-block h-0.5 w-3 rounded-full"
                style={{ backgroundColor: item.color }}
              />
              {item.label}
            </li>
          ))}
        </ul>
      ) : null}
      <div
        aria-describedby={`${id}-hint`}
        aria-label={labels.chart}
        className="relative w-full touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-slot="metric-line-chart"
        ref={containerRef}
        role="group"
        style={{ height }}
        tabIndex={0}
        onBlur={() => select(null)}
        onFocus={(event) => {
          // Keyboard focus starts on the newest bucket; clicks keep hover control.
          if (
            active === null &&
            event.currentTarget.matches(":focus-visible")
          ) {
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
          {axis.ticks.map((tick) => (
            <g key={tick}>
              <line
                stroke="var(--border)"
                x1={MARGIN.left}
                x2={MARGIN.left + plotWidth}
                y1={y(tick)}
                y2={y(tick)}
              />
              <text
                dominantBaseline="middle"
                fill="var(--muted-foreground)"
                fontSize={11}
                textAnchor="end"
                x={MARGIN.left - 8}
                y={y(tick)}
              >
                {tick === 0 ? "0" : formatValue(tick)}
              </text>
            </g>
          ))}

          {active === null ? null : (
            <line
              stroke="var(--muted-foreground)"
              x1={xOf(active)}
              x2={xOf(active)}
              y1={MARGIN.top}
              y2={MARGIN.top + plotHeight}
            />
          )}

          {runs.map((segments, seriesIndex) => {
            const color = series[seriesIndex]?.color ?? "currentColor";
            return segments.map((segment, segmentIndex) => {
              const key = `${seriesIndex}-${segmentIndex}`;
              const [only] = segment.points;
              if (segment.points.length === 1 && only) {
                return (
                  <circle
                    cx={xOf(only.index)}
                    cy={y(only.value)}
                    fill={color}
                    key={key}
                    r={2.5}
                  />
                );
              }
              const d = segment.points
                .map(
                  (p, i) =>
                    `${i === 0 ? "M" : "L"}${xOf(p.index).toFixed(1)} ${y(p.value).toFixed(1)}`,
                )
                .join(" ");
              return (
                <path
                  d={d}
                  fill="none"
                  key={key}
                  stroke={color}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                />
              );
            });
          })}

          <line
            stroke="var(--border)"
            x1={MARGIN.left}
            x2={MARGIN.left + plotWidth}
            y1={MARGIN.top + plotHeight}
            y2={MARGIN.top + plotHeight}
          />
          {xLabels.map((index) => {
            const point = points[index];
            if (!point) return null;
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
                key={point.startMs}
                textAnchor={anchor}
                x={
                  MARGIN.left +
                  band * index +
                  (anchor === "start" ? 0 : anchor === "end" ? band : band / 2)
                }
                y={height - 6}
              >
                {formatX(point.startMs, "axis")}
              </text>
            );
          })}
        </svg>

        {hasValue ? null : (
          <div className="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-sm text-muted-foreground">
            {labels.empty}
          </div>
        )}

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
              {formatX(activePoint.startMs, "full")}
              <span className="ms-1 font-normal text-muted-foreground">
                {labels.timeZone}
              </span>
            </div>
            <ul className="flex flex-col gap-1">
              {series.map((item) => (
                <li
                  className="flex items-center justify-between gap-3"
                  key={item.label}
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
                    {valueText(item.value(activePoint))}
                  </span>
                </li>
              ))}
            </ul>
            {scopeChanged ? (
              <p className="mt-1.5 text-muted-foreground">
                {labels.scopeChanged}
              </p>
            ) : null}
          </div>
        ) : null}

        <div aria-live="polite" className="sr-only">
          {announcement}
        </div>

        <div className="sr-only">
          <table>
            <caption>{labels.chart}</caption>
            <thead>
              <tr>
                <th scope="col">
                  {labels.time} ({labels.timeZone})
                </th>
                {series.map((item) => (
                  <th key={item.label} scope="col">
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.startMs}>
                  <th scope="row">{formatX(point.startMs, "full")}</th>
                  {series.map((item) => (
                    <td key={item.label}>{valueText(item.value(point))}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
