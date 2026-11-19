import {
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
} from "@blossom/contracts/agent-ws-v2";
import Redis from "ioredis";

import type { Server } from "@/db/proxy-schema";
import { getServerEnv } from "@/lib/env";

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
  openAgentWsV2Session,
  type AgentWsV2Session,
} from "./agent-ws-v2-session";
import {
  type AgentPtyTarget,
  REALTIME_BACKPLANE_CHANNEL,
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

class RedisBackplane implements RealtimeBackplane {
  private readonly publisher: Redis;
  private readonly subscriber: Redis;

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

  async subscribe(
    deliver: (message: RealtimeBackplaneMessage) => void,
  ): Promise<void> {
    await Promise.all([this.publisher.connect(), this.subscriber.connect()]);
    this.subscriber.on("message", (_channel, payload) => {
      try {
        deliver(JSON.parse(payload) as RealtimeBackplaneMessage);
      } catch {
        // A malformed backplane frame is ignored; local delivery still works.
      }
    });
    await this.subscriber.subscribe(REALTIME_BACKPLANE_CHANNEL);
  }

  async publish(message: RealtimeBackplaneMessage): Promise<void> {
    await this.publisher.publish(
      REALTIME_BACKPLANE_CHANNEL,
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
};

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

export class NitroRealtimeHub implements RealtimeHub {
  readonly id = crypto.randomUUID();
  private readonly connections = new Map<string, Set<LocalConnection>>();
  private readonly v2Connections = new Map<string, Set<LocalV2Connection>>();
  /** The newest v2 session this instance started for a server. */
  private readonly currentV2Sessions = new Map<string, LocalV2Connection>();
  private readonly ptyRelays = new Map<string, Map<string, LocalPtyRelay>>();
  private readonly backplane: RealtimeBackplane | undefined;
  private readonly store: ReturnType<typeof createAgentWsStore>;
  private readonly v2Store: AgentWsV2HubStore;
  private readonly telemetry = new TelemetryRequests();
  private backplaneReady: Promise<void> | undefined;

  constructor(
    options: {
      backplane?: RealtimeBackplane;
      store?: ReturnType<typeof createAgentWsStore>;
      v2Store?: AgentWsV2HubStore;
    } = {},
  ) {
    this.backplane = options.backplane ?? defaultBackplane();
    this.store = options.store ?? createAgentWsStore();
    this.v2Store = options.v2Store ?? createAgentWsV2Store();
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

  async acceptAgentV2(request: Request, server: Server): Promise<Response> {
    return attachCrosswsHooks(
      new Response(null, {
        status: 426,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      }),
      request,
      this.createV2Hooks(server.id, server.agentTokenHash),
    );
  }

  private createV2Hooks(serverId: string, tokenHash: string): CrosswsHooks {
    return {
      upgrade: () => ({ protocol: AGENT_WS_V2_SUBPROTOCOL }),
      open: async (peer) => {
        const connection: LocalV2Connection = {
          peer,
          session: Promise.resolve(null),
          sessionId: null,
          connectedAt: "",
        };
        const session = (async () => {
          const started = await this.v2Store.startSession(serverId, tokenHash);
          if (!started) {
            return null;
          }
          const opened = openAgentWsV2Session({
            serverId,
            sessionId: started.sessionId,
            peer,
            store: this.v2Store,
            reconnectBeforeSeconds: reconnectBeforeSecondsForRuntime(),
            onPtyFrame: (frame) =>
              this.deliverV2PtyFrame(serverId, started.sessionId, frame),
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
        this.startBackplane();
        try {
          if (!(await session)) {
            this.removeV2Connection(serverId, peer);
            peer.close(1008, "credential changed");
          }
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
      peers?.delete(connection);
      if (peers?.size === 0) {
        this.v2Connections.delete(serverId);
      }
      if (this.currentV2Sessions.get(serverId) === connection) {
        this.currentV2Sessions.delete(serverId);
      }
    }
    return connection;
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
    if (!agentSessionId) {
      return;
    }
    this.deliverV2(serverId, frame, agentSessionId);
    const backplane = this.backplane;
    if (!backplane) return;
    const ready = this.startBackplane();
    const relay = () =>
      backplane.publish({
        origin: this.id,
        serverId,
        frame,
        protocol: "v2",
        agentSessionId,
      });
    void (ready ? ready.then(relay) : relay()).catch((error: unknown) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`realtime backplane publish failed: ${reason}`);
    });
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
        this.startBackplane();
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
    return () => {
      const current = this.ptyRelays.get(serverId);
      if (current?.get(sessionId) === relay) {
        current.delete(sessionId);
        if (current.size === 0) {
          this.ptyRelays.delete(serverId);
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

  private startBackplane(): Promise<void> | undefined {
    if (!this.backplane || this.backplaneReady) {
      return this.backplaneReady;
    }
    this.backplaneReady = this.backplane
      .subscribe((message) => {
        if (message.origin === this.id) {
          return;
        }
        if (message.protocol === "v2") {
          this.deliverV2(
            message.serverId,
            message.frame,
            message.agentSessionId,
          );
          return;
        }
        if (message.agentDisconnected) {
          const target = ptyTargetFromBackplane(message);
          if (target) {
            this.closePtyRelays(message.serverId, target);
          }
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
      })
      .catch((error: unknown) => {
        const reason = error instanceof Error ? error.message : String(error);
        console.warn(`realtime backplane subscribe failed: ${reason}`);
      });
    return this.backplaneReady;
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
}

function defaultBackplane(): RealtimeBackplane | undefined {
  try {
    const url = getServerEnv().REDIS_URL;
    return url ? new RedisBackplane(url) : undefined;
  } catch {
    return undefined;
  }
}

let hub: NitroRealtimeHub | undefined;

export function getRealtimeHub(): NitroRealtimeHub {
  return (hub ??= new NitroRealtimeHub());
}
