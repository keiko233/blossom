import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  type AgentWsAcmeDnsAckPayload,
  type AgentWsAcmeIssuePayload,
  type AgentWsConfigNotifyPayload,
  type AgentWsUpdateTriggerPayload,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
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
import { createAgentWsStore } from "./agent-ws-store";
import {
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

export function withRuntimeReconnectHint(
  welcome: AgentWsWelcomePayload,
  runtime: { vercel?: boolean } = {
    vercel: Boolean(process.env.VERCEL),
  },
): AgentWsWelcomePayload {
  return runtime.vercel ? { ...welcome, reconnectBeforeSeconds: 240 } : welcome;
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

export class NitroRealtimeHub implements RealtimeHub {
  readonly id = crypto.randomUUID();
  private readonly connections = new Map<string, Set<LocalConnection>>();
  private readonly backplane: RealtimeBackplane | undefined;
  private readonly store: ReturnType<typeof createAgentWsStore>;
  private readonly telemetry = new TelemetryRequests();
  private backplaneReady: Promise<void> | undefined;

  constructor(
    options: {
      backplane?: RealtimeBackplane;
      store?: ReturnType<typeof createAgentWsStore>;
    } = {},
  ) {
    this.backplane = options.backplane ?? defaultBackplane();
    this.store = options.store ?? createAgentWsStore();
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

  private startBackplane(): Promise<void> | undefined {
    if (!this.backplane || this.backplaneReady) {
      return this.backplaneReady;
    }
    this.backplaneReady = this.backplane
      .subscribe((message) => {
        if (message.origin === this.id) {
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
  }

  async notifyUpdateTrigger(
    serverId: string,
    payload: AgentWsUpdateTriggerPayload,
  ): Promise<void> {
    this.publish(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("update.trigger", payload)),
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
  }

  async notifyAcmeDnsAck(
    serverId: string,
    payload: AgentWsAcmeDnsAckPayload,
  ): Promise<void> {
    this.publish(
      serverId,
      encodeAgentWsFrame(createAgentWsFrame("acme.dns_ack", payload)),
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

let hub: RealtimeHub | undefined;

export function getRealtimeHub(): RealtimeHub {
  return (hub ??= new NitroRealtimeHub());
}
