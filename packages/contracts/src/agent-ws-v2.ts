import { z } from "zod";

import {
  agentWsAcmeDnsAckPayloadSchema,
  agentWsAcmeDnsCleanupPayloadSchema,
  agentWsAcmeDnsPresentPayloadSchema,
  agentWsAcmeIssuePayloadSchema,
  agentWsAcmeResultPayloadSchema,
  agentWsPtyClosePayloadSchema,
  agentWsPtyDataPayloadSchema,
  agentWsPtyExitPayloadSchema,
  agentWsPtyOpenPayloadSchema,
  agentWsPtyResizePayloadSchema,
  agentWsPtyStartedPayloadSchema,
  agentWsTelemetrySnapshotPayloadSchema,
  agentWsUpdateStatusesSchema,
  agentWsUpdateTriggerPayloadSchema,
  certificateDeploymentSchema,
} from "./agent-ws";
import {
  AGENT_WS_V2_LOGS_AGENT_MESSAGE_TYPES,
  AGENT_WS_V2_LOGS_CONTROL_MESSAGE_TYPES,
  agentWsV2LogsPayloadSchemas,
} from "./agent-ws-v2-logs";
import {
  logPolicyAckPayloadSchema,
  logPolicyGetPayloadSchema,
  logPolicyNotifyPayloadSchema,
  logPolicySnapshotPayloadSchema,
} from "./log-policy";

/**
 * Agent WebSocket protocol v2: WebSocket-first desired-state sync, status, and
 * traffic. It reuses the `/api/agent/ws` route and the existing hubs; v1 frames
 * (`agent-ws.ts`) are untouched and remain the default for clients that do not
 * offer the subprotocol below.
 *
 * Negotiation: the client offers {@link AGENT_WS_V2_SUBPROTOCOL} in
 * `Sec-WebSocket-Protocol`. The control plane echoes it on the upgrade response.
 * A client that offers no subprotocol speaks v1. A client that offers only
 * unknown subprotocols is rejected before the upgrade.
 *
 * Every v2 frame uses the envelope `{ v: 2, id?, type, ts, payload }`. Frames
 * are validated per direction: a receiver rejects a known type sent in the
 * wrong direction. Unknown types are ignored for forward compatibility.
 *
 * Wire fixtures for the Rust implementer live in
 * `packages/contracts/fixtures/agent-ws-v2.frames.json`; the test next to this
 * file checks every fixture against these schemas.
 */
export const AGENT_WS_V2_PROTOCOL_VERSION = 2 as const;

export const AGENT_WS_V2_SUBPROTOCOL = "blossom-agent.v2" as const;

/**
 * A v2 agent advertises this instead of `pty-v1` when local PTY sessions are
 * enabled. The admin relay selects the frame envelope from this capability,
 * so an older control plane never sends v1 `pty.*` frames to a v2 socket.
 */
export const AGENT_WS_V2_PTY_CAPABILITY = "pty-v2" as const;

/**
 * Telemetry capabilities are separate so an agent can enable live samples
 * before it implements the independent 60-second history cadence. A v2 agent
 * that advertises neither receives no telemetry subscriptions.
 */
export const AGENT_WS_V2_TELEMETRY_CAPABILITY = "telemetry-v2" as const;
export const AGENT_WS_V2_TELEMETRY_HISTORY_CAPABILITY =
  "telemetry-history-v2" as const;

/**
 * Bounds enforced on both sides. `maxSnapshotBytes` is a provisional aggregate
 * limit: raise it only after measuring real configuration sizes (including
 * certificate artifacts) on each deploy target. Each chunk stays far below the
 * per-frame limit so one snapshot never occupies a socket for one huge message.
 */
export const AGENT_WS_V2_LIMITS = {
  maxFrameBytes: 4 * 1024 * 1024,
  snapshotChunkBytes: 64 * 1024,
  maxSnapshotBytes: 8 * 1024 * 1024,
} as const;

export const AGENT_WS_V2_MAX_SNAPSHOT_CHUNKS =
  AGENT_WS_V2_LIMITS.maxSnapshotBytes / AGENT_WS_V2_LIMITS.snapshotChunkBytes;

export const AGENT_WS_V2_CHUNK_BASE64_LENGTH =
  Math.ceil(AGENT_WS_V2_LIMITS.snapshotChunkBytes / 3) * 4;

export type AgentWsNegotiation =
  | { protocol: "v1" }
  | { protocol: "v2" }
  | { protocol: "unsupported"; offered: string[] };

/**
 * Chooses the wire protocol from the client's `Sec-WebSocket-Protocol` offer.
 * A missing or empty header means v1, which is the compatibility default.
 */
export function negotiateAgentWsProtocol(
  header: string | null | undefined,
): AgentWsNegotiation {
  const offered = (header ?? "")
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (offered.length === 0) {
    return { protocol: "v1" };
  }
  if (offered.includes(AGENT_WS_V2_SUBPROTOCOL)) {
    return { protocol: "v2" };
  }
  return { protocol: "unsupported", offered };
}

export const AGENT_WS_V2_AGENT_MESSAGE_TYPES = [
  "hello",
  "agent.status",
  "config.get",
  "config.ack",
  "traffic.report",
  "update.status",
  "acme.dns_present",
  "acme.dns_cleanup",
  "acme.result",
  "pty.started",
  "pty.data",
  "pty.exit",
  "log.policy.get",
  "log.policy.ack",
  ...AGENT_WS_V2_LOGS_AGENT_MESSAGE_TYPES,
  "telemetry.sample",
  "telemetry.snapshot",
] as const;

export const AGENT_WS_V2_CONTROL_MESSAGE_TYPES = [
  "welcome",
  "agent.status.ack",
  "config.notify",
  "config.snapshot.begin",
  "config.snapshot.chunk",
  "config.snapshot.end",
  "config.snapshot.error",
  "traffic.ack",
  "log.policy.notify",
  "log.policy.snapshot",
  "telemetry.subscribe",
  "telemetry.unsubscribe",
  "telemetry.inspect",
  "error",
  "update.trigger",
  "acme.issue",
  "acme.dns_ack",
  "pty.open",
  "pty.data",
  "pty.resize",
  "pty.close",
  ...AGENT_WS_V2_LOGS_CONTROL_MESSAGE_TYPES,
] as const;

/**
 * Terminal bytes flow both ways under the same frame type. Every other type
 * has exactly one sender; direction validation still applies to those.
 */
export const AGENT_WS_V2_BIDIRECTIONAL_MESSAGE_TYPES = ["pty.data"] as const;

export type AgentWsV2BidirectionalMessageType =
  (typeof AGENT_WS_V2_BIDIRECTIONAL_MESSAGE_TYPES)[number];

export type AgentWsV2AgentMessageType =
  (typeof AGENT_WS_V2_AGENT_MESSAGE_TYPES)[number];
export type AgentWsV2ControlMessageType =
  (typeof AGENT_WS_V2_CONTROL_MESSAGE_TYPES)[number];
export type AgentWsV2MessageType =
  | AgentWsV2AgentMessageType
  | AgentWsV2ControlMessageType;

const correlationIdSchema = z.string().min(1).max(128);
const timestampSchema = z.iso.datetime();
const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const agentWsV2EnvelopeSchema = z.object({
  v: z.literal(AGENT_WS_V2_PROTOCOL_VERSION),
  id: correlationIdSchema.optional(),
  type: z.string().min(1).max(128),
  ts: timestampSchema,
  payload: z.unknown(),
});

export type AgentWsV2Frame = z.infer<typeof agentWsV2EnvelopeSchema>;

/**
 * The configuration identifier: the publish-gate sequence plus the full
 * content digest, formatted as `"<seq>:sha256:<hex>"`. The prefix must match the
 * sequence, so a mismatch is a malformed frame rather than a silent drift.
 */
export const agentWsV2ConfigIdentifierSchema = z
  .object({
    desiredRevisionSeq: z.number().int().min(0),
    desiredRevision: z.string().min(1).max(256),
  })
  .refine(
    ({ desiredRevisionSeq, desiredRevision }) =>
      desiredRevision.startsWith(`${desiredRevisionSeq}:`),
    { message: "desiredRevision must begin with desiredRevisionSeq" },
  );

export type AgentWsV2ConfigIdentifier = z.infer<
  typeof agentWsV2ConfigIdentifierSchema
>;

/**
 * Update policy travels separately from the configuration identifier, so a
 * version-target edit reaches the agent without a configuration transfer.
 */
export const agentWsV2UpdatePolicySchema = z.object({
  desiredAgentVersion: z.string().min(1).max(64).nullable(),
  desiredSingBoxVersion: z.string().min(1).max(64).nullable(),
});

export type AgentWsV2UpdatePolicy = z.infer<typeof agentWsV2UpdatePolicySchema>;

/**
 * `hello` (agent -> control plane). Sent first on every connection. `applied`
 * is what the agent last applied from its durable cache, or null when that
 * cache is empty (a fresh installation waiting for its first configuration).
 */
export const agentWsV2HelloPayloadSchema = z.object({
  agentVersion: z.string().min(1).max(128),
  agentBuildId: z.string().min(1).max(256),
  capabilities: z.array(z.string().min(1).max(128)).max(1024).default([]),
  applied: agentWsV2ConfigIdentifierSchema.nullable(),
  certificateDeployments: z
    .array(certificateDeploymentSchema)
    .max(10_000)
    .default([]),
  updates: agentWsUpdateStatusesSchema.optional(),
});

export type AgentWsV2HelloPayload = z.infer<typeof agentWsV2HelloPayloadSchema>;

/**
 * `welcome` (control plane -> agent). Sent once per session, in reply to
 * `hello`. `sessionId` identifies the session the control plane has just made
 * current; every later write from the agent is fenced by it.
 */
export const agentWsV2WelcomePayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
  serverId: z.string().min(1),
  serverName: z.string().min(1).max(128),
  desired: agentWsV2ConfigIdentifierSchema,
  updatePolicy: agentWsV2UpdatePolicySchema,
  statusIntervalSeconds: z.number().int().min(1).max(3_600),
  reconnectBeforeSeconds: z.number().int().min(1).max(800).optional(),
  /**
   * Server-wide log-policy revision. Present only when the agent advertised
   * `log-policy-v1`; a mismatch means the agent must send `log.policy.get`.
   */
  logPolicyRevision: z.number().int().min(0).optional(),
  /** Advertised so the agent enforces the control plane's current bounds. */
  limits: z.object({
    maxFrameBytes: z.number().int().min(1),
    snapshotChunkBytes: z.number().int().min(1),
    maxSnapshotBytes: z.number().int().min(1),
  }),
});

export type AgentWsV2WelcomePayload = z.infer<
  typeof agentWsV2WelcomePayloadSchema
>;

export const agentWsV2StatusPayloadSchema = z.object({
  reason: z.enum(["interval", "change"]).default("interval"),
  runtimeState: z
    .enum(["unknown", "starting", "running", "stopped", "crash_loop"])
    .optional(),
  configState: z
    .enum(["unknown", "applied", "rejected", "apply_failed"])
    .optional(),
  singBoxVersion: z.string().min(1).max(128).optional(),
  activeNodeIds: z.array(z.string().min(1)).max(10_000).optional(),
  /** `null` clears the last reported error; omit to leave it unchanged. */
  error: z
    .object({
      phase: z.string().min(1).max(64),
      code: z.string().min(1).max(128),
      message: z.string().min(1).max(16_384),
      nodeId: z.string().min(1).optional(),
      occurredAt: timestampSchema.optional(),
    })
    .nullable()
    .optional(),
  certificateDeployments: z
    .array(certificateDeploymentSchema)
    .max(10_000)
    .default([]),
  updates: agentWsUpdateStatusesSchema.optional(),
});

export type AgentWsV2StatusPayload = z.infer<
  typeof agentWsV2StatusPayloadSchema
>;

/**
 * `agent.status.ack` (control plane -> agent). Carries the authoritative
 * identifiers so a missed `config.notify` is recovered at the next status
 * exchange, not only by a reconnect.
 */
export const agentWsV2StatusAckPayloadSchema = z.object({
  desired: agentWsV2ConfigIdentifierSchema,
  updatePolicy: agentWsV2UpdatePolicySchema,
  logPolicyRevision: z.number().int().min(0).optional(),
});

export type AgentWsV2StatusAckPayload = z.infer<
  typeof agentWsV2StatusAckPayloadSchema
>;

/** `config.notify` (control plane -> agent). A hint; the agent verifies. */
export const agentWsV2ConfigNotifyPayloadSchema = z.object({
  desired: agentWsV2ConfigIdentifierSchema,
  reason: z.string().min(1).max(256).optional(),
});

export type AgentWsV2ConfigNotifyPayload = z.infer<
  typeof agentWsV2ConfigNotifyPayloadSchema
>;

/** `config.get` (agent -> control plane). A newer request supersedes older ones. */
export const agentWsV2ConfigGetPayloadSchema = z.object({
  requestId: correlationIdSchema,
  reason: z.enum(["initial", "mismatch", "notify"]),
});

export type AgentWsV2ConfigGetPayload = z.infer<
  typeof agentWsV2ConfigGetPayloadSchema
>;

/**
 * `config.snapshot.begin` (control plane -> agent). Identifies the version
 * actually compiled, which may differ from the notified one if the desired
 * state moved on. The agent validates the full body against `digest` before
 * it applies anything.
 */
export const agentWsV2SnapshotBeginPayloadSchema = z
  .object({
    requestId: correlationIdSchema,
    desired: agentWsV2ConfigIdentifierSchema,
    contentType: z.literal("application/json"),
    totalBytes: z
      .number()
      .int()
      .min(1)
      .max(AGENT_WS_V2_LIMITS.maxSnapshotBytes),
    chunkCount: z.number().int().min(1).max(AGENT_WS_V2_MAX_SNAPSHOT_CHUNKS),
    /** Lowercase hex SHA-256 of the complete body bytes. */
    digest: sha256HexSchema,
  })
  .refine(
    ({ totalBytes, chunkCount }) =>
      chunkCount ===
      Math.ceil(totalBytes / AGENT_WS_V2_LIMITS.snapshotChunkBytes),
    { message: "chunkCount must match totalBytes and snapshotChunkBytes" },
  );

export type AgentWsV2SnapshotBeginPayload = z.infer<
  typeof agentWsV2SnapshotBeginPayloadSchema
>;

/** `config.snapshot.chunk` (control plane -> agent). Chunks arrive in order. */
export const agentWsV2SnapshotChunkPayloadSchema = z.object({
  requestId: correlationIdSchema,
  index: z
    .number()
    .int()
    .min(0)
    .max(AGENT_WS_V2_MAX_SNAPSHOT_CHUNKS - 1),
  /** Standard base64 (RFC 4648 section 4) of the raw chunk bytes. */
  data: z.string().min(1).max(AGENT_WS_V2_CHUNK_BASE64_LENGTH),
});

export type AgentWsV2SnapshotChunkPayload = z.infer<
  typeof agentWsV2SnapshotChunkPayloadSchema
>;

export const agentWsV2SnapshotEndPayloadSchema = z.object({
  requestId: correlationIdSchema,
});

export const agentWsV2SnapshotErrorPayloadSchema = z.object({
  requestId: correlationIdSchema,
  code: z.enum(["snapshot_too_large", "unavailable", "internal"]),
  message: z.string().min(1).max(2048),
});

export type AgentWsV2SnapshotErrorPayload = z.infer<
  typeof agentWsV2SnapshotErrorPayloadSchema
>;

/**
 * `config.ack` (agent -> control plane). `applied` must name the identifier
 * the agent actually applied. A failure names the stage that failed and leaves
 * the applied identifier unchanged.
 */
export const agentWsV2ConfigAckPayloadSchema = z
  .object({
    requestId: correlationIdSchema.optional(),
    desired: agentWsV2ConfigIdentifierSchema,
    outcome: z.enum(["applied", "failed"]),
    stage: z.enum(["receive", "validate", "store", "apply"]).optional(),
    error: z.string().min(1).max(16_384).optional(),
  })
  .superRefine((value, context) => {
    if (value.outcome === "applied") {
      if (value.stage !== undefined || value.error !== undefined) {
        context.addIssue({
          code: "custom",
          message: "an applied config.ack carries no stage or error",
        });
      }
      return;
    }
    if (value.stage === undefined || value.error === undefined) {
      context.addIssue({
        code: "custom",
        message: "a failed config.ack names its stage and error",
      });
    }
  });

export type AgentWsV2ConfigAckPayload = z.infer<
  typeof agentWsV2ConfigAckPayloadSchema
>;

const trafficEntrySchema = z.object({
  subscriptionId: z.string().min(1),
  uplinkBytes: z.number().int().min(0),
  downlinkBytes: z.number().int().min(0),
});

/**
 * `traffic.report` (agent -> control plane). The same entries and dedupe key
 * as the v1 HTTP report. `reportId` is required: a report without one cannot be
 * replayed safely, so v2 never accepts it.
 */
export const agentWsV2TrafficReportPayloadSchema = z.object({
  reportId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9._-]+$/),
  windowStartedAt: timestampSchema.optional(),
  windowEndedAt: timestampSchema.optional(),
  entries: z.array(trafficEntrySchema).max(10_000),
});

export type AgentWsV2TrafficReportPayload = z.infer<
  typeof agentWsV2TrafficReportPayloadSchema
>;

/**
 * `traffic.ack` (control plane -> agent), sent only after the durable write
 * commits. A replay of an applied report returns `duplicate` with the original
 * counts. A conflicting replay is `conflict` and is never applied.
 */
export const agentWsV2TrafficAckPayloadSchema = z.object({
  reportId: z.string().min(8).max(128),
  result: z.enum(["applied", "duplicate", "conflict"]),
  accepted: z.number().int().min(0).optional(),
  dropped: z.number().int().min(0).optional(),
  error: z.string().min(1).max(1024).optional(),
});

export type AgentWsV2TrafficAckPayload = z.infer<
  typeof agentWsV2TrafficAckPayloadSchema
>;

const telemetrySubscriptionIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/);

/**
 * `telemetry.subscribe` (control plane -> agent). A subscription is either a
 * bounded browser-driven live stream or the control plane's independent
 * history cadence. The agent stops sending when it receives
 * `telemetry.unsubscribe`, when the session ends, or after the advertised
 * interval is no longer useful; the control plane only keeps subscriptions it
 * asked for.
 */
export const agentWsV2TelemetrySubscribePayloadSchema = z.object({
  subscriptionId: telemetrySubscriptionIdSchema,
  purpose: z.enum(["live", "history"]),
  /** Sampling interval. History is clamped by the control plane to 60s. */
  intervalMs: z.number().int().min(1_000).max(300_000),
});

export type AgentWsV2TelemetrySubscribePayload = z.infer<
  typeof agentWsV2TelemetrySubscribePayloadSchema
>;

export const agentWsV2TelemetryUnsubscribePayloadSchema = z.object({
  subscriptionId: telemetrySubscriptionIdSchema,
});

export type AgentWsV2TelemetryUnsubscribePayload = z.infer<
  typeof agentWsV2TelemetryUnsubscribePayloadSchema
>;

/** `telemetry.inspect` (control plane -> agent); same snapshot as v1. */
export const agentWsV2TelemetryInspectPayloadSchema = z.object({
  requestId: correlationIdSchema,
});

export type AgentWsV2TelemetryInspectPayload = z.infer<
  typeof agentWsV2TelemetryInspectPayloadSchema
>;

const byteCount = z.number().int().nonnegative();
const usage = z
  .object({ used: byteCount, total: byteCount })
  .refine(({ used, total }) => used <= total);

/**
 * `telemetry.sample` (agent -> control plane). Measurements use the same
 * shape as v1 where possible; v2 adds `scopeKey` and counter-derived network
 * rates.
 *
 * `scopeKey` is the canonical identity of everything that makes the
 * percentages comparable: environment, cgroup version and limits, and the
 * stable network interface set used for rate deltas. It must change when the
 * agent restarts, when the interface set changes, or when the denominator
 * changes. The control plane stores and charts by it, so a changed key starts
 * a new series rather than joining incomparable values.
 *
 * Network rates are null until the agent can read counters. A null
 * `network` object means not collected, which the UI draws as a gap.
 */
export const agentWsV2TelemetrySamplePayloadSchema = z.object({
  subscriptionId: telemetrySubscriptionIdSchema.optional(),
  purpose: z.enum(["live", "history"]),
  sampledAt: timestampSchema,
  cpuPercent: z.number().min(0).max(100).nullable(),
  memory: usage.nullable(),
  disk: usage.nullable(),
  environment: z.enum([
    "systemd",
    "docker",
    "containerd",
    "kubernetes",
    "container",
    "unknown",
  ]),
  networkScope: z.literal("agent"),
  cgroupVersion: z.union([z.literal(1), z.literal(2)]).nullable(),
  cpuLimit: z.number().positive().nullable(),
  memoryLimit: byteCount.nullable(),
  /** Host/container measurement identity; see the comment above. */
  scopeKey: z.string().min(1).max(256),
  network: z
    .object({
      txBytesPerSecond: z.number().finite().nonnegative().nullable(),
      rxBytesPerSecond: z.number().finite().nonnegative().nullable(),
      /** Monotonic elapsed time between the sampled counter reads. */
      windowMs: z.number().int().min(1).max(300_000),
    })
    .nullable(),
});

export type AgentWsV2TelemetrySamplePayload = z.infer<
  typeof agentWsV2TelemetrySamplePayloadSchema
>;

/** `telemetry.snapshot` (agent -> control plane); the v1 inspection payload. */
export const agentWsV2TelemetrySnapshotPayloadSchema =
  agentWsTelemetrySnapshotPayloadSchema;

export type AgentWsV2TelemetrySnapshotPayload = z.infer<
  typeof agentWsV2TelemetrySnapshotPayloadSchema
>;

export const AGENT_WS_V2_ERROR_CODES = [
  "invalid_direction",
  "invalid_payload",
  "frame_too_large",
  "server_disabled",
  "session_replaced",
] as const;

export const agentWsV2ErrorPayloadSchema = z.object({
  code: z.enum(AGENT_WS_V2_ERROR_CODES),
  type: z.string().min(1).max(128).optional(),
  requestId: correlationIdSchema.optional(),
  message: z.string().min(1).max(1024),
});

export type AgentWsV2ErrorPayload = z.infer<typeof agentWsV2ErrorPayloadSchema>;

export const agentWsV2PayloadSchemas = {
  hello: agentWsV2HelloPayloadSchema,
  "agent.status": agentWsV2StatusPayloadSchema,
  "config.get": agentWsV2ConfigGetPayloadSchema,
  "config.ack": agentWsV2ConfigAckPayloadSchema,
  "traffic.report": agentWsV2TrafficReportPayloadSchema,
  "update.status": agentWsUpdateStatusesSchema,
  "update.trigger": agentWsUpdateTriggerPayloadSchema,
  "acme.issue": agentWsAcmeIssuePayloadSchema,
  "acme.dns_present": agentWsAcmeDnsPresentPayloadSchema,
  "acme.dns_cleanup": agentWsAcmeDnsCleanupPayloadSchema,
  "acme.dns_ack": agentWsAcmeDnsAckPayloadSchema,
  "acme.result": agentWsAcmeResultPayloadSchema,
  "pty.open": agentWsPtyOpenPayloadSchema,
  "pty.started": agentWsPtyStartedPayloadSchema,
  "pty.data": agentWsPtyDataPayloadSchema,
  "pty.resize": agentWsPtyResizePayloadSchema,
  "pty.close": agentWsPtyClosePayloadSchema,
  "pty.exit": agentWsPtyExitPayloadSchema,
  welcome: agentWsV2WelcomePayloadSchema,
  "agent.status.ack": agentWsV2StatusAckPayloadSchema,
  "log.policy.get": logPolicyGetPayloadSchema,
  "log.policy.ack": logPolicyAckPayloadSchema,
  "log.policy.notify": logPolicyNotifyPayloadSchema,
  "log.policy.snapshot": logPolicySnapshotPayloadSchema,
  "config.notify": agentWsV2ConfigNotifyPayloadSchema,
  "config.snapshot.begin": agentWsV2SnapshotBeginPayloadSchema,
  "config.snapshot.chunk": agentWsV2SnapshotChunkPayloadSchema,
  "config.snapshot.end": agentWsV2SnapshotEndPayloadSchema,
  "config.snapshot.error": agentWsV2SnapshotErrorPayloadSchema,
  "traffic.ack": agentWsV2TrafficAckPayloadSchema,
  "telemetry.subscribe": agentWsV2TelemetrySubscribePayloadSchema,
  "telemetry.unsubscribe": agentWsV2TelemetryUnsubscribePayloadSchema,
  "telemetry.inspect": agentWsV2TelemetryInspectPayloadSchema,
  "telemetry.sample": agentWsV2TelemetrySamplePayloadSchema,
  "telemetry.snapshot": agentWsV2TelemetrySnapshotPayloadSchema,
  error: agentWsV2ErrorPayloadSchema,
  ...agentWsV2LogsPayloadSchemas,
} as const satisfies Record<AgentWsV2MessageType, z.ZodType>;

export type AgentWsV2PayloadOf<T extends AgentWsV2MessageType> = z.infer<
  (typeof agentWsV2PayloadSchemas)[T]
>;

/** Which side sends a frame; the receiver is the other side. */
export type AgentWsV2Sender = "agent" | "control-plane";

export type AgentWsV2Message =
  | {
      [K in AgentWsV2MessageType]: {
        kind: K;
        payload: AgentWsV2PayloadOf<K>;
      };
    }[AgentWsV2MessageType]
  | { kind: "unknown"; type: string };

export type AgentWsV2ParseErrorCode =
  | "invalid-json"
  | "frame-too-large"
  | "invalid-envelope"
  | "unsupported-version"
  | "invalid-direction"
  | "invalid-payload";

export type AgentWsV2ParseResult =
  | { ok: true; frame: AgentWsV2Frame; message: AgentWsV2Message }
  | { ok: false; code: AgentWsV2ParseErrorCode; type?: string };

function directionOf(type: AgentWsV2MessageType): AgentWsV2Sender {
  return (AGENT_WS_V2_AGENT_MESSAGE_TYPES as readonly string[]).includes(type)
    ? "agent"
    : "control-plane";
}

function isBidirectional(type: AgentWsV2MessageType): boolean {
  return (
    AGENT_WS_V2_BIDIRECTIONAL_MESSAGE_TYPES as readonly string[]
  ).includes(type);
}

function isKnownV2Type(type: string): type is AgentWsV2MessageType {
  return (
    (AGENT_WS_V2_AGENT_MESSAGE_TYPES as readonly string[]).includes(type) ||
    (AGENT_WS_V2_CONTROL_MESSAGE_TYPES as readonly string[]).includes(type)
  );
}

/**
 * Decodes one v2 text frame as received by `sender`'s peer. The sender is the
 * side that produced the frame, so `parseAgentWsV2Frame(text, "agent")` is what
 * the control plane runs on frames from an agent.
 */
export function parseAgentWsV2Frame(
  text: string,
  sender: AgentWsV2Sender,
  options: { maxFrameBytes?: number } = {},
): AgentWsV2ParseResult {
  const maxFrameBytes =
    options.maxFrameBytes ?? AGENT_WS_V2_LIMITS.maxFrameBytes;
  if (new TextEncoder().encode(text).byteLength > maxFrameBytes) {
    return { ok: false, code: "frame-too-large" };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-json" };
  }

  const envelope = agentWsV2EnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const rawVersion =
      typeof raw === "object" && raw !== null && "v" in raw
        ? (raw as { v?: unknown }).v
        : undefined;
    return rawVersion !== undefined &&
      rawVersion !== AGENT_WS_V2_PROTOCOL_VERSION
      ? { ok: false, code: "unsupported-version" }
      : { ok: false, code: "invalid-envelope" };
  }

  const frame = envelope.data;
  const type = frame.type;
  if (!isKnownV2Type(type)) {
    return { ok: true, frame, message: { kind: "unknown", type } };
  }
  if (!isBidirectional(type) && directionOf(type) !== sender) {
    return { ok: false, code: "invalid-direction", type };
  }

  const payload = agentWsV2PayloadSchemas[type].safeParse(frame.payload);
  if (!payload.success) {
    return { ok: false, code: "invalid-payload", type };
  }
  return {
    ok: true,
    frame,
    message: { kind: type, payload: payload.data } as AgentWsV2Message,
  };
}

export function createAgentWsV2Frame<T extends AgentWsV2MessageType>(
  type: T,
  payload: AgentWsV2PayloadOf<T>,
  options: { id?: string; ts?: string } = {},
): AgentWsV2Frame {
  return {
    v: AGENT_WS_V2_PROTOCOL_VERSION,
    ...(options.id ? { id: options.id } : {}),
    type,
    ts: options.ts ?? new Date().toISOString(),
    payload,
  };
}

export function encodeAgentWsV2Frame(frame: AgentWsV2Frame): string {
  return JSON.stringify(frame);
}
