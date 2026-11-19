import { z } from "zod";

import {
  agentWsUpdateStatusesSchema,
  certificateDeploymentSchema,
} from "./agent-ws";

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
  "error",
] as const;

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
  welcome: agentWsV2WelcomePayloadSchema,
  "agent.status.ack": agentWsV2StatusAckPayloadSchema,
  "config.notify": agentWsV2ConfigNotifyPayloadSchema,
  "config.snapshot.begin": agentWsV2SnapshotBeginPayloadSchema,
  "config.snapshot.chunk": agentWsV2SnapshotChunkPayloadSchema,
  "config.snapshot.end": agentWsV2SnapshotEndPayloadSchema,
  "config.snapshot.error": agentWsV2SnapshotErrorPayloadSchema,
  "traffic.ack": agentWsV2TrafficAckPayloadSchema,
  error: agentWsV2ErrorPayloadSchema,
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
  if (directionOf(type) !== sender) {
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
