import { z } from "zod";

/**
 * Frozen agent WebSocket protocol v1.
 *
 * The Rust client in `server-agent/src/ws/codec.rs` is the other half of this
 * contract. Keep the envelope and payload field names in sync with it:
 * camelCase JSON, dotted frame types, RFC 3339 timestamps.
 */
export const AGENT_WS_PROTOCOL_VERSION = 1 as const;

export const AGENT_WS_PATH = "/api/agent/ws" as const;

export const AGENT_WS_MESSAGE_TYPES = [
  "hello",
  "welcome",
  "ping",
  "pong",
  "config.notify",
  "config.ack",
  "update.trigger",
  "update.status",
] as const;

export type AgentWsMessageType = (typeof AGENT_WS_MESSAGE_TYPES)[number];

export const AGENT_WS_RESERVED_MESSAGE_TYPES = [
  "telemetry.subscribe",
  "telemetry.sample",
  "telemetry.inspect",
  "telemetry.snapshot",
  "pty.open",
  "pty.data",
  "pty.resize",
  "pty.close",
  "pty.exit",
  "acme.issue",
  "acme.dns_present",
  "acme.dns_cleanup",
  "acme.result",
] as const;

export type AgentWsReservedMessageType =
  (typeof AGENT_WS_RESERVED_MESSAGE_TYPES)[number];

const timestampSchema = z.iso.datetime();
const correlationIdSchema = z.string().min(1).max(128);

export const agentWsEnvelopeSchema = z.object({
  v: z.literal(AGENT_WS_PROTOCOL_VERSION).default(AGENT_WS_PROTOCOL_VERSION),
  id: correlationIdSchema.optional(),
  type: z.string().min(1).max(128),
  ts: timestampSchema.default(() => new Date().toISOString()),
  payload: z.unknown().default({}),
});

export type AgentWsFrame = z.infer<typeof agentWsEnvelopeSchema>;

const certificateDeploymentSchema = z.object({
  certificateId: z.string().min(1),
  generation: z.number().int().min(1),
  fingerprintSha256: z.string().min(1).max(256),
  installed: z.boolean(),
  inUse: z.boolean(),
  errorPhase: z.string().min(1).max(64).optional(),
  errorMessage: z.string().min(1).max(16_384).optional(),
});

export type AgentWsCertificateDeployment = z.infer<
  typeof certificateDeploymentSchema
>;

/**
 * Update status shared by `hello`, `config.ack`-adjacent telemetry, and
 * `update.status`. The Rust client reports the control plane's snake_case
 * state names inside camelCase JSON fields.
 */
export const agentWsUpdateStateSchema = z.enum([
  "unknown",
  "idle",
  "up_to_date",
  "checking",
  "downloading",
  "verifying",
  "applying",
  "restarting",
  "failed",
  "disabled",
]);

export const agentWsUpdateStatusSchema = z.object({
  targetVersion: z.string().min(1).max(64).optional(),
  state: agentWsUpdateStateSchema,
  message: z.string().min(1).max(4096).optional(),
  checkedAt: timestampSchema.optional(),
});

export type AgentWsUpdateStatus = z.infer<typeof agentWsUpdateStatusSchema>;

export const agentWsUpdateStatusesSchema = z.object({
  agent: agentWsUpdateStatusSchema.optional(),
  singBox: agentWsUpdateStatusSchema.optional(),
});

export type AgentWsUpdateStatuses = z.infer<typeof agentWsUpdateStatusesSchema>;

/**
 * `hello` (agent -> control plane), sent on every connect and reconnect.
 * `agentBuildId` is optional on the control-plane side so an older agent can
 * still establish the push channel; the PR #112 client always sends it.
 */
export const agentWsHelloPayloadSchema = z.object({
  agentVersion: z.string().min(1).max(128),
  agentBuildId: z.string().min(1).max(256).optional(),
  capabilities: z.array(z.string().min(1).max(128)).max(1024).default([]),
  appliedRevision: z.string().max(128).optional(),
  certificateDeployments: z
    .array(certificateDeploymentSchema)
    .max(10_000)
    .default([]),
  updates: agentWsUpdateStatusesSchema.optional(),
});

export type AgentWsHelloPayload = z.infer<typeof agentWsHelloPayloadSchema>;

/** `welcome` (control plane -> agent). */
export const agentWsWelcomePayloadSchema = z.object({
  serverId: z.string().min(1),
  serverName: z.string().min(1).max(128),
  protocolVersion: z.literal(AGENT_WS_PROTOCOL_VERSION),
  desiredRevisionSeq: z.number().int().min(0),
  desiredRevision: z.string().min(1).max(256),
  pollIntervalSeconds: z.number().int().min(1).max(86_400),
  heartbeatIntervalSeconds: z.number().int().min(1).max(3_600),
  reconnectBeforeSeconds: z.number().int().min(1).max(800).optional(),
});

export type AgentWsWelcomePayload = z.infer<typeof agentWsWelcomePayloadSchema>;

export const agentWsPingPayloadSchema = z.object({
  nonce: z.string().max(128).optional(),
});

export type AgentWsPingPayload = z.infer<typeof agentWsPingPayloadSchema>;

/** `config.notify` (control plane -> agent). */
export const agentWsConfigNotifyPayloadSchema = z.object({
  desiredRevisionSeq: z.number().int().min(0),
  desiredRevision: z.string().min(1).max(256),
  reason: z.string().min(1).max(256).optional(),
});

export type AgentWsConfigNotifyPayload = z.infer<
  typeof agentWsConfigNotifyPayloadSchema
>;

/**
 * `config.ack` (agent -> control plane). `appliedRevision` may be empty when
 * the agent failed before it ever committed a revision; the control plane must
 * not treat that as an applied revision.
 */
export const agentWsConfigAckPayloadSchema = z.object({
  appliedRevision: z.string().max(128),
  certificateDeployments: z
    .array(certificateDeploymentSchema)
    .max(10_000)
    .optional(),
  error: z.string().min(1).max(16_384).optional(),
});

export type AgentWsConfigAckPayload = z.infer<
  typeof agentWsConfigAckPayloadSchema
>;

export const agentWsUpdateTargetSchema = z.enum(["agent", "sing-box", "all"]);

export type AgentWsUpdateTarget = z.infer<typeof agentWsUpdateTargetSchema>;

/**
 * `update.trigger` (control plane -> agent). A missing or null desired version
 * means "resolve the latest release" on the agent.
 */
export const agentWsUpdateTriggerPayloadSchema = z.object({
  target: agentWsUpdateTargetSchema,
  desiredAgentVersion: z.string().min(1).max(64).nullable().optional(),
  desiredSingBoxVersion: z.string().min(1).max(64).nullable().optional(),
  force: z.boolean().default(false),
});

export type AgentWsUpdateTriggerPayload = z.infer<
  typeof agentWsUpdateTriggerPayloadSchema
>;

// --- Extension channels ------------------------------------------

export const agentWsTelemetrySubscribePayloadSchema = z.object({
  requestId: correlationIdSchema,
  enabled: z.literal(true),
});

const byteCount = z.number().int().nonnegative();
const usage = z
  .object({ used: byteCount, total: byteCount })
  .refine(({ used, total }) => used <= total);
const ipAddress = z.union([z.ipv4(), z.ipv6()]);

export const agentWsTelemetrySamplePayloadSchema = z.object({
  requestId: correlationIdSchema,
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
});

export const agentWsTelemetryInspectPayloadSchema = z.object({
  requestId: correlationIdSchema,
});

export const agentWsTelemetrySnapshotPayloadSchema = z.object({
  requestId: correlationIdSchema,
  partial: z.boolean(),
  listeners: z
    .array(
      z.object({
        protocol: z.enum(["tcp", "udp"]),
        address: ipAddress,
        port: z.number().int().min(1).max(65535),
      }),
    )
    .max(128),
  interfaces: z
    .array(
      z.object({
        name: z
          .string()
          .min(1)
          .max(32)
          .refine((name) =>
            [...name].every(
              (character) =>
                character >= " " &&
                character !== "\u007f" &&
                character !== "/" &&
                character.trim() !== "",
            ),
          ),
        address: ipAddress,
      }),
    )
    .max(128),
});

export const agentWsPtyOpenPayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export const agentWsPtyDataPayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
  data: z.string().max(1024 * 1024),
});

export const agentWsPtyResizePayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
  cols: z.number().int().min(1).max(1000),
  rows: z.number().int().min(1).max(1000),
});

export const agentWsPtyClosePayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
});

export const AGENT_WS_PTY_CAPABILITY = "pty-v1" as const;
export const AGENT_WS_PTY_MAX_DATA_BYTES = 1024 * 1024;

export const AGENT_WS_PTY_EXIT_REASONS = [
  "closed",
  "idle_timeout",
  "agent_shutdown",
  "agent_disconnected",
  "session_limit",
  "invalid_session",
  "spawn_failed",
  "output_backpressure",
  "input_backpressure",
  "frame_too_large",
  "io_error",
  "disabled",
  "session_expired",
  "shell_exit",
] as const;

export type AgentWsPtyExitReason = (typeof AGENT_WS_PTY_EXIT_REASONS)[number];

export const agentWsPtyExitReasonSchema = z.enum(AGENT_WS_PTY_EXIT_REASONS);

export const agentWsPtyExitPayloadSchema = z.object({
  sessionId: z.string().min(1).max(128),
  code: z.number().int().optional(),
  signal: z.string().max(64).optional(),
  reason: agentWsPtyExitReasonSchema.optional(),
});

export const AGENT_WS_PTY_MESSAGE_TYPES = [
  "pty.open",
  "pty.data",
  "pty.resize",
  "pty.close",
  "pty.exit",
] as const;

export type AgentWsPtyMessageType = (typeof AGENT_WS_PTY_MESSAGE_TYPES)[number];

export type AgentWsPtyMessage =
  | { type: "pty.open"; payload: AgentWsPtyOpenPayload }
  | { type: "pty.data"; payload: AgentWsPtyDataPayload }
  | { type: "pty.resize"; payload: AgentWsPtyResizePayload }
  | { type: "pty.close"; payload: AgentWsPtyClosePayload }
  | { type: "pty.exit"; payload: AgentWsPtyExitPayload };

export type AgentWsPtyOpenPayload = z.infer<typeof agentWsPtyOpenPayloadSchema>;
export type AgentWsPtyDataPayload = z.infer<typeof agentWsPtyDataPayloadSchema>;
export type AgentWsPtyResizePayload = z.infer<
  typeof agentWsPtyResizePayloadSchema
>;
export type AgentWsPtyClosePayload = z.infer<
  typeof agentWsPtyClosePayloadSchema
>;
export type AgentWsPtyExitPayload = z.infer<typeof agentWsPtyExitPayloadSchema>;

export function isAgentWsPtyMessageType(
  type: string,
): type is AgentWsPtyMessageType {
  return (AGENT_WS_PTY_MESSAGE_TYPES as readonly string[]).includes(type);
}

export type AgentWsPtyParseResult =
  | { ok: true; message: AgentWsPtyMessage }
  | { ok: false; type: AgentWsPtyMessageType };

/**
 * Parses a PTY payload without reinterpreting the base envelope. Returns
 * `null` for non-PTY frame types so callers can leave unknown/reserved
 * channels alone.
 */
export function parseAgentWsPtyMessage(
  type: string,
  payload: unknown,
): AgentWsPtyParseResult | null {
  if (!isAgentWsPtyMessageType(type)) {
    return null;
  }
  const schema = agentWsPtyPayloadSchemas[type];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, type };
  }
  return {
    ok: true,
    message: { type, payload: parsed.data } as AgentWsPtyMessage,
  };
}

export const agentWsAcmeIssuePayloadSchema = z.object({
  jobId: z.string().min(1).max(128),
  certificateId: z.string().min(1),
  domains: z.array(z.string().min(1)).min(1),
  acmeEmail: z.email().optional(),
  acmeProvider: z.enum(["letsencrypt", "zerossl"]).optional(),
  acmeStaging: z.boolean().optional(),
  challengeType: z.enum(["dns-01", "http-01"]),
});

export const agentWsAcmeDnsPresentPayloadSchema = z.object({
  jobId: z.string().min(1).max(128),
  fqdn: z.string().min(1),
  txtValue: z.string().min(1),
});

export const agentWsAcmeDnsCleanupPayloadSchema = z.object({
  jobId: z.string().min(1).max(128),
  fqdn: z.string().min(1),
  txtValue: z.string().min(1),
});

export const agentWsAcmeResultPayloadSchema = z.object({
  jobId: z.string().min(1).max(128),
  certificatePem: z.string().min(1).optional(),
  privateKeyPem: z.string().min(1).optional(),
  error: z.string().min(1).max(16_384).optional(),
});

export const agentWsPayloadSchemas = {
  hello: agentWsHelloPayloadSchema,
  welcome: agentWsWelcomePayloadSchema,
  ping: agentWsPingPayloadSchema,
  pong: agentWsPingPayloadSchema,
  "config.notify": agentWsConfigNotifyPayloadSchema,
  "config.ack": agentWsConfigAckPayloadSchema,
  "update.trigger": agentWsUpdateTriggerPayloadSchema,
  "update.status": agentWsUpdateStatusesSchema,
} as const satisfies Record<AgentWsMessageType, z.ZodType>;

export const agentWsPtyPayloadSchemas = {
  "pty.open": agentWsPtyOpenPayloadSchema,
  "pty.data": agentWsPtyDataPayloadSchema,
  "pty.resize": agentWsPtyResizePayloadSchema,
  "pty.close": agentWsPtyClosePayloadSchema,
  "pty.exit": agentWsPtyExitPayloadSchema,
} as const satisfies Record<AgentWsPtyMessageType, z.ZodType>;

export const agentWsReservedPayloadSchemas = {
  "telemetry.subscribe": agentWsTelemetrySubscribePayloadSchema,
  "telemetry.sample": agentWsTelemetrySamplePayloadSchema,
  "telemetry.inspect": agentWsTelemetryInspectPayloadSchema,
  "telemetry.snapshot": agentWsTelemetrySnapshotPayloadSchema,
  ...agentWsPtyPayloadSchemas,
  "acme.issue": agentWsAcmeIssuePayloadSchema,
  "acme.dns_present": agentWsAcmeDnsPresentPayloadSchema,
  "acme.dns_cleanup": agentWsAcmeDnsCleanupPayloadSchema,
  "acme.result": agentWsAcmeResultPayloadSchema,
} as const satisfies Record<AgentWsReservedMessageType, z.ZodType>;

export type AgentWsDecodedMessage =
  | { kind: "hello"; payload: AgentWsHelloPayload }
  | { kind: "welcome"; payload: AgentWsWelcomePayload }
  | { kind: "ping"; payload: AgentWsPingPayload }
  | { kind: "pong"; payload: AgentWsPingPayload }
  | { kind: "config.notify"; payload: AgentWsConfigNotifyPayload }
  | { kind: "config.ack"; payload: AgentWsConfigAckPayload }
  | { kind: "update.trigger"; payload: AgentWsUpdateTriggerPayload }
  | { kind: "update.status"; payload: AgentWsUpdateStatuses }
  | {
      kind: "reserved";
      type: AgentWsReservedMessageType;
      payload: z.infer<
        (typeof agentWsReservedPayloadSchemas)[AgentWsReservedMessageType]
      >;
    }
  | { kind: "unknown"; type: string };

export type AgentWsParseErrorCode =
  | "invalid-json"
  | "invalid-envelope"
  | "unsupported-version"
  | "invalid-payload";

export type AgentWsParseResult =
  | {
      ok: true;
      frame: AgentWsFrame;
      message: AgentWsDecodedMessage;
    }
  | {
      ok: false;
      code: AgentWsParseErrorCode;
      type?: string;
      version?: number;
    };

function isKnownMessageType(type: string): type is AgentWsMessageType {
  return (AGENT_WS_MESSAGE_TYPES as readonly string[]).includes(type);
}

function isReservedMessageType(
  type: string,
): type is AgentWsReservedMessageType {
  return (AGENT_WS_RESERVED_MESSAGE_TYPES as readonly string[]).includes(type);
}

/**
 * Parses one text frame. Unknown frame types are accepted so a newer control
 * plane can introduce channels without disconnecting an older agent; known and
 * reserved payloads are validated against their schemas.
 */
export function parseAgentWsFrame(text: string): AgentWsParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-json" };
  }

  const parsed = agentWsEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    const rawVersion =
      typeof raw === "object" && raw !== null && "v" in raw
        ? (raw as { v?: unknown }).v
        : undefined;
    if (
      typeof rawVersion === "number" &&
      rawVersion !== AGENT_WS_PROTOCOL_VERSION
    ) {
      return {
        ok: false,
        code: "unsupported-version",
        version: rawVersion,
      };
    }
    return { ok: false, code: "invalid-envelope" };
  }

  const frame = parsed.data;
  const type = frame.type;
  if (isKnownMessageType(type)) {
    const payload = agentWsPayloadSchemas[type].safeParse(frame.payload);
    if (!payload.success) {
      return { ok: false, code: "invalid-payload", type };
    }
    return {
      ok: true,
      frame,
      message: { kind: type, payload: payload.data } as AgentWsDecodedMessage,
    };
  }

  if (isReservedMessageType(type)) {
    const payload = agentWsReservedPayloadSchemas[type].safeParse(
      frame.payload,
    );
    if (!payload.success) {
      return { ok: false, code: "invalid-payload", type };
    }
    return {
      ok: true,
      frame,
      message: { kind: "reserved", type, payload: payload.data },
    };
  }

  return { ok: true, frame, message: { kind: "unknown", type } };
}

export function createAgentWsFrame(
  type: string,
  payload: unknown,
  options: { id?: string; ts?: string } = {},
): AgentWsFrame {
  return {
    v: AGENT_WS_PROTOCOL_VERSION,
    ...(options.id ? { id: options.id } : {}),
    type,
    ts: options.ts ?? new Date().toISOString(),
    payload,
  };
}

export function encodeAgentWsFrame(frame: AgentWsFrame): string {
  return JSON.stringify(frame);
}
