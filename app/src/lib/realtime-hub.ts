import {
  agentWsTelemetrySnapshotPayloadSchema,
  createAgentWsFrame,
  encodeAgentWsFrame,
  type AgentWsAcmeDnsAckPayload,
  type AgentWsAcmeIssuePayload,
  parseAgentWsFrame,
  parseAgentWsPtyMessage,
  type AgentWsConfigNotifyPayload,
  type AgentWsUpdateTriggerPayload,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import {
  AGENT_WS_V2_SUBPROTOCOL,
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  type AgentWsV2TelemetrySamplePayload,
  type AgentWsV2TelemetrySnapshotPayload,
} from "@blossom/contracts/agent-ws-v2";
import type { LogPolicyNotifyPayload } from "@blossom/contracts/log-policy";
import type { ManagedLinkProbeRequest } from "@blossom/contracts/managed-link-probe";
import Redis from "ioredis";

import type { Server } from "@/db/proxy-schema";
import { getServerEnv } from "@/lib/env";
import type { AgentSessionCredential } from "@/query/agent";
import { recordLogRelayAudit, type AdminLogsActor } from "@/query/log-audit";
import { createLogAuthorityStore } from "@/query/log-authority";

import {
  telemetryReply,
  TelemetryRequests,
  type TelemetryKind,
} from "./agent-telemetry";
import {
  closeAgentWsSession,
  handleAgentWsMessage,
  openAgentWsSession,
  type AgentWsPeer,
  type AgentWsSession,
} from "./agent-ws-session";
import {
  createAgentWsStore,
  createAgentWsV2Store,
  type AgentWsV2HubStore,
} from "./agent-ws-store";
import {
  encodePtyFrameForAgentV2,
  v2PtyFrameForBrowser,
} from "./agent-ws-v2-pty";
import {
  encodeAgentWsV2ConfigNotify,
  encodeAgentWsV2LinkProbeRequest,
  encodeAgentWsV2LogPolicyNotify,
  openAgentWsV2Session,
  type AgentWsV2Session,
} from "./agent-ws-v2-session";
import {
  LIVE_METRIC_INTERVAL_MS,
  liveSampleFromV1,
  liveSampleFromV2,
  type LiveMetricSample,
} from "./live-metrics";
import type { LogAuthorityStore } from "./logs-authority";
import type { LogRelayAuditRecord } from "./logs-relay";
import type {
  AdminLogsAcceptContext,
  AgentLogRelayHandler,
} from "./logs-relay-types";
import { NitroAdminLogRelay } from "./logs-relay.nitro";
import {
  applyManagedConfigAck,
  applyManagedHello,
  applyManagedProbeResult,
  applyManagedStatus,
  dispatchManagedRolloutFollowUps,
  type ManagedRolloutFollowUp,
} from "./managed-rollout-runtime";
import {
  realtimeBackplaneChannel,
  type AgentPtyTarget,
  type RealtimeBackplane,
  type RealtimeBackplaneMessage,
  type RealtimeHub,
} from "./realtime-hub-types";

interface CrosswsMessage {
  text(): string;
}

interface CrosswsPeer extends AgentWsPeer {
  id: string;
  close(code?: number, reason?: string): void;
}

interface CrosswsHooks {
  /** Chooses the subprotocol echoed on the upgrade response, if any. */
  upgrade?(request: Request): { protocol: string };
  open(peer: CrosswsPeer): void | Promise<void>;
  message(peer: CrosswsPeer, message: CrosswsMessage): void | Promise<void>;
  close(
    peer: CrosswsPeer,
    details: { code?: number; reason?: string },
  ): void | Promise<void>;
  error(peer: CrosswsPeer, error: unknown): void | Promise<void>;
}

type CrosswsResponse = Response & { crossws?: CrosswsHooks };

const CROSSWS_HOOKS = Symbol.for("crossws.hooks");

export function attachCrosswsHooks(
  response: CrosswsResponse,
  request: Request,
  hooks: CrosswsHooks,
): CrosswsResponse {
  response.crossws = hooks;
  try {
    (request as unknown as Record<PropertyKey, unknown>)[CROSSWS_HOOKS] = hooks;
  } catch {
    // The response channel remains available when a runtime freezes requests.
  }
  return response;
}

/** Vercel bounds a function's lifetime, so agents reconnect before it ends. */
const VERCEL_RECONNECT_BEFORE_SECONDS = 240;

export function withRuntimeReconnectHint(
  welcome: AgentWsWelcomePayload,
  runtime: { vercel?: boolean } = {
    vercel: Boolean(process.env.VERCEL),
  },
): AgentWsWelcomePayload {
  return runtime.vercel
    ? { ...welcome, reconnectBeforeSeconds: VERCEL_RECONNECT_BEFORE_SECONDS }
    : welcome;
}

function reconnectBeforeSecondsForRuntime(): number | undefined {
  return process.env.VERCEL ? VERCEL_RECONNECT_BEFORE_SECONDS : undefined;
}

export class RedisBackplane implements RealtimeBackplane {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;
  private deliver?: (message: RealtimeBackplaneMessage) => void;
  private readonly subscribedServers = new Set<string>();
  private connected = false;
  private connecting?: Promise<void>;

  constructor(url: string) {
    this.publisher = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.subscriber = new Redis(url, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
    });
    this.publisher.on("error", () => undefined);
    this.subscriber.on("error", () => undefined);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        const connects: Promise<unknown>[] = [];
        if (this.publisher.status === "wait")
          connects.push(this.publisher.connect());
        if (this.subscriber.status === "wait")
          connects.push(this.subscriber.connect());
        await Promise.all(connects);
        this.subscriber.on("message", (_channel, payload) => {
          try {
            this.deliver?.(JSON.parse(payload) as RealtimeBackplaneMessage);
          } catch {
            // A malformed backplane frame is ignored; local delivery still works.
          }
        });
        this.connected = true;
      } catch (error) {
        this.connecting = undefined;
        throw error;
      }
    })();
    return this.connecting;
  }

  async subscribe(
    deliver: (message: RealtimeBackplaneMessage) => void,
    serverId?: string,
  ): Promise<void> {
    this.deliver = deliver;
    await this.ensureConnected();
    if (serverId) {
      await this.subscribeServer(serverId);
    }
  }

  async subscribeServer(serverId: string): Promise<void> {
    if (this.subscribedServers.has(serverId)) return;
    this.subscribedServers.add(serverId);
    await this.ensureConnected();
    await this.subscriber.subscribe(realtimeBackplaneChannel(serverId));
  }

  async unsubscribeServer(serverId: string): Promise<void> {
    if (!this.subscribedServers.has(serverId)) return;
    this.subscribedServers.delete(serverId);
    if (this.connected) {
      await this.subscriber
        .unsubscribe(realtimeBackplaneChannel(serverId))
        .catch(() => undefined);
    }
  }

  async publish(message: RealtimeBackplaneMessage): Promise<void> {
    await this.ensureConnected();
    await this.publisher.publish(
      realtimeBackplaneChannel(message.serverId),
      JSON.stringify(message),
    );
  }
}

type LocalConnection = {
  peer: CrosswsPeer;
  session: Promise<AgentWsSession>;
};

type LocalV2Connection = {
  peer: CrosswsPeer;
  /** `null` when the credential changed before the session could start. */
  session: Promise<AgentWsV2Session | null>;
  /** Set once `startSession` makes this connection the current v2 session. */
  sessionId: string | null;
  connectedAt: string;
  /** Set when the agent session reports that `welcome` was delivered. */
  welcomed: boolean;
  /** Periodic authoritative lease check, including the token deadline. */
  leaseTimer?: ReturnType<typeof setTimeout>;
};

export interface LiveMetricsSubscriptionContext {
  serverId: string;
  connectedAt: string;
  /** The fenced v2 session id, or null for a v1 socket. */
  sessionId: string | null;
  protocol: "v1" | "v2";
}

export type LiveMetricsHandler = (sample: LiveMetricSample) => void;

interface LiveMetricsGroup {
  context: LiveMetricsSubscriptionContext;
  handlers: Set<LiveMetricsHandler>;
  subscriptionId?: string;
  interval?: ReturnType<typeof setInterval>;
}

export type PtyRelayEvent =
  | { type: "frame"; frame: string }
  | { type: "agent_disconnected" };

export type PtyRelayHandler = (event: PtyRelayEvent) => void;

interface LocalPtyRelay {
  target: AgentPtyTarget;
  handler: PtyRelayHandler;
}

function samePtyTarget(left: AgentPtyTarget, right: AgentPtyTarget): boolean {
  if (left.protocol !== right.protocol) {
    return false;
  }
  return left.protocol === "v2"
    ? Boolean(
        left.agentSessionId &&
        right.agentSessionId &&
        left.agentSessionId === right.agentSessionId,
      )
    : left.connectedAt === right.connectedAt;
}

function ptyTargetFromBackplane(
  message: RealtimeBackplaneMessage,
): AgentPtyTarget | null {
  if (message.agentProtocol === "v2") {
    return message.agentSessionId && message.connectedAt
      ? {
          protocol: "v2",
          connectedAt: message.connectedAt,
          agentSessionId: message.agentSessionId,
        }
      : null;
  }
  return message.connectedAt
    ? {
        protocol: "v1",
        connectedAt: message.connectedAt,
        agentSessionId: null,
      }
    : null;
}

interface LocalLogRelay {
  sessionId: string;
  handler: AgentLogRelayHandler;
}

export class NitroRealtimeHub implements RealtimeHub {
  readonly id = crypto.randomUUID();
  private readonly connections = new Map<string, Set<LocalConnection>>();
  private readonly v2Connections = new Map<string, Set<LocalV2Connection>>();
  /** The newest v2 session this instance started for a server. */
  private readonly currentV2Sessions = new Map<string, LocalV2Connection>();
  private readonly ptyRelays = new Map<string, Map<string, LocalPtyRelay>>();
  private readonly logRelays = new Map<string, Map<string, LocalLogRelay>>();
  private readonly backplane: RealtimeBackplane | undefined;
  private readonly store: ReturnType<typeof createAgentWsStore>;
  private readonly v2Store: AgentWsV2HubStore;
  private readonly logAuthority: LogAuthorityStore;
  private readonly logAudit: (
    serverId: string,
    actor: AdminLogsActor,
    record: LogRelayAuditRecord,
  ) => Promise<void>;
  private readonly telemetry = new TelemetryRequests();
  private readonly liveMetrics = new Map<string, LiveMetricsGroup>();
  private readonly pendingSnapshots = new Map<
    string,
    (snapshot: unknown) => void
  >();
  private backplaneReady: Promise<void> | undefined;

  constructor(
    options: {
      backplane?: RealtimeBackplane;
      store?: ReturnType<typeof createAgentWsStore>;
      v2Store?: AgentWsV2HubStore;
      logAuthority?: LogAuthorityStore;
      logAudit?: (
        serverId: string,
        actor: AdminLogsActor,
        record: LogRelayAuditRecord,
      ) => Promise<void>;
    } = {},
  ) {
    this.backplane = options.backplane ?? defaultBackplane();
    this.store = options.store ?? createAgentWsStore();
    this.v2Store = options.v2Store ?? createAgentWsV2Store();
    this.logAuthority = options.logAuthority ?? createLogAuthorityStore();
    this.logAudit =
      options.logAudit ??
      ((serverId, actor, record) =>
        recordLogRelayAudit({ serverId, actor, record }));
  }

  async acceptAgent(
    request: Request,
    server: Server,
    welcome: AgentWsWelcomePayload,
  ): Promise<Response> {
    const effectiveWelcome = withRuntimeReconnectHint(welcome);
    const hooks = this.createHooks(server.id, effectiveWelcome);
    return attachCrosswsHooks(
      new Response(null, {
        status: 426,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      }),
      request,
      hooks,
    );
  }

  async acceptAgentV2(
    request: Request,
    server: Server,
    credential: AgentSessionCredential,
  ): Promise<Response> {
    return attachCrosswsHooks(
      new Response(null, {
        status: 426,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      }),
      request,
      this.createV2Hooks(server.id, credential),
    );
  }

  async acceptAdminLogs(
    request: Request,
    context: AdminLogsAcceptContext,
  ): Promise<Response> {
    let relay: NitroAdminLogRelay | undefined;
    let unregister: (() => void) | undefined;
    const forget = () => {
      unregister?.();
      unregister = undefined;
    };
    return attachCrosswsHooks(
      new Response(null, {
        status: 426,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      }),
      request,
      {
        open: (peer) => {
          relay = new NitroAdminLogRelay({
            context,
            authority: this.logAuthority,
            audit: (record) =>
              this.logAudit(context.serverId, context.actor, record),
            port: {
              sendToBrowser: (frame) => {
                peer.send(frame);
              },
              sendToAgent: (frame) =>
                this.sendLogFrame(
                  context.serverId,
                  context.agentSessionId,
                  frame,
                ),
              close: (code, reason) => {
                forget();
                peer.close(code, reason);
              },
            },
          });
          unregister = this.registerLogRelay(
            context.serverId,
            context.agentSessionId,
            context.relayId,
            (event) => {
              if (event.type === "frame") {
                relay?.handleAgentFrame(event.frame);
                return;
              }
              relay?.handleAgentGone(event.reason);
            },
          );
          relay.start();
        },
        message: (_peer, message) => {
          relay?.handleBrowser(message.text());
        },
        close: () => {
          forget();
          relay?.handleBrowserClosed();
        },
        error: (peer, error) => {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(
            `admin log websocket error for ${context.serverId} (${peer.id}): ${message}`,
          );
        },
      },
    );
  }

  private createV2Hooks(
    serverId: string,
    credential: AgentSessionCredential,
  ): CrosswsHooks {
    return {
      upgrade: () => ({ protocol: AGENT_WS_V2_SUBPROTOCOL }),
      open: async (peer) => {
        const connection: LocalV2Connection = {
          peer,
          session: Promise.resolve(null),
          sessionId: null,
          connectedAt: "",
          welcomed: false,
        };
        const session = (async () => {
          const started = await this.v2Store.startSession(serverId, credential);
          if (!started) {
            return null;
          }
          this.supersedeLogRelays(serverId, started.sessionId);
          const opened = openAgentWsV2Session({
            serverId,
            sessionId: started.sessionId,
            credential,
            pending: started.pending,
            peer,
            store: this.v2Store,
            reconnectBeforeSeconds: reconnectBeforeSecondsForRuntime(),
            onPtyFrame: (frame) =>
              this.deliverV2PtyFrame(serverId, started.sessionId, frame),
            onLogFrame: (text) =>
              this.deliverLogAgentFrame(serverId, started.sessionId, text),
            onSample: (sample) =>
              this.acceptV2MetricSample(serverId, started.sessionId, sample),
            onSnapshot: (snapshot) =>
              this.acceptV2MetricSnapshot(
                serverId,
                started.sessionId,
                snapshot,
              ),
            onWelcome: () => {
              connection.welcomed = true;
              this.resubscribeLiveMetrics(serverId, started.sessionId);
            },
            onManagedHello: async (report) => {
              await this.dispatchManagedRollout(
                await applyManagedHello(report),
              );
            },
            onManagedStatus: async (report) => {
              await this.dispatchManagedRollout(
                await applyManagedStatus(report),
              );
            },
            onManagedConfigAck: async (report) => {
              await this.dispatchManagedRollout(
                await applyManagedConfigAck(report),
              );
            },
            onManagedProbeResult: async (report) => {
              await this.dispatchManagedRollout(
                await applyManagedProbeResult(report),
              );
            },
          });
          connection.sessionId = started.sessionId;
          connection.connectedAt = started.connectedAt.toISOString();
          this.currentV2Sessions.set(serverId, connection);
          return opened;
        })();
        let peers = this.v2Connections.get(serverId);
        if (!peers) {
          peers = new Set();
          this.v2Connections.set(serverId, peers);
        }
        connection.session = session;
        peers.add(connection);
        this.startBackplane(serverId);
        try {
          const opened = await session;
          if (!opened) {
            this.removeV2Connection(serverId, peer);
            peer.close(1008, "credential changed");
            return;
          }
          const startedExpiresAt =
            credential.kind === "oauth" ? credential.expiresAt : null;
          this.scheduleV2Lease(serverId, connection, startedExpiresAt);
        } catch (error) {
          this.removeV2Connection(serverId, peer);
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`agent websocket v2 open failed: ${message}`);
          peer.close(1011, "session unavailable");
        }
      },
      message: async (peer, message) => {
        const connection = this.findV2Connection(serverId, peer);
        if (!connection) {
          return;
        }
        const session = await connection.session;
        await session?.handleText(message.text());
      },
      close: async (peer) => {
        const connection = this.removeV2Connection(serverId, peer);
        if (!connection) {
          return;
        }
        if (connection.sessionId) {
          this.closePtyRelays(serverId, {
            protocol: "v2",
            connectedAt: connection.connectedAt,
            agentSessionId: connection.sessionId,
          });
          if (this.backplane) {
            void this.backplane
              .publish({
                origin: this.id,
                serverId,
                frame: "",
                connectedAt: connection.connectedAt,
                agentProtocol: "v2",
                agentSessionId: connection.sessionId,
                ptyTarget: "browser",
                agentDisconnected: true,
              })
              .catch(() => undefined);
          }
          this.closeLogRelays(
            serverId,
            connection.sessionId,
            "agent_disconnected",
          );
          this.publishBackplane(() => ({
            origin: this.id,
            serverId,
            frame: "",
            logTarget: "browser",
            logSessionId: connection.sessionId!,
            logAgentGone: true,
          }));
        }
        const session = await connection.session.catch(() => undefined);
        await session?.close();
      },
      error: (peer, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `agent websocket v2 error for ${serverId} (${peer.id}): ${message}`,
        );
      },
    };
  }

  private findV2Connection(
    serverId: string,
    peer: CrosswsPeer,
  ): LocalV2Connection | undefined {
    return [...(this.v2Connections.get(serverId) ?? [])].find(
      (connection) => connection.peer === peer,
    );
  }

  private removeV2Connection(
    serverId: string,
    peer: CrosswsPeer,
  ): LocalV2Connection | undefined {
    const peers = this.v2Connections.get(serverId);
    const connection = this.findV2Connection(serverId, peer);
    if (connection) {
      if (connection.leaseTimer) {
        clearTimeout(connection.leaseTimer);
        connection.leaseTimer = undefined;
      }
      peers?.delete(connection);
      if (peers?.size === 0) {
        this.v2Connections.delete(serverId);
      }
      if (this.currentV2Sessions.get(serverId) === connection) {
        this.currentV2Sessions.delete(serverId);
      }
      this.maybeUnsubscribeServer(serverId);
    }
    return connection;
  }

  /**
   * Re-checks the authoritative session and credential every 30 seconds (or at
   * the machine token deadline). The check closes an idle socket after
   * revocation, rotation, disablement, or token expiry even when no frames
   * arrive.
   */
  private scheduleV2Lease(
    serverId: string,
    connection: LocalV2Connection,
    expiresAt: number | null,
  ): void {
    if (connection.leaseTimer) {
      clearTimeout(connection.leaseTimer);
    }
    const untilExpiry =
      expiresAt === null
        ? Number.POSITIVE_INFINITY
        : expiresAt * 1000 - Date.now();
    const delay = Math.max(1_000, Math.min(30_000, untilExpiry));
    connection.leaseTimer = setTimeout(() => {
      connection.leaseTimer = undefined;
      void (async () => {
        const session = await connection.session.catch(() => null);
        if (!session) {
          return;
        }
        await session.revalidate();
        if (this.findV2Connection(serverId, connection.peer) === connection) {
          this.scheduleV2Lease(serverId, connection, expiresAt);
        }
      })();
    }, delay);
    connection.leaseTimer.unref?.();
  }

  /**
   * Delivers a v2 push only to the current, welcomed session. An older socket
   * that has not observed its replacement yet must not see configuration,
   * update, ACME, or terminal traffic for the newer session.
   */
  private deliverV2(
    serverId: string,
    frame: string,
    agentSessionId?: string,
  ): void {
    const connection = this.currentV2Sessions.get(serverId);
    if (
      !connection?.sessionId ||
      (agentSessionId !== undefined && connection.sessionId !== agentSessionId)
    ) {
      return;
    }
    void connection.session
      .then((session) => {
        if (session?.welcomed) {
          connection.peer.send(frame);
        }
      })
      .catch(() => undefined);
  }

  private publishV2(serverId: string, frame: string): void {
    const agentSessionId = this.currentV2Sessions.get(serverId)?.sessionId;
    if (agentSessionId) {
      this.deliverV2(serverId, frame, agentSessionId);
    }
    const backplane = this.backplane;
    if (!backplane) return;
    const ready = this.startBackplane();
    const relay = () =>
      backplane.publish({
        origin: this.id,
        serverId,
        frame,
        protocol: "v2",
        ...(agentSessionId ? { agentSessionId } : {}),
      });
    void (ready ? ready.then(relay) : relay()).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`realtime backplane publish failed: ${reason}`);
    });
  }

  /**
   * One sampler per server/session, shared by every admin viewer on this
   * instance. v1 is polled at the coalesced interval; v2 subscribes once and
   * streams samples from the agent.
   */
  subscribeLiveMetrics(
    context: LiveMetricsSubscriptionContext,
    handler: LiveMetricsHandler,
  ): () => void {
    if (this.backplane) {
      this.startBackplane(context.serverId);
    }
    const key = liveMetricsKey(context);
    let group = this.liveMetrics.get(key);
    if (!group) {
      group = { context, handlers: new Set() };
      this.liveMetrics.set(key, group);
      if (context.protocol === "v2" && context.sessionId) {
        group.subscriptionId = `live-${this.id}-${context.sessionId}`;
        this.sendV2TelemetrySubscription(context, group.subscriptionId);
      } else {
        this.startV1LiveSampling(key, group);
      }
    }
    group.handlers.add(handler);

    return () => {
      const current = this.liveMetrics.get(key);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size > 0) return;
      this.liveMetrics.delete(key);
      if (current.interval) clearInterval(current.interval);
      if (current.subscriptionId) {
        this.sendV2TelemetryUnsubscribe(
          current.context,
          current.subscriptionId,
        );
      }
      this.maybeUnsubscribeServer(current.context.serverId);
    };
  }

  private resubscribeLiveMetrics(serverId: string, sessionId: string): void {
    const group = this.liveMetrics.get(
      liveMetricsKey({
        serverId,
        sessionId,
        connectedAt: "",
        protocol: "v2",
      }),
    );
    if (!group?.subscriptionId) return;
    this.sendV2TelemetrySubscription(group.context, group.subscriptionId);
  }

  private startV1LiveSampling(key: string, group: LiveMetricsGroup): void {
    const { serverId, connectedAt } = group.context;
    const tick = () => {
      void this.requestTelemetry(serverId, "sample", connectedAt)
        .then((reply) => {
          const current = this.liveMetrics.get(key);
          if (!current || reply?.kind !== "sample") return;
          const sample = liveSampleFromV1(reply.data, Date.now());
          for (const handler of current.handlers) handler(sample);
        })
        .catch(() => undefined);
    };
    group.interval = setInterval(tick, LIVE_METRIC_INTERVAL_MS);
    (group.interval as { unref?: () => void }).unref?.();
    tick();
  }

  private sendV2TelemetrySubscription(
    context: LiveMetricsSubscriptionContext,
    subscriptionId: string,
  ): void {
    if (!context.sessionId) return;
    const payload = {
      subscriptionId,
      purpose: "live" as const,
      intervalMs: LIVE_METRIC_INTERVAL_MS,
    };
    this.publishV2(
      context.serverId,
      encodeAgentWsV2Frame(
        createAgentWsV2Frame("telemetry.subscribe", payload),
      ),
    );
  }

  private sendV2TelemetryUnsubscribe(
    context: LiveMetricsSubscriptionContext,
    subscriptionId: string,
  ): void {
    if (!context.sessionId) return;
    const payload = { subscriptionId };
    this.publishV2(
      context.serverId,
      encodeAgentWsV2Frame(
        createAgentWsV2Frame("telemetry.unsubscribe", payload),
      ),
    );
  }

  private acceptV2MetricSample(
    serverId: string,
    sessionId: string,
    sample: AgentWsV2TelemetrySamplePayload,
  ): void {
    if (sample.purpose !== "live") return;
    const normalized = liveSampleFromV2(sample);
    this.deliverLiveMetric(serverId, sessionId, normalized);
    const backplane = this.backplane;
    if (!backplane) return;
    const ready = this.startBackplane();
    const relay = () =>
      backplane.publish({
        origin: this.id,
        serverId,
        frame: "",
        liveMetricSample: normalized,
        liveMetricSessionId: sessionId,
      });
    void (ready ? ready.then(relay) : relay()).catch(() => undefined);
  }

  private acceptV2MetricSnapshot(
    serverId: string,
    _sessionId: string,
    snapshot: AgentWsV2TelemetrySnapshotPayload,
  ): void {
    this.resolveSnapshot(snapshot.requestId, snapshot);
    const backplane = this.backplane;
    if (!backplane) return;
    const ready = this.startBackplane();
    const relay = () =>
      backplane.publish({
        origin: this.id,
        serverId,
        frame: "",
        agentSnapshot: {
          requestId: snapshot.requestId,
          snapshot,
        },
      });
    void (ready ? ready.then(relay) : relay()).catch(() => undefined);
  }

  private deliverLiveMetric(
    serverId: string,
    sessionId: string,
    sample: LiveMetricSample,
  ): void {
    const key = liveMetricsKey({
      serverId,
      sessionId,
      connectedAt: "",
      protocol: "v2",
    });
    const group = this.liveMetrics.get(key);
    if (!group) return;
    for (const handler of group.handlers) handler(sample);
  }

  private resolveSnapshot(requestId: string, snapshot: unknown): void {
    const finish = this.pendingSnapshots.get(requestId);
    if (!finish) return;
    this.pendingSnapshots.delete(requestId);
    finish(snapshot);
  }

  private createHooks(
    serverId: string,
    welcome: AgentWsWelcomePayload,
  ): CrosswsHooks {
    return {
      open: async (peer) => {
        const session = openAgentWsSession({
          serverId,
          welcome,
          store: this.store,
        });
        let peers = this.connections.get(serverId);
        if (!peers) {
          peers = new Set();
          this.connections.set(serverId, peers);
        }
        peers.add({ peer, session });
        await session;
        this.startBackplane(serverId);
      },
      message: async (peer, message) => {
        const connection = this.findConnection(serverId, peer);
        if (!connection) {
          return;
        }
        const session = await connection.session;
        const raw = message.text();
        if (
          this.routePtyFrame(serverId, session.connectedAt.toISOString(), raw)
        ) {
          return;
        }
        const reply = telemetryReply(raw);
        if (reply) {
          if (!session.welcomeSent) return;
          const connectedAt = session.connectedAt.toISOString();
          this.telemetry.accept(JSON.stringify([serverId, connectedAt]), reply);
          // Relay only the parsed fields.
          if (this.backplane) {
            const frame = encodeAgentWsFrame(
              createAgentWsFrame(`telemetry.${reply.kind}`, reply.data),
            );
            void this.backplane
              .publish({
                origin: this.id,
                serverId,
                frame,
                telemetryReply: true,
                connectedAt,
              })
              .catch(() => {});
          }
          return;
        }
        await handleAgentWsMessage(session, peer, raw);
      },
      close: async (peer) => {
        const connection = this.removeConnection(serverId, peer);
        if (!connection) {
          return;
        }
        const session = await connection.session;
        const connectedAt = session.connectedAt.toISOString();
        this.closePtyRelays(serverId, {
          protocol: "v1",
          connectedAt,
          agentSessionId: null,
        });
        if (this.backplane) {
          void this.backplane
            .publish({
              origin: this.id,
              serverId,
              frame: "",
              connectedAt,
              ptyTarget: "browser",
              agentDisconnected: true,
            })
            .catch(() => undefined);
        }
        await closeAgentWsSession(session);
      },
      error: (peer, error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `agent websocket error for ${serverId} (${peer.id}): ${message}`,
        );
      },
    };
  }

  private findConnection(
    serverId: string,
    peer: CrosswsPeer,
  ): LocalConnection | undefined {
    return [...(this.connections.get(serverId) ?? [])].find(
      (connection) => connection.peer === peer,
    );
  }

  private removeConnection(
    serverId: string,
    peer: CrosswsPeer,
  ): LocalConnection | undefined {
    const peers = this.connections.get(serverId);
    const connection = [...(peers ?? [])].find(
      (candidate) => candidate.peer === peer,
    );
    if (connection) {
      peers?.delete(connection);
      if (peers?.size === 0) {
        this.connections.delete(serverId);
        this.maybeUnsubscribeServer(serverId);
      }
    }
    return connection;
  }

  private async findConnectionByConnectedAt(
    serverId: string,
    connectedAt: string,
  ): Promise<LocalConnection | undefined> {
    for (const connection of this.connections.get(serverId) ?? []) {
      const session = await connection.session;
      if (session.connectedAt.toISOString() === connectedAt) {
        return connection;
      }
    }
    return undefined;
  }

  private findV2ConnectionBySession(
    serverId: string,
    sessionId: string,
  ): LocalV2Connection | undefined {
    const current = this.currentV2Sessions.get(serverId);
    return current?.sessionId === sessionId ? current : undefined;
  }

  async hasAgentConnection(
    serverId: string,
    target: AgentPtyTarget,
  ): Promise<boolean> {
    if (target.protocol === "v2") {
      return (
        Boolean(
          target.agentSessionId &&
          this.findV2ConnectionBySession(serverId, target.agentSessionId),
        ) || Boolean(this.backplane)
      );
    }
    return (
      Boolean(
        await this.findConnectionByConnectedAt(serverId, target.connectedAt),
      ) || Boolean(this.backplane)
    );
  }

  registerPtyRelay(
    serverId: string,
    target: AgentPtyTarget,
    sessionId: string,
    handler: PtyRelayHandler,
  ): () => void {
    let relays = this.ptyRelays.get(serverId);
    if (!relays) {
      relays = new Map();
      this.ptyRelays.set(serverId, relays);
    }
    const relay = { target, handler };
    relays.set(sessionId, relay);
    this.startBackplane(serverId);
    return () => {
      const current = this.ptyRelays.get(serverId);
      if (current?.get(sessionId) === relay) {
        current.delete(sessionId);
        if (current.size === 0) {
          this.ptyRelays.delete(serverId);
          this.maybeUnsubscribeServer(serverId);
        }
      }
    };
  }

  countPtyRelays(serverId: string): number {
    return this.ptyRelays.get(serverId)?.size ?? 0;
  }

  hasPtyRelay(serverId: string, sessionId: string): boolean {
    return Boolean(this.ptyRelays.get(serverId)?.has(sessionId));
  }

  async sendPtyFrame(
    serverId: string,
    target: AgentPtyTarget,
    ptySessionId: string,
    browserFrame: string,
  ): Promise<boolean> {
    let agentFrame = browserFrame;
    if (target.protocol === "v2") {
      const parsed = parseAgentWsFrame(browserFrame);
      const encoded = parsed.ok ? encodePtyFrameForAgentV2(parsed.frame) : null;
      if (!encoded) {
        return false;
      }
      agentFrame = encoded;
    }
    if (target.protocol === "v2") {
      const connection = target.agentSessionId
        ? this.findV2ConnectionBySession(serverId, target.agentSessionId)
        : undefined;
      if (connection) {
        try {
          connection.peer.send(agentFrame);
          return true;
        } catch {
          return false;
        }
      }
      return this.relayPtyFrame(serverId, target, ptySessionId, agentFrame);
    }
    const connection = await this.findConnectionByConnectedAt(
      serverId,
      target.connectedAt,
    );
    if (connection) {
      try {
        connection.peer.send(agentFrame);
        return true;
      } catch {
        return false;
      }
    }
    if (!this.backplane) {
      return false;
    }
    return this.relayPtyFrame(serverId, target, ptySessionId, agentFrame);
  }

  private async relayPtyFrame(
    serverId: string,
    target: AgentPtyTarget,
    ptySessionId: string,
    frame: string,
  ): Promise<boolean> {
    const backplane = this.backplane;
    if (!backplane) {
      return false;
    }
    try {
      await this.startBackplane();
      await backplane.publish({
        origin: this.id,
        serverId,
        frame,
        connectedAt: target.connectedAt,
        agentProtocol: target.protocol,
        ...(target.agentSessionId
          ? { agentSessionId: target.agentSessionId }
          : {}),
        ptyTarget: "agent",
        ptySessionId,
      });
      return true;
    } catch {
      return false;
    }
  }

  private routePtyFrame(
    serverId: string,
    connectedAt: string,
    raw: string,
  ): boolean {
    const parsed = parseAgentWsFrame(raw);
    if (!parsed.ok || !parsed.frame.type.startsWith("pty.")) {
      return false;
    }
    const message = parseAgentWsPtyMessage(
      parsed.frame.type,
      parsed.frame.payload,
    );
    if (!message?.ok) {
      return true;
    }
    const frame = encodeAgentWsFrame(
      createAgentWsFrame(message.message.type, message.message.payload),
    );
    this.deliverPtyFrame(
      serverId,
      { protocol: "v1", connectedAt, agentSessionId: null },
      message.message.payload.sessionId,
      frame,
    );
    if (this.backplane) {
      void this.backplane
        .publish({
          origin: this.id,
          serverId,
          frame,
          connectedAt,
          agentProtocol: "v1",
          ptyTarget: "browser",
          ptySessionId: message.message.payload.sessionId,
        })
        .catch(() => undefined);
    }
    return true;
  }

  /**
   * Routes an agent v2 `pty.*` frame to the browser relay bound to that same
   * agent session. A relay for any other session is never considered.
   */
  private deliverV2PtyFrame(
    serverId: string,
    agentSessionId: string,
    frame: {
      type: "pty.started" | "pty.data" | "pty.exit";
      payload: unknown;
    },
  ): boolean {
    const connection = this.findV2ConnectionBySession(serverId, agentSessionId);
    if (!connection) {
      return false;
    }
    const browserFrame = v2PtyFrameForBrowser(frame.type, frame.payload);
    if (!browserFrame) {
      return false;
    }
    const payload = frame.payload as { sessionId?: unknown };
    const ptySessionId =
      typeof payload.sessionId === "string" ? payload.sessionId : "";
    if (!ptySessionId) {
      return false;
    }
    this.deliverPtyFrame(
      serverId,
      {
        protocol: "v2",
        connectedAt: connection.connectedAt,
        agentSessionId,
      },
      ptySessionId,
      browserFrame,
    );
    if (this.backplane) {
      void this.backplane
        .publish({
          origin: this.id,
          serverId,
          frame: browserFrame,
          connectedAt: connection.connectedAt,
          agentProtocol: "v2",
          agentSessionId,
          ptyTarget: "browser",
          ptySessionId,
        })
        .catch(() => undefined);
    }
    return Boolean(
      this.ptyRelays.get(serverId)?.get(ptySessionId)?.target.agentSessionId ===
      agentSessionId,
    );
  }

  private deliverPtyFrame(
    serverId: string,
    target: AgentPtyTarget,
    ptySessionId: string,
    frame: string,
  ): void {
    const relay = this.ptyRelays.get(serverId)?.get(ptySessionId);
    if (!relay || !samePtyTarget(relay.target, target)) {
      return;
    }
    try {
      relay.handler({ type: "frame", frame });
    } catch {
      // A broken browser relay is closed by its own hook.
    }
  }

  private closePtyRelays(serverId: string, target: AgentPtyTarget): void {
    const relays = this.ptyRelays.get(serverId);
    if (!relays) {
      return;
    }
    for (const [sessionId, relay] of relays) {
      if (!samePtyTarget(relay.target, target)) {
        continue;
      }
      relays.delete(sessionId);
      try {
        relay.handler({ type: "agent_disconnected" });
      } catch {
        // The relay is being discarded anyway.
      }
    }
    if (relays.size === 0) {
      this.ptyRelays.delete(serverId);
    }
  }

  /**
   * Binds one browser-side log relay to the agent session it was admitted
   * against. The returned function removes it; a closed relay calls it before
   * closing the browser socket.
   */
  registerLogRelay(
    serverId: string,
    sessionId: string,
    relayId: string,
    handler: AgentLogRelayHandler,
  ): () => void {
    let relays = this.logRelays.get(serverId);
    if (!relays) {
      relays = new Map();
      this.logRelays.set(serverId, relays);
    }
    const relay: LocalLogRelay = { sessionId, handler };
    relays.set(relayId, relay);
    // Agent frames arrive from the instance that owns the agent socket even
    // when this browser is alone on its own instance, so subscribe eagerly.
    this.startBackplane(serverId);
    return () => {
      const current = this.logRelays.get(serverId);
      if (current?.get(relayId) === relay) {
        current.delete(relayId);
        if (current.size === 0) {
          this.logRelays.delete(serverId);
          this.maybeUnsubscribeServer(serverId);
        }
      }
    };
  }

  /**
   * Sends one encoded control frame to the agent session named at admission.
   * A missing local session falls back to the Redis backplane; without one,
   * the relay reports the agent as offline.
   */
  sendLogFrame(serverId: string, sessionId: string, frame: string): boolean {
    const connection = [...(this.v2Connections.get(serverId) ?? [])].find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (connection) {
      if (!connection.welcomed) {
        return false;
      }
      try {
        connection.peer.send(frame);
        return true;
      } catch {
        return false;
      }
    }
    if (!this.backplane) {
      return false;
    }
    const backplane = this.backplane;
    this.publishBackplane(() => ({
      origin: this.id,
      serverId,
      frame,
      logTarget: "agent",
      logSessionId: sessionId,
    }));
    return Boolean(backplane);
  }

  /** Routes an agent log frame to local relays and to other instances. */
  private deliverLogAgentFrame(
    serverId: string,
    sessionId: string,
    frame: string,
  ): void {
    this.deliverLocalLogAgentFrame(serverId, sessionId, frame);
    this.publishBackplane(() => ({
      origin: this.id,
      serverId,
      frame,
      logTarget: "browser",
      logSessionId: sessionId,
    }));
  }

  private deliverLocalLogAgentFrame(
    serverId: string,
    sessionId: string,
    frame: string,
  ): void {
    for (const relay of this.logRelays.get(serverId)?.values() ?? []) {
      if (relay.sessionId !== sessionId) {
        continue;
      }
      try {
        relay.handler({ type: "frame", frame });
      } catch {
        // A broken browser relay closes itself through its own hook.
      }
    }
  }

  /** Ends every local relay bound to a session that is no longer authoritative. */
  private closeLogRelays(
    serverId: string,
    sessionId: string,
    reason: "agent_disconnected" | "session_replaced",
  ): void {
    const relays = this.logRelays.get(serverId);
    if (!relays) {
      return;
    }
    for (const [relayId, relay] of relays) {
      if (relay.sessionId !== sessionId) {
        continue;
      }
      relays.delete(relayId);
      try {
        relay.handler({ type: "agentGone", reason });
      } catch {
        // The relay is being discarded anyway.
      }
    }
    if (relays.size === 0) {
      this.logRelays.delete(serverId);
    }
  }

  /**
   * A new agent handshake makes older sessions non-authoritative in the same
   * database statement, so relays bound to them end immediately instead of
   * waiting for the next authority check.
   */
  private supersedeLogRelays(serverId: string, newSessionId: string): void {
    const relays = this.logRelays.get(serverId);
    if (relays) {
      for (const [relayId, relay] of relays) {
        if (relay.sessionId === newSessionId) {
          continue;
        }
        relays.delete(relayId);
        try {
          relay.handler({ type: "agentGone", reason: "session_replaced" });
        } catch {
          // The relay is being discarded anyway.
        }
      }
      if (relays.size === 0) {
        this.logRelays.delete(serverId);
      }
    }
    this.publishBackplane(() => ({
      origin: this.id,
      serverId,
      frame: "",
      logTarget: "browser",
      logSessionId: newSessionId,
      logSuperseded: true,
    }));
  }

  private closeSupersededRemoteRelays(
    serverId: string,
    newSessionId: string,
  ): void {
    const relays = this.logRelays.get(serverId);
    if (!relays) {
      return;
    }
    for (const [relayId, relay] of relays) {
      if (relay.sessionId === newSessionId) {
        continue;
      }
      relays.delete(relayId);
      try {
        relay.handler({ type: "agentGone", reason: "session_replaced" });
      } catch {
        // The relay is being discarded anyway.
      }
    }
    if (relays.size === 0) {
      this.logRelays.delete(serverId);
    }
  }

  private sendLocalLogFrame(
    serverId: string,
    sessionId: string,
    frame: string,
  ): void {
    const connection = [...(this.v2Connections.get(serverId) ?? [])].find(
      (candidate) => candidate.sessionId === sessionId,
    );
    if (!connection?.welcomed) {
      return;
    }
    try {
      connection.peer.send(frame);
    } catch {
      // The agent close hook ends the relays bound to this session.
    }
  }

  private publishBackplane(message: () => RealtimeBackplaneMessage): void {
    const backplane = this.backplane;
    if (!backplane) {
      return;
    }
    const ready = this.startBackplane();
    const send = () => backplane.publish(message());
    void (ready ? ready.then(send) : send()).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`realtime backplane publish failed: ${reason}`);
    });
  }

  private startBackplane(serverId?: string): Promise<void> | undefined {
    if (!this.backplane) {
      return undefined;
    }
    if (!this.backplaneReady) {
      this.backplaneReady = this.backplane
        .subscribe((message) => {
          this.handleBackplaneMessage(message);
        }, serverId)
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`realtime backplane subscribe failed: ${reason}`);
        });
    }
    if (serverId && this.backplane.subscribeServer) {
      void this.backplaneReady
        .then(() => {
          void this.backplane?.subscribeServer?.(serverId);
        })
        .catch((error: unknown) => {
          const reason = error instanceof Error ? error.message : String(error);
          console.warn(`realtime backplane subscribeServer failed: ${reason}`);
        });
    }
    return this.backplaneReady;
  }

  private maybeUnsubscribeServer(serverId: string): void {
    if (
      !this.connections.has(serverId) &&
      !this.v2Connections.has(serverId) &&
      !this.ptyRelays.has(serverId) &&
      !this.logRelays.has(serverId) &&
      ![...this.liveMetrics.values()].some(
        (group) => group.context.serverId === serverId,
      )
    ) {
      void this.backplane?.unsubscribeServer?.(serverId);
    }
  }

  private handleBackplaneMessage(message: RealtimeBackplaneMessage): void {
    if (message.origin === this.id) {
      return;
    }
    if (message.logTarget === "browser" && message.logSessionId) {
      if (message.logSuperseded) {
        this.closeSupersededRemoteRelays(
          message.serverId,
          message.logSessionId,
        );
        return;
      }
      if (message.logAgentGone) {
        this.closeLogRelays(
          message.serverId,
          message.logSessionId,
          "agent_disconnected",
        );
        return;
      }
      this.deliverLocalLogAgentFrame(
        message.serverId,
        message.logSessionId,
        message.frame,
      );
      return;
    }
    if (message.logTarget === "agent" && message.logSessionId) {
      this.sendLocalLogFrame(
        message.serverId,
        message.logSessionId,
        message.frame,
      );
      return;
    }
    if (message.protocol === "v2") {
      this.deliverV2(message.serverId, message.frame, message.agentSessionId);
      return;
    }
    if (message.agentDisconnected) {
      const target = ptyTargetFromBackplane(message);
      if (target) {
        this.closePtyRelays(message.serverId, target);
      }
      return;
    }
    if (message.liveMetricSample && message.liveMetricSessionId) {
      this.deliverLiveMetric(
        message.serverId,
        message.liveMetricSessionId,
        message.liveMetricSample,
      );
      return;
    }
    if (message.agentSnapshot) {
      this.resolveSnapshot(
        message.agentSnapshot.requestId,
        message.agentSnapshot.snapshot,
      );
      return;
    }
    if (message.ptyTarget === "browser" && message.ptySessionId) {
      const target = ptyTargetFromBackplane(message);
      if (!target) {
        return;
      }
      this.deliverPtyFrame(
        message.serverId,
        target,
        message.ptySessionId,
        message.frame,
      );
      return;
    }
    if (message.ptyTarget === "agent" && message.connectedAt) {
      const target = ptyTargetFromBackplane(message);
      if (target?.protocol === "v2") {
        const connection = target.agentSessionId
          ? this.findV2ConnectionBySession(
              message.serverId,
              target.agentSessionId,
            )
          : undefined;
        if (connection) {
          void connection.session
            .then((session) => {
              if (session?.welcomed) {
                connection.peer.send(message.frame);
              }
            })
            .catch(() => undefined);
        }
      } else {
        void this.sendLocalAgentFrame(
          message.serverId,
          message.connectedAt,
          message.frame,
        );
      }
      return;
    }
    if (message.telemetryReply) {
      const reply = telemetryReply(message.frame);
      if (reply && message.connectedAt)
        this.telemetry.accept(
          JSON.stringify([message.serverId, message.connectedAt]),
          reply,
        );
      return;
    }
    this.sendLocal(message.serverId, message.frame, message.connectedAt);
  }

  private sendLocal(
    serverId: string,
    frame: string,
    connectedAt?: string,
  ): void {
    for (const { peer, session } of this.connections.get(serverId) ?? []) {
      if (connectedAt) {
        void session
          .then((state) => {
            if (
              state.welcomeSent &&
              state.connectedAt.toISOString() === connectedAt
            )
              peer.send(frame);
          })
          .catch(() => {});
        continue;
      }
      try {
        peer.send(frame);
      } catch {
        // A stale peer is removed by its close hook.
      }
    }
  }

  private async sendLocalAgentFrame(
    serverId: string,
    connectedAt: string,
    frame: string,
  ): Promise<void> {
    const connection = await this.findConnectionByConnectedAt(
      serverId,
      connectedAt,
    );
    if (!connection) {
      if (this.backplane) {
        void this.backplane
          .publish({
            origin: this.id,
            serverId,
            frame: "",
            connectedAt,
            ptyTarget: "browser",
            agentDisconnected: true,
          })
          .catch(() => undefined);
      }
      return;
    }
    try {
      connection.peer.send(frame);
    } catch {
      // The agent close hook clears the relay and its PTY sessions.
    }
  }

  private publish(serverId: string, frame: string, connectedAt?: string): void {
    this.sendLocal(serverId, frame, connectedAt);
    const ready = this.startBackplane();
    const backplane = this.backplane;
    if (!backplane) return;
    const relay = () =>
      backplane.publish({
        origin: this.id,
        serverId,
        frame,
        ...(connectedAt ? { connectedAt } : {}),
      });
    const delivery = connectedAt && ready ? ready.then(relay) : relay();
    void delivery.catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`realtime backplane publish failed: ${reason}`);
    });
  }

  async requestTelemetry(
    serverId: string,
    kind: TelemetryKind,
    connectedAt: string,
  ) {
    if (!this.connections.has(serverId) && !this.backplane) return null;
    return this.telemetry.request(
      JSON.stringify([serverId, connectedAt]),
      kind,
      (frame) => this.publish(serverId, frame, connectedAt),
    );
  }

  async inspectTelemetry(
    serverId: string,
    connectedAt: string,
    sessionId: string | null,
  ) {
    if (!sessionId) {
      return this.requestTelemetry(serverId, "snapshot", connectedAt);
    }
    if (!this.v2Connections.has(serverId) && !this.backplane) return null;
    if (this.pendingSnapshots.size >= 64) return null;
    const requestId = crypto.randomUUID();
    let finish!: (snapshot: unknown) => void;
    const result = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    this.pendingSnapshots.set(requestId, finish);
    const timer = setTimeout(
      () => this.resolveSnapshot(requestId, null),
      2_500,
    );
    try {
      this.publishV2(
        serverId,
        encodeAgentWsV2Frame(
          createAgentWsV2Frame("telemetry.inspect", { requestId }),
        ),
      );
      const snapshot = await result;
      const parsed = agentWsTelemetrySnapshotPayloadSchema.safeParse(snapshot);
      return parsed.success
        ? { kind: "snapshot" as const, data: parsed.data }
        : null;
    } finally {
      clearTimeout(timer);
      this.pendingSnapshots.delete(requestId);
    }
  }

  async notifyConfigChanged(
    serverId: string,
    payload: AgentWsConfigNotifyPayload,
  ): Promise<void> {
    this.publish(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("config.notify", payload)),
    );
    this.publishV2(
      serverId,
      encodeAgentWsV2ConfigNotify({
        desired: {
          desiredRevisionSeq: payload.desiredRevisionSeq,
          desiredRevision: payload.desiredRevision,
        },
        ...(payload.reason ? { reason: payload.reason } : {}),
      }),
    );
  }

  async notifyUpdateTrigger(
    serverId: string,
    payload: AgentWsUpdateTriggerPayload,
  ): Promise<void> {
    this.publish(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("update.trigger", payload)),
    );
    this.publishV2(
      serverId,
      encodeAgentWsV2Frame(createAgentWsV2Frame("update.trigger", payload)),
    );
  }

  async notifyAcmeIssue(
    serverId: string,
    payload: AgentWsAcmeIssuePayload,
  ): Promise<void> {
    this.publish(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("acme.issue", payload)),
    );
    this.publishV2(
      serverId,
      encodeAgentWsV2Frame(createAgentWsV2Frame("acme.issue", payload)),
    );
  }

  async notifyAcmeDnsAck(
    serverId: string,
    payload: AgentWsAcmeDnsAckPayload,
  ): Promise<void> {
    this.publish(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("acme.dns_ack", payload)),
    );
    this.publishV2(
      serverId,
      encodeAgentWsV2Frame(createAgentWsV2Frame("acme.dns_ack", payload)),
    );
  }

  async notifyLogPolicy(
    serverId: string,
    payload: LogPolicyNotifyPayload,
  ): Promise<void> {
    this.publishV2(serverId, encodeAgentWsV2LogPolicyNotify(payload));
  }

  /**
   * Addresses a probe to the exact agent session that was issued the request.
   * A newer or non-welcomed local socket is never considered, and the Redis
   * path carries the session id so the owning instance applies the same check.
   */
  async sendLinkProbe(
    serverId: string,
    sessionId: string,
    request: ManagedLinkProbeRequest,
  ): Promise<boolean> {
    const frame = encodeAgentWsV2LinkProbeRequest(request);
    const connection = this.findV2ConnectionBySession(serverId, sessionId);
    if (connection) {
      if (!connection.welcomed) return false;
      try {
        connection.peer.send(frame);
        return true;
      } catch {
        return false;
      }
    }
    const backplane = this.backplane;
    if (!backplane) return false;
    try {
      await this.startBackplane();
      await backplane.publish({
        origin: this.id,
        serverId,
        frame,
        protocol: "v2",
        agentSessionId: sessionId,
      });
      return true;
    } catch {
      return false;
    }
  }

  private async dispatchManagedRollout(
    followUps: ManagedRolloutFollowUp[],
  ): Promise<void> {
    await dispatchManagedRolloutFollowUps(followUps, {
      notifyConfigChanged: (serverId, payload) =>
        this.notifyConfigChanged(serverId, payload),
      sendLinkProbe: (serverId, sessionId, request) =>
        this.sendLinkProbe(serverId, sessionId, request),
    });
  }
}

function defaultBackplane(): RealtimeBackplane | undefined {
  try {
    const url = getServerEnv().REDIS_URL;
    return url ? new RedisBackplane(url) : undefined;
  } catch {
    return undefined;
  }
}

function liveMetricsKey(context: LiveMetricsSubscriptionContext): string {
  return JSON.stringify([
    context.serverId,
    context.sessionId ?? context.connectedAt,
  ]);
}

let hub: NitroRealtimeHub | undefined;

export function getRealtimeHub(): NitroRealtimeHub {
  return (hub ??= new NitroRealtimeHub());
}
