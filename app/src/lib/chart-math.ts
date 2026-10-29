/** Pure geometry for the dependency-free SVG charts. */

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Linear map from `domain` to `range`; a zero-width domain maps to `range[0]`. */
export function scaleLinear(
  domain: readonly [number, number],
  range: readonly [number, number],
): (value: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  const span = d1 - d0;
  return (value) => (span === 0 ? r0 : r0 + ((value - d0) / span) * (r1 - r0));
}

export interface StackedSegment {
  /** Lower edge of the segment (sum of the series below). */
  y0: number;
  /** Upper edge of the segment. */
  y1: number;
}

/**
 * Stacks series on top of each other. `values[s][i]` is series `s` at point
 * `i`; the result has the same shape, series 0 at the bottom. Negative and
 * non-finite values count as zero.
 */
export function stackSeries(
  values: readonly (readonly number[])[],
): StackedSegment[][] {
  const length = Math.max(0, ...values.map((series) => series.length));
  const running = Array.from({ length }, () => 0);
  return values.map((series) =>
    Array.from({ length }, (_, index) => {
      const raw = series[index] ?? 0;
      const value = Number.isFinite(raw) && raw > 0 ? raw : 0;
      const y0 = running[index] ?? 0;
      running[index] = y0 + value;
      return { y0, y1: y0 + value };
    }),
  );
}

export interface ByteTicks {
  /** Tick values in bytes, starting at 0 and ending at `max`. */
  ticks: number[];
  /** Top of the axis: the last tick, always >= the data maximum. */
  max: number;
}

/** Rounds a raw step mantissa (1..10) to 1, 2, 5 or 10, nearest-ish. */
function niceFactor(normalized: number): number {
  if (normalized < 1.5) return 1;
  if (normalized < 3) return 2;
  if (normalized < 7) return 5;
  return 10;
}

/**
 * Axis ticks for byte values. Steps are "nice" (1, 2, 5 x 10^k) in the 1024
 * unit (KB, MB, GB, ...) that fits the data, so labels read 0, 1 GB, 2 GB
 * rather than 0, 0.93 GB. About `target` intervals.
 */
export function niceByteTicks(maxBytes: number, target = 4): ByteTicks {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    return { ticks: [0, 1024], max: 1024 };
  }
  const exponent = Math.min(
    5,
    Math.max(0, Math.floor(Math.log(maxBytes) / Math.log(1024))),
  );
  const unit = 1024 ** exponent;
  const raw = maxBytes / unit / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const factor = niceFactor(normalized);
  // Bytes are whole numbers: never go below a step of 1 byte.
  const step = Math.max(1, factor * magnitude * unit);
  const intervals = Math.max(1, Math.ceil(maxBytes / step - 1e-9));
  const ticks = Array.from({ length: intervals + 1 }, (_, index) =>
    Math.round(index * step),
  );
  return { ticks, max: ticks[ticks.length - 1] ?? step };
}

/**
 * Index of the equal-width band under `x`, for a plot starting at `left` and
 * `width` wide with `count` bands; null outside the plot or without bands.
 */
export function bandIndexAt(
  x: number,
  left: number,
  width: number,
  count: number,
): number | null {
  if (count <= 0 || width <= 0 || x < left || x > left + width) return null;
  return Math.min(count - 1, Math.floor(((x - left) / width) * count));
}

/** Every `step`-th index so labels are at least `minSpacing` px apart. */
export function labelIndices(
  count: number,
  bandWidth: number,
  minSpacing: number,
): number[] {
  if (count <= 0) return [];
  const step = Math.max(1, Math.ceil(minSpacing / Math.max(bandWidth, 1)));
  const indices: number[] = [];
  for (let index = 0; index < count; index += step) indices.push(index);
  return indices;
}
