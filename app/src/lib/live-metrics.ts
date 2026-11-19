import type { AgentWsTelemetrySamplePayload } from "@blossom/contracts/agent-ws";
import type { AgentWsV2TelemetrySamplePayload } from "@blossom/contracts/agent-ws-v2";

import {
  type MetricHistoryRow,
  metricScopeKey,
  metricScopeOf,
  type ServerMetricScopeLabel,
} from "./server-metric-history";

/**
 * Live samples are bounded in the browser, never stored as rows. The window
 * holds four minutes at the two-second sampling interval; a reconnect or a
 * scope change is drawn as a gap by the same segment splitter as history.
 */
export const LIVE_METRIC_WINDOW = 120;
export const LIVE_METRIC_INTERVAL_MS = 2_000;

export interface LiveMetricSample {
  sampledAtMs: number;
  environment:
    | "systemd"
    | "docker"
    | "containerd"
    | "kubernetes"
    | "container"
    | "unknown";
  scope: ServerMetricScopeLabel;
  scopeKey: string;
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  networkTxBytesPerSecond: number | null;
  networkRxBytesPerSecond: number | null;
}

function validPercent(value: number | null): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function usagePercent(
  used: number | null,
  total: number | null,
): number | null {
  if (used === null || total === null || total <= 0 || used > total) {
    return null;
  }
  return (100 * used) / total;
}

/** Maps a v1 sample to the live view without inventing network rates. */
export function liveSampleFromV1(
  sample: AgentWsTelemetrySamplePayload,
  receivedAtMs: number,
): LiveMetricSample {
  return {
    sampledAtMs: receivedAtMs,
    environment: sample.environment,
    scope: metricScopeOf(sample.environment),
    scopeKey: metricScopeKey(sample),
    cpuPercent: validPercent(sample.cpuPercent),
    memoryUsedBytes: sample.memory?.used ?? null,
    memoryTotalBytes: sample.memory?.total ?? null,
    diskUsedBytes: sample.disk?.used ?? null,
    diskTotalBytes: sample.disk?.total ?? null,
    networkTxBytesPerSecond: null,
    networkRxBytesPerSecond: null,
  };
}

/** Maps a v2 sample, whose `scopeKey` already carries the network identity. */
export function liveSampleFromV2(
  sample: AgentWsV2TelemetrySamplePayload,
): LiveMetricSample {
  const tx = sample.network?.txBytesPerSecond ?? null;
  const rx = sample.network?.rxBytesPerSecond ?? null;
  return {
    sampledAtMs: Date.parse(sample.sampledAt),
    environment: sample.environment,
    scope: metricScopeOf(sample.environment),
    scopeKey: sample.scopeKey,
    cpuPercent: validPercent(sample.cpuPercent),
    memoryUsedBytes: sample.memory?.used ?? null,
    memoryTotalBytes: sample.memory?.total ?? null,
    diskUsedBytes: sample.disk?.used ?? null,
    diskTotalBytes: sample.disk?.total ?? null,
    networkTxBytesPerSecond: tx === null ? null : validPercentOrNull(tx),
    networkRxBytesPerSecond: rx === null ? null : validPercentOrNull(rx),
  };
}

function validPercentOrNull(value: number): number | null {
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Converts a live sample to one chart bucket without fabricating history. */
export function liveSampleRow(sample: LiveMetricSample): MetricHistoryRow {
  return {
    startMs: sample.sampledAtMs,
    samples: 1,
    scope: sample.scope,
    scopeKey: sample.scopeKey,
    cpuPercent: sample.cpuPercent,
    memoryPercent: usagePercent(
      sample.memoryUsedBytes,
      sample.memoryTotalBytes,
    ),
    diskPercent: usagePercent(sample.diskUsedBytes, sample.diskTotalBytes),
    networkTxBytesPerSecond: sample.networkTxBytesPerSecond,
    networkRxBytesPerSecond: sample.networkRxBytesPerSecond,
  };
}

/** Appends a sample and trims the browser window. */
export function appendLiveSample(
  current: readonly LiveMetricSample[],
  sample: LiveMetricSample,
): LiveMetricSample[] {
  const next = [...current, sample];
  return next.length > LIVE_METRIC_WINDOW
    ? next.slice(next.length - LIVE_METRIC_WINDOW)
    : next;
}
