import { z } from "zod";

export const ADMIN_METRICS_STATES = [
  "connected",
  "fallback",
  "legacy",
  "disabled",
  "unavailable",
] as const;

export type AdminMetricsState = (typeof ADMIN_METRICS_STATES)[number];

const liveMetricSampleSchema = z.object({
  sampledAtMs: z.number().int().nonnegative(),
  environment: z.enum([
    "systemd",
    "docker",
    "containerd",
    "kubernetes",
    "container",
    "unknown",
  ]),
  scope: z.enum(["host", "container"]),
  scopeKey: z.string().min(1).max(256),
  cpuPercent: z.number().nullable(),
  memoryUsedBytes: z.number().int().nonnegative().nullable(),
  memoryTotalBytes: z.number().int().nonnegative().nullable(),
  diskUsedBytes: z.number().int().nonnegative().nullable(),
  diskTotalBytes: z.number().int().nonnegative().nullable(),
  networkTxBytesPerSecond: z.number().nonnegative().nullable(),
  networkRxBytesPerSecond: z.number().nonnegative().nullable(),
});

export const adminMetricsServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("state"),
    state: z.literal("connected"),
    protocol: z.enum(["v1", "v2"]),
    connectedAt: z.iso.datetime(),
  }),
  z.object({
    type: z.literal("sample"),
    sample: liveMetricSampleSchema,
  }),
  z.object({
    type: z.literal("snapshot"),
    requestId: z.string().min(1),
    snapshot: z.unknown(),
  }),
  z.object({
    type: z.literal("error"),
    code: z.enum([
      "disabled",
      "offline",
      "legacy",
      "unsupported",
      "unauthorized",
      "agent_replaced",
      "unavailable",
    ]),
    message: z.string().min(1).max(1024),
  }),
]);

export type AdminMetricsServerMessage = z.infer<
  typeof adminMetricsServerMessageSchema
>;

export const adminMetricsClientMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("inspect"),
    requestId: z.string().min(1).max(128),
  }),
]);

export type AdminMetricsClientMessage = z.infer<
  typeof adminMetricsClientMessageSchema
>;
