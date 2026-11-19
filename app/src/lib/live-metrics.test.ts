import { describe, expect, it } from "vitest";

import {
  appendLiveSample,
  LIVE_METRIC_WINDOW,
  liveSampleFromV1,
  liveSampleFromV2,
  liveSampleRow,
  type LiveMetricSample,
} from "./live-metrics";

function sample(overrides: Partial<LiveMetricSample> = {}): LiveMetricSample {
  return {
    sampledAtMs: 1_000,
    environment: "systemd",
    scope: "host",
    scopeKey: "systemd|-|-|-|eth0",
    cpuPercent: 10,
    memoryUsedBytes: 512,
    memoryTotalBytes: 1024,
    diskUsedBytes: 100,
    diskTotalBytes: 1000,
    networkTxBytesPerSecond: 1024,
    networkRxBytesPerSecond: 2048,
    ...overrides,
  };
}

describe("live metrics", () => {
  it("maps a v2 sample with its agent scope key and counter rates", () => {
    const mapped = liveSampleFromV2({
      purpose: "live",
      sampledAt: "2026-11-19T00:00:00.000Z",
      cpuPercent: 42,
      memory: { used: 512, total: 1024 },
      disk: null,
      environment: "docker",
      networkScope: "agent",
      cgroupVersion: 2,
      cpuLimit: 2,
      memoryLimit: 1024,
      scopeKey: "docker|cg2|cpu2|mem1024|eth0",
      network: {
        txBytesPerSecond: 100,
        rxBytesPerSecond: 200,
        windowMs: 2000,
      },
    });
    expect(mapped).toMatchObject({
      scope: "container",
      scopeKey: "docker|cg2|cpu2|mem1024|eth0",
      cpuPercent: 42,
      networkTxBytesPerSecond: 100,
      networkRxBytesPerSecond: 200,
    });
    expect(liveSampleRow(mapped)).toMatchObject({
      memoryPercent: 50,
      diskPercent: null,
    });
  });

  it("maps v1 without inventing network rates and computes its scope key", () => {
    const mapped = liveSampleFromV1(
      {
        requestId: "request-1",
        cpuPercent: 5,
        memory: { used: 1, total: 2 },
        disk: null,
        environment: "systemd",
        networkScope: "agent",
        cgroupVersion: null,
        cpuLimit: null,
        memoryLimit: null,
      },
      1_234,
    );
    expect(mapped).toMatchObject({
      sampledAtMs: 1_234,
      scopeKey: "systemd|-|-|-",
      networkTxBytesPerSecond: null,
      networkRxBytesPerSecond: null,
    });
  });

  it("bounds the browser window without dropping older gaps early", () => {
    let samples: LiveMetricSample[] = [];
    for (let index = 0; index < LIVE_METRIC_WINDOW + 5; index += 1) {
      samples = appendLiveSample(samples, sample({ sampledAtMs: index }));
    }
    expect(samples).toHaveLength(LIVE_METRIC_WINDOW);
    expect(samples[0]!.sampledAtMs).toBe(5);
    expect(samples.at(-1)!.sampledAtMs).toBe(LIVE_METRIC_WINDOW + 4);
  });
});
