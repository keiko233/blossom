import type {
  AgentWsAcmeDnsCleanupPayload,
  AgentWsAcmeDnsPresentPayload,
  AgentWsAcmeResultPayload,
  AgentWsCertificateDeployment,
  AgentWsPtyDataPayload,
  AgentWsPtyExitPayload,
  AgentWsPtyStartedPayload,
  AgentWsUpdateStatuses,
} from "@blossom/contracts/agent-ws";
import {
  AGENT_WS_V2_LIMITS,
  AGENT_WS_V2_TELEMETRY_HISTORY_CAPABILITY,
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2ConfigAckPayload,
  type AgentWsV2ConfigIdentifier,
  type AgentWsV2ConfigNotifyPayload,
  type AgentWsV2ErrorPayload,
  type AgentWsV2HelloPayload,
  type AgentWsV2Message,
  type AgentWsV2PayloadOf,
  type AgentWsV2StatusPayload,
  type AgentWsV2TelemetrySamplePayload,
  type AgentWsV2TelemetrySnapshotPayload,
  type AgentWsV2TelemetrySubscribePayload,
  type AgentWsV2TrafficReportPayload,
  type AgentWsV2UpdatePolicy,
  type AgentWsV2ControlMessageType,
} from "@blossom/contracts/agent-ws-v2";
import {
  LOG_POLICY_CAPABILITY,
  type LogPolicyAckPayload,
  type LogPolicyGetPayload,
  type LogPolicyNotifyPayload,
  type LogPolicySnapshotPayload,
} from "@blossom/contracts/log-policy";
import { AGENT_WS_V2_LOGS_AGENT_MESSAGE_TYPES } from "@blossom/contracts/agent-ws-v2-logs";
import { parseRevisionSeq } from "@blossom/domain/config-revision";

import type { Server } from "@/db/proxy-schema";
import type {
  AgentSessionCredential,
  CachedDesiredRevision,
} from "@/query/agent";
import type {
  AgentLogPolicySnapshot,
  LogPolicyAckOutcome,
} from "@/query/log-policy";

import { encodeConfigSnapshot } from "./agent-ws-v2-snapshot";

export interface AgentWsV2Peer {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

export type AgentWsV2AckOutcome = "applied" | "failed" | "stale" | "replaced";

/** Result of an authoritative lease check for one session. */
export type AgentWsV2Lease = "ok" | "replaced" | "disabled";

export type AgentWsV2TrafficOutcome =
  | { status: "applied" | "duplicate"; accepted: number; dropped: number }
  | { status: "conflict"; message: string }
  | { status: "replaced" };

export type AgentWsV2PtyFrame =
  | { type: "pty.started"; payload: AgentWsPtyStartedPayload }
  | { type: "pty.data"; payload: AgentWsPtyDataPayload }
  | { type: "pty.exit"; payload: AgentWsPtyExitPayload };
export type AgentWsV2MetricOutcome =
  | "written"
  | "superseded"
  | "fenced"
  | "invalid";

/**
 * Persistence port for one v2 session. Every write names the session, and the
 * adapter must make it conditional on that session being the server's current
 * one (see `query/agent.ts`). A `null` or `"replaced"` result means the session
 * was superseded and must stop.
 */
export interface AgentWsV2Store {
  /**
   * The server row, but only while this session is still current. Returns
   * `null` once the session was replaced or its credential rotated, so no
   * configuration is read or sent for it.
   */
  loadCurrentServer(
    serverId: string,
    sessionId: string,
  ): Promise<Server | null>;
  recordHello(
    serverId: string,
    sessionId: string,
    hello: AgentWsV2HelloPayload,
  ): Promise<Server | null>;
  recordStatus(
    serverId: string,
    sessionId: string,
    status: AgentWsV2StatusPayload,
  ): Promise<Server | null>;
  recordConfigAck(
    serverId: string,
    sessionId: string,
    ack: AgentWsV2ConfigAckPayload,
  ): Promise<AgentWsV2AckOutcome>;
  recordUpdateStatus(
    serverId: string,
    sessionId: string,
    updates: AgentWsUpdateStatuses,
  ): Promise<boolean>;
  /**
   * Completes a pending OAuth proof after `hello`, promoting the identity and
   * taking the server fence. Returns `null` if the credential is no longer
   * usable.
   */
  promoteSession(
    serverId: string,
    sessionId: string,
    credential: AgentSessionCredential,
  ): Promise<Server | null>;
  cacheDesiredRevision(
    serverId: string,
    sessionId: string,
    cache: CachedDesiredRevision,
  ): Promise<void>;
  applyCertificateDeployments(
    serverId: string,
    sessionId: string,
    deployments: AgentWsCertificateDeployment[],
  ): Promise<void>;
  /**
   * Re-reads the server and credential state. `pending` sessions are checked
   * against the still-pending identity rather than the server's session fence.
   */
  revalidateSession(
    serverId: string,
    sessionId: string,
    credential: AgentSessionCredential,
    pending: boolean,
  ): Promise<AgentWsV2Lease>;
  applyTraffic(
    serverId: string,
    sessionId: string,
    report: AgentWsV2TrafficReportPayload,
  ): Promise<AgentWsV2TrafficOutcome>;
  handleAcmeDnsPresent(
    serverId: string,
    sessionId: string,
    payload: AgentWsAcmeDnsPresentPayload,
  ): Promise<boolean>;
  handleAcmeDnsCleanup(
    serverId: string,
    sessionId: string,
    payload: AgentWsAcmeDnsCleanupPayload,
  ): Promise<boolean>;
  handleAcmeResult(
    serverId: string,
    sessionId: string,
    payload: AgentWsAcmeResultPayload,
  ): Promise<boolean>;
  /**
   * Reads the desired policy only while the session is current, or `null`
   * when the session has been replaced.
   */
  loadLogPolicy(
    serverId: string,
    sessionId: string,
  ): Promise<AgentLogPolicySnapshot | null>;
  /** Fenced, revision-checked acknowledgement of one source's effective state. */
  recordLogPolicyAck(
    serverId: string,
    sessionId: string,
    ack: LogPolicyAckPayload,
  ): Promise<LogPolicyAckOutcome>;
  /**
   * Records the independent history cadence. The write is conditional on this
   * exact session still being `server.ws_session_id`, so a replaced session
   * can never fill or overwrite a minute bucket. Browser requests never call
   * this path.
   */
  recordMetricHistory(
    serverId: string,
    sessionId: string,
    sample: AgentWsV2TelemetrySamplePayload,
  ): Promise<AgentWsV2MetricOutcome>;
  /**
   * Compiles the same desired state the v3 HTTP response serves. `validUntil`
   * is the instant the identifier must be recompiled by, even with no change.
   */
  compile(server: Server): Promise<{
    desiredRevision: string;
    document: unknown;
    validUntil: Date;
  }>;
  endSession(serverId: string, sessionId: string): Promise<void>;
}

export interface OpenAgentWsV2SessionOptions {
  serverId: string;
  /** The session id the upgrade handler already made current. */
  sessionId: string;
  /** The credential that authenticated the upgrade. Never raw token material. */
  credential: AgentSessionCredential;
  /**
   * A pending OAuth identity gets a proof-only session. Its `hello` promotes
   * the identity and takes the server fence; before that it owns no fence.
   */
  pending?: boolean;
  peer: AgentWsV2Peer;
  store: AgentWsV2Store;
  /**
   * Whether `welcome` was already sent on this session. A Durable Object
   * rebuilds the session for each message, so it restores this from the socket
   * attachment; a Nitro connection starts false.
   */
  welcomed?: boolean;
  /** Advertised early reconnect deadline (Vercel function lifetime). */
  reconnectBeforeSeconds?: number;
  /**
   * Delivers one terminal frame to the relay bound to this exact agent
   * session. Returns false when no relay is open, so the session tells the
   * agent to stop the shell.
   */
  onPtyFrame?: (frame: AgentWsV2PtyFrame) => boolean | Promise<boolean>;
  /**
   * Receives the raw text of an `agent`-direction log frame after direction,
   * envelope and payload validation. The admin log relay owns these frames;
   * a session without a relay simply ignores them.
   */
  onLogFrame?: (text: string) => void | Promise<void>;
  /** Called for every valid sample, independent of whether it was stored. */
  onSample?: (sample: AgentWsV2TelemetrySamplePayload) => void;
  /** Called for an on-demand inspection snapshot. */
  onSnapshot?: (snapshot: AgentWsV2TelemetrySnapshotPayload) => void;
  /** Called after `welcome` is sent, for subscriptions held by viewers. */
  onWelcome?: () => void;
}

export interface AgentWsV2Session {
  /** True once `welcome` has been sent. Pushes are withheld until then. */
  readonly welcomed: boolean;
  /** True while a pending identity still needs its `hello` promotion. */
  readonly pending: boolean;
  /** Re-checks the authoritative lease; closes the session when it fails. */
  revalidate(): Promise<void>;
  readonly sessionId: string;
  handleText(text: string): Promise<void>;
  /**
   * Sends an already-encoded log control frame to the agent. Returns false
   * before `welcome`, after close, or when the socket refuses the frame.
   */
  sendLogFrame(text: string): boolean;
  /** Starts or replaces a telemetry subscription on a welcomed session. */
  subscribeTelemetry(payload: AgentWsV2TelemetrySubscribePayload): void;
  unsubscribeTelemetry(subscriptionId: string): void;
  /** Requests the listener/interface snapshot used by the inspection panel. */
  inspectTelemetry(requestId: string): void;
  close(): Promise<void>;
}

const LOG_AGENT_TYPES: readonly string[] = AGENT_WS_V2_LOGS_AGENT_MESSAGE_TYPES;

function isLogAgentType(type: string): boolean {
  return LOG_AGENT_TYPES.includes(type);
}

/** Encodes a `config.notify` frame for welcomed v2 sessions. */
export function encodeAgentWsV2ConfigNotify(
  payload: AgentWsV2ConfigNotifyPayload,
): string {
  return encodeAgentWsV2Frame(createAgentWsV2Frame("config.notify", payload));
}

/** Encodes a `log.policy.notify` frame for welcomed v2 sessions. */
export function encodeAgentWsV2LogPolicyNotify(
  payload: LogPolicyNotifyPayload,
): string {
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame("log.policy.notify", payload),
  );
}

function logFailure(operation: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(`agent websocket v2 ${operation} failed: ${message}`);
}

async function safely(
  operation: string,
  run: () => Promise<unknown>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    logFailure(operation, error);
  }
}

function updatePolicyOf(server: Server): AgentWsV2UpdatePolicy {
  return {
    desiredAgentVersion: server.desiredAgentVersion ?? null,
    desiredSingBoxVersion: server.desiredSingBoxVersion ?? null,
  };
}

function supportsLogPolicy(server: Server): boolean {
  return server.agentCapabilities.includes(LOG_POLICY_CAPABILITY);
}

/**
 * Drives one agent connection that negotiated v2. Frames are validated for
 * direction and payload before any state changes. Replies go back on the same
 * peer; durable effects go through the fenced store.
 */
export function openAgentWsV2Session(
  options: OpenAgentWsV2SessionOptions,
): AgentWsV2Session {
  const { serverId, sessionId, peer, store, credential } = options;
  let welcomed = options.welcomed ?? false;
  let pending = options.pending ?? false;
  let closed = false;
  let snapshotGeneration = 0;
  let capabilities: readonly string[] = [];

  function send<T extends AgentWsV2ControlMessageType>(
    type: T,
    payload: AgentWsV2PayloadOf<T>,
    id?: string,
  ): void {
    peer.send(
      encodeAgentWsV2Frame(
        createAgentWsV2Frame(type, payload, id ? { id } : {}),
      ),
    );
  }

  function reject(
    code: AgentWsV2ErrorPayload["code"],
    message: string,
    type?: string,
  ): void {
    send("error", {
      code,
      message,
      ...(type === undefined ? {} : { type }),
    });
  }

  /**
   * Ends a session that is no longer authoritative. The socket closes, and the
   * store's fenced end is a no-op for a session that was already replaced.
   */
  function stop(code: AgentWsV2ErrorPayload["code"], message: string): void {
    closed = true;
    reject(code, message);
    peer.close(4000, code);
  }

  async function revalidate(): Promise<void> {
    if (closed) {
      return;
    }
    let lease: AgentWsV2Lease;
    try {
      lease = await store.revalidateSession(
        serverId,
        sessionId,
        credential,
        pending,
      );
    } catch (error) {
      logFailure("lease revalidation", error);
      return;
    }
    if (lease === "replaced") {
      stop("session_replaced", "session is no longer current");
    } else if (lease === "disabled") {
      stop("server_disabled", "server is disabled");
    }
  }

  /**
   * The identifier for `server`, the row just read. A cached identifier is
   * reused only while its sequence matches, its deadline has not passed, and
   * no invalidation has reset it; otherwise the configuration is compiled and
   * the result cached against the row's sequence and inputs version.
   */
  async function currentDesired(
    server: Server,
  ): Promise<AgentWsV2ConfigIdentifier> {
    const marker = server.desiredConfigRevision;
    const validUntil = server.desiredConfigValidUntil;
    if (
      marker &&
      validUntil &&
      validUntil.getTime() > Date.now() &&
      parseRevisionSeq(marker) === server.desiredRevisionSeq
    ) {
      return {
        desiredRevisionSeq: server.desiredRevisionSeq,
        desiredRevision: marker,
      };
    }
    const compiled = await store.compile(server);
    await safely("cache desired revision", () =>
      store.cacheDesiredRevision(serverId, sessionId, {
        desiredRevisionSeq: server.desiredRevisionSeq,
        desiredInputsVersion: server.desiredInputsVersion,
        desiredRevision: compiled.desiredRevision,
        validUntil: compiled.validUntil,
      }),
    );
    return {
      desiredRevisionSeq: server.desiredRevisionSeq,
      desiredRevision: compiled.desiredRevision,
    };
  }

  /**
   * The server row for this session, or `null` after stopping the session when
   * it is no longer current or the server is disabled. Every configuration
   * read goes through here.
   */
  async function requireCurrentServer(): Promise<Server | null> {
    const server = await store.loadCurrentServer(serverId, sessionId);
    if (!server) {
      stop("session_replaced", "a newer session is active");
      return null;
    }
    if (!server.enabled) {
      stop("server_disabled", "server is disabled");
      return null;
    }
    return server;
  }

  async function onHello(hello: AgentWsV2HelloPayload, id?: string) {
    if (welcomed) {
      reject("invalid_payload", "hello was already received", "hello");
      return;
    }
    if (pending) {
      const promoted = await store.promoteSession(
        serverId,
        sessionId,
        credential,
      );
      if (!promoted) {
        stop("session_replaced", "the pending credential is no longer current");
        return;
      }
      pending = false;
    }
    const server = await store.recordHello(serverId, sessionId, hello);
    if (!server) {
      stop("session_replaced", "a newer session is active");
      return;
    }
    if (!server.enabled) {
      stop("server_disabled", "server is disabled");
      return;
    }
    if (hello.certificateDeployments.length > 0) {
      await safely("certificate deployments", () =>
        store.applyCertificateDeployments(
          serverId,
          sessionId,
          hello.certificateDeployments,
        ),
      );
    }

    const desired = await currentDesired(server);
    welcomed = true;
    send(
      "welcome",
      {
        sessionId,
        serverId,
        serverName: server.name,
        desired,
        updatePolicy: updatePolicyOf(server),
        statusIntervalSeconds: Math.min(
          Math.max(server.heartbeatIntervalSeconds, 1),
          3_600,
        ),
        ...(options.reconnectBeforeSeconds === undefined
          ? {}
          : { reconnectBeforeSeconds: options.reconnectBeforeSeconds }),
        ...(supportsLogPolicy(server)
          ? { logPolicyRevision: server.logPolicyRevision }
          : {}),
        limits: {
          maxFrameBytes: AGENT_WS_V2_LIMITS.maxFrameBytes,
          snapshotChunkBytes: AGENT_WS_V2_LIMITS.snapshotChunkBytes,
          maxSnapshotBytes: AGENT_WS_V2_LIMITS.maxSnapshotBytes,
        },
      },
      id,
    );
    options.onWelcome?.();
    capabilities = hello.capabilities;
    if (capabilities.includes(AGENT_WS_V2_TELEMETRY_HISTORY_CAPABILITY)) {
      send("telemetry.subscribe", {
        subscriptionId: `history-${sessionId}`,
        purpose: "history",
        intervalMs: 60_000,
      });
    }
  }

  async function onStatus(status: AgentWsV2StatusPayload, id?: string) {
    const server = await store.recordStatus(serverId, sessionId, status);
    if (!server) {
      stop("session_replaced", "a newer session is active");
      return;
    }
    if (!server.enabled) {
      stop("server_disabled", "server is disabled");
      return;
    }
    if (status.certificateDeployments.length > 0) {
      await safely("certificate deployments", () =>
        store.applyCertificateDeployments(
          serverId,
          sessionId,
          status.certificateDeployments,
        ),
      );
    }
    send(
      "agent.status.ack",
      {
        desired: await currentDesired(server),
        updatePolicy: updatePolicyOf(server),
        ...(supportsLogPolicy(server)
          ? { logPolicyRevision: server.logPolicyRevision }
          : {}),
      },
      id,
    );
  }

  async function onConfigGet(requestId: string) {
    // A newer request supersedes an older compile that has not sent yet, so a
    // slow older snapshot can never reach the agent after a newer one.
    const generation = ++snapshotGeneration;
    const server = await requireCurrentServer();
    if (!server) {
      return;
    }
    const compiled = await store.compile(server);
    if (generation !== snapshotGeneration) {
      return;
    }
    // The snapshot carries certificate private keys, so it is sent only if the
    // session is still current after the compile: a rotation or a replacement
    // that landed during the compile must not receive it.
    if (!(await requireCurrentServer())) {
      return;
    }

    const encoded = encodeConfigSnapshot(compiled.document);
    if (!encoded.ok) {
      send("config.snapshot.error", {
        requestId,
        code: encoded.code,
        message: `compiled configuration is ${encoded.totalBytes} bytes; the limit is ${AGENT_WS_V2_LIMITS.maxSnapshotBytes}`,
      });
      return;
    }

    const desired = {
      desiredRevisionSeq: server.desiredRevisionSeq,
      desiredRevision: compiled.desiredRevision,
    };
    send("config.snapshot.begin", {
      requestId,
      desired,
      contentType: "application/json",
      totalBytes: encoded.totalBytes,
      chunkCount: encoded.chunks.length,
      digest: encoded.digest,
    });
    encoded.chunks.forEach((data, index) => {
      send("config.snapshot.chunk", { requestId, index, data });
    });
    send("config.snapshot.end", { requestId });

    await safely("cache desired revision", () =>
      store.cacheDesiredRevision(serverId, sessionId, {
        desiredRevisionSeq: server.desiredRevisionSeq,
        desiredInputsVersion: server.desiredInputsVersion,
        desiredRevision: compiled.desiredRevision,
        validUntil: compiled.validUntil,
      }),
    );
  }

  async function onConfigAck(ack: AgentWsV2ConfigAckPayload) {
    const outcome = await store.recordConfigAck(serverId, sessionId, ack);
    if (outcome === "replaced") {
      stop("session_replaced", "a newer session is active");
    }
  }

  async function onTrafficReport(report: AgentWsV2TrafficReportPayload) {
    const outcome = await store.applyTraffic(serverId, sessionId, report);
    if (outcome.status === "replaced") {
      stop("session_replaced", "a newer session is active");
      return;
    }
    if (outcome.status === "conflict") {
      send("traffic.ack", {
        reportId: report.reportId,
        result: "conflict",
        error: outcome.message,
      });
      return;
    }
    send("traffic.ack", {
      reportId: report.reportId,
      result: outcome.status,
      accepted: outcome.accepted,
      dropped: outcome.dropped,
    });
  }

  async function onUpdateStatus(updates: AgentWsUpdateStatuses) {
    if (!(await store.recordUpdateStatus(serverId, sessionId, updates))) {
      stop("session_replaced", "a newer session is active");
    }
  }

  async function onAcmeDnsPresent(payload: AgentWsAcmeDnsPresentPayload) {
    if (!(await store.handleAcmeDnsPresent(serverId, sessionId, payload))) {
      stop("session_replaced", "a newer session is active");
    }
  }

  async function onAcmeDnsCleanup(payload: AgentWsAcmeDnsCleanupPayload) {
    if (!(await store.handleAcmeDnsCleanup(serverId, sessionId, payload))) {
      stop("session_replaced", "a newer session is active");
    }
  }

  async function onAcmeResult(payload: AgentWsAcmeResultPayload) {
    if (!(await store.handleAcmeResult(serverId, sessionId, payload))) {
      stop("session_replaced", "a newer session is active");
    }
  }

  async function onPtyFrame(
    frame: Extract<
      AgentWsV2Message,
      { kind: "pty.started" | "pty.data" | "pty.exit" }
    >,
  ) {
    const delivered = await options.onPtyFrame?.({
      type: frame.kind,
      payload: frame.payload,
    } as AgentWsV2PtyFrame);
    if (delivered === false && frame.kind === "pty.data") {
      send("pty.close", { sessionId: frame.payload.sessionId });
    }
  }

  async function onLogPolicyGet(payload: LogPolicyGetPayload) {
    const server = await requireCurrentServer();
    if (!server) return;
    const policy = await store.loadLogPolicy(serverId, sessionId);
    if (!policy) {
      stop("session_replaced", "a newer session is active");
      return;
    }
    send("log.policy.snapshot", {
      requestId: payload.requestId,
      revision: policy.revision,
      sources: policy.sources,
    } satisfies LogPolicySnapshotPayload);
  }

  async function onLogPolicyAck(ack: LogPolicyAckPayload) {
    const outcome = await store.recordLogPolicyAck(serverId, sessionId, ack);
    if (outcome === "replaced") {
      stop("session_replaced", "a newer session is active");
    }
  }

  async function onTelemetrySample(sample: AgentWsV2TelemetrySamplePayload) {
    options.onSample?.(sample);
    if (sample.purpose !== "history") {
      return;
    }
    const outcome = await store.recordMetricHistory(
      serverId,
      sessionId,
      sample,
    );
    if (outcome === "invalid") {
      logFailure(
        "metric history",
        new Error("sample contained no usable measurement"),
      );
    }
  }

  function onTelemetrySnapshot(snapshot: AgentWsV2TelemetrySnapshotPayload) {
    options.onSnapshot?.(snapshot);
  }

  return {
    get welcomed() {
      return welcomed;
    },

    get pending() {
      return pending;
    },

    revalidate,
    get sessionId() {
      return sessionId;
    },

    sendLogFrame(text) {
      if (closed || !welcomed) {
        return false;
      }
      try {
        peer.send(text);
        return true;
      } catch {
        return false;
      }
    },

    async handleText(text) {
      if (closed) {
        return;
      }
      await revalidate();
      if (closed) {
        return;
      }
      const parsed = parseAgentWsV2Frame(text, "agent");
      if (!parsed.ok) {
        const code =
          parsed.code === "invalid-direction"
            ? "invalid_direction"
            : parsed.code === "frame-too-large"
              ? "frame_too_large"
              : "invalid_payload";
        reject(code, `frame rejected: ${parsed.code}`, parsed.type);
        return;
      }

      const { frame, message } = parsed;
      if (message.kind === "unknown") {
        return;
      }
      if (!welcomed && message.kind !== "hello") {
        reject(
          "invalid_payload",
          "hello must precede other messages",
          message.kind,
        );
        return;
      }

      try {
        // Log frames are the admin relay's traffic. Everything else in v2 is
        // the desired-state protocol this session already owns.
        if (isLogAgentType(message.kind)) {
          await options.onLogFrame?.(text);
          return;
        }
        switch (message.kind) {
          case "hello":
            await onHello(message.payload, frame.id);
            return;
          case "agent.status":
            await onStatus(message.payload, frame.id);
            return;
          case "config.get":
            await onConfigGet(message.payload.requestId);
            return;
          case "config.ack":
            await onConfigAck(message.payload);
            return;
          case "traffic.report":
            await onTrafficReport(message.payload);
            return;
          case "update.status":
            await onUpdateStatus(message.payload);
            return;
          case "acme.dns_present":
            await onAcmeDnsPresent(message.payload);
            return;
          case "acme.dns_cleanup":
            await onAcmeDnsCleanup(message.payload);
            return;
          case "acme.result":
            await onAcmeResult(message.payload);
            return;
          case "pty.started":
          case "pty.data":
          case "pty.exit":
            await onPtyFrame(message);
            return;
          case "log.policy.get":
            await onLogPolicyGet(message.payload);
            return;
          case "log.policy.ack":
            await onLogPolicyAck(message.payload);
            return;
          case "telemetry.sample":
            await onTelemetrySample(message.payload);
            return;
          case "telemetry.snapshot":
            onTelemetrySnapshot(message.payload);
            return;
        }
      } catch (error) {
        logFailure(message.kind, error);
      }
    },

    subscribeTelemetry(payload) {
      if (closed || !welcomed) {
        return;
      }
      send("telemetry.subscribe", payload);
    },

    unsubscribeTelemetry(subscriptionId) {
      if (closed || !welcomed) {
        return;
      }
      send("telemetry.unsubscribe", { subscriptionId });
    },

    inspectTelemetry(requestId) {
      if (closed || !welcomed) {
        return;
      }
      send("telemetry.inspect", { requestId });
    },

    async close() {
      closed = true;
      await safely("end session", () => store.endSession(serverId, sessionId));
    },
  };
}
