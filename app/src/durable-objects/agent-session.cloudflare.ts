import {
  agentWsWelcomePayloadSchema,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import {
  AGENT_WS_V2_SUBPROTOCOL,
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
} from "@blossom/contracts/agent-ws-v2";
import { DurableObject, env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/node-postgres";

import type { Database } from "@/db";
import { verifyAdminMetricsAuthority } from "@/lib/admin-metrics-authority";
import {
  adminMetricsClientMessageSchema,
  type AdminMetricsServerMessage,
} from "@/lib/admin-metrics-protocol";
import { telemetryReply, TelemetryRequests } from "@/lib/agent-telemetry";
import {
  closeAgentWsSession,
  handleAgentWsMessage,
  openAgentWsSession,
  type AgentWsSession,
  type AgentWsStore,
} from "@/lib/agent-ws-session";
import { createAgentWsStore, createAgentWsV2Store } from "@/lib/agent-ws-store";
import { openAgentWsV2Session } from "@/lib/agent-ws-v2-session";
import {
  LIVE_METRIC_INTERVAL_MS,
  liveSampleFromV1,
  liveSampleFromV2,
  type LiveMetricSample,
} from "@/lib/live-metrics";
import { revalidateLogRelay } from "@/lib/logs-authority";
import {
  AGENT_WS_INTERNAL_CONNECTED_AT,
  AGENT_WS_INTERNAL_CREDENTIAL_KIND,
  AGENT_WS_INTERNAL_IDENTITY_GENERATION,
  AGENT_WS_INTERNAL_IDENTITY_ID,
  AGENT_WS_INTERNAL_PROTOCOL,
  AGENT_WS_INTERNAL_SERVER_ID,
  AGENT_WS_INTERNAL_SESSION_EXPIRES_AT,
  AGENT_WS_INTERNAL_SESSION_ID,
  AGENT_WS_INTERNAL_SESSION_PENDING,
  AGENT_WS_INTERNAL_WELCOME,
} from "@/lib/realtime-hub-types";
import {
  endAgentWsSession,
  loadCurrentAgentServer,
  revalidatePendingAgentV2Session,
  type AgentSessionCredential,
} from "@/query/agent";
import { recordLogRelayAudit } from "@/query/log-audit";
import { createLogAuthorityStore } from "@/query/log-authority";
import { recordPtySessionClose } from "@/query/pty-audit";

import {
  closeLogSocketsForAgent,
  handleAgentLogFrame,
  handleLogsBrowserClose,
  handleLogsBrowserMessage,
  handleLogsConnect,
  readLogSocketAttachment,
  revalidateLogSockets,
  type LogsRelayDependencies,
} from "./logs-session.cloudflare";
import {
  closePtySocketsForAgent,
  handleAgentPtyFrame,
  handlePtyBrowserClose,
  handlePtyBrowserMessage,
  handlePtyConnect,
  handleAgentV2PtyFrame,
  isPtySessionAuthorized,
  readPtyAttachment,
  revalidatePtySockets,
  type PtySocketAttachment,
  type RecordPtyClose,
} from "./pty-session.cloudflare";

interface AgentSessionAttachmentBase {
  serverId: string;
  connectedAt: string;
}

/**
 * Per-socket state that survives hibernation. Attachments written before v2
 * carry no `protocol` field and are read as v1.
 */
interface V1AgentSessionAttachment extends AgentSessionAttachmentBase {
  protocol: "v1";
  welcome: AgentWsWelcomePayload;
  /** The fence recorded by the v1 handshake; older attachments omit it. */
  sessionId?: string;
}

interface V2AgentSessionAttachment extends AgentSessionAttachmentBase {
  protocol: "v2";
  sessionId: string;
  welcomed: boolean;
  /** A newer v2 connection for the same server exists. */
  superseded?: boolean;
  pending: boolean;
  credentialKind: AgentSessionCredential["kind"];
  identityId?: string;
  identityGeneration?: number;
  /** Machine-token expiry in epoch seconds. Never the token itself. */
  expiresAt: number | null;
}

type AgentSessionAttachment =
  | V1AgentSessionAttachment
  | V2AgentSessionAttachment;

interface MetricsAdminAttachment {
  kind: "metrics-admin";
  serverId: string;
  connectedAt: string;
  sessionId: string | null;
  protocol: "v1" | "v2";
  adminSessionId: string;
  userId: string;
}

const AUTHORITY_CHECK_INTERVAL_MS = 30_000;

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function readAttachment(ws: WebSocket): AgentSessionAttachment | null {
  const attachment = ws.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const candidate = attachment as Partial<V1AgentSessionAttachment> &
    Partial<V2AgentSessionAttachment> &
    Partial<MetricsAdminAttachment>;
  if (candidate.kind === "metrics-admin") {
    return null;
  }
  if (
    typeof candidate.serverId !== "string" ||
    typeof candidate.connectedAt !== "string"
  ) {
    return null;
  }
  if (candidate.protocol === "v2") {
    if (typeof candidate.sessionId !== "string") {
      return null;
    }
    return {
      protocol: "v2",
      serverId: candidate.serverId,
      connectedAt: candidate.connectedAt,
      sessionId: candidate.sessionId,
      welcomed: candidate.welcomed === true,
      superseded: candidate.superseded === true,
      pending: candidate.pending === true,
      credentialKind: candidate.credentialKind === "oauth" ? "oauth" : "static",
      ...(typeof candidate.identityId === "string"
        ? { identityId: candidate.identityId }
        : {}),
      ...(typeof candidate.identityGeneration === "number"
        ? { identityGeneration: candidate.identityGeneration }
        : {}),
      expiresAt:
        typeof candidate.expiresAt === "number" ? candidate.expiresAt : null,
    };
  }
  const welcome = agentWsWelcomePayloadSchema.safeParse(candidate.welcome);
  if (!welcome.success) {
    return null;
  }
  return {
    protocol: "v1",
    serverId: candidate.serverId,
    connectedAt: candidate.connectedAt,
    welcome: welcome.data,
    ...(typeof candidate.sessionId === "string"
      ? { sessionId: candidate.sessionId }
      : {}),
  };
}

function readMetricsAttachment(ws: WebSocket): MetricsAdminAttachment | null {
  const attachment = ws.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const candidate = attachment as Partial<MetricsAdminAttachment>;
  if (
    candidate.kind !== "metrics-admin" ||
    typeof candidate.serverId !== "string" ||
    typeof candidate.connectedAt !== "string" ||
    typeof candidate.adminSessionId !== "string" ||
    typeof candidate.userId !== "string" ||
    (candidate.protocol !== "v1" && candidate.protocol !== "v2")
  ) {
    return null;
  }
  return {
    kind: "metrics-admin",
    serverId: candidate.serverId,
    connectedAt: candidate.connectedAt,
    sessionId:
      typeof candidate.sessionId === "string" ? candidate.sessionId : null,
    protocol: candidate.protocol,
    adminSessionId: candidate.adminSessionId,
    userId: candidate.userId,
  };
}

function decodeMessage(message: string | ArrayBuffer): string {
  return typeof message === "string"
    ? message
    : new TextDecoder().decode(message);
}

export class AgentSessionDO extends DurableObject {
  private readonly recordPtyClose: RecordPtyClose = async (
    attachment: PtySocketAttachment,
    reason,
    outcome,
  ) => {
    await this.withDatabase((database) =>
      recordPtySessionClose(
        {
          session: {
            serverId: attachment.serverId,
            sessionId: attachment.sessionId,
            cols: attachment.cols,
            rows: attachment.rows,
            startedAt: new Date(attachment.startedAt),
            actor: attachment.actor,
          },
          reason,
          ...(outcome?.code === undefined ? {} : { code: outcome.code }),
          ...(outcome?.signal === undefined ? {} : { signal: outcome.signal }),
        },
        database,
      ),
    );
  };
  private readonly telemetry = new TelemetryRequests();
  private metricsTimer: ReturnType<typeof setInterval> | undefined;
  private metricsSubscriptionId: string | undefined;
  private lastMetricsAuthorityCheck = 0;
  private readonly pendingMetricsSnapshots = new Map<
    string,
    (snapshot: unknown) => void
  >();

  private async withDatabase<T>(
    run: (database: Database) => Promise<T>,
  ): Promise<T> {
    const connectionString =
      env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
    if (!connectionString) {
      throw new Error("No database binding is available to AgentSessionDO");
    }
    const database = drizzle(connectionString) as Database & {
      $client: { end(): Promise<void> };
    };
    try {
      return await run(database);
    } finally {
      await database.$client.end().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`agent durable object database close failed: ${message}`);
      });
    }
  }

  private logDependencies(database: Database): LogsRelayDependencies {
    return {
      now: () => Date.now(),
      newId: () => crypto.randomUUID(),
      recordAudit: (serverId, actor, record) =>
        recordLogRelayAudit({ serverId, actor, record }, database),
      revalidate: (attachment) =>
        revalidateLogRelay(createLogAuthorityStore(database), {
          serverId: attachment.serverId,
          sessionId: attachment.agentSessionId,
          authSessionId: attachment.authSessionId,
          now: new Date(),
        }),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/internal/logs/connect") {
      return handleLogsConnect(this.ctx, request, {
        now: () => Date.now(),
        newId: () => crypto.randomUUID(),
      });
    }
    if (pathname === "/internal/pty/connect") {
      return handlePtyConnect(this.ctx, request, this.recordPtyClose);
    }
    if (pathname === "/internal/admin-metrics/connect") {
      return this.connectMetricsAdmin(request);
    }
    if (pathname === "/internal/telemetry" && request.method === "POST") {
      const params = new URL(request.url).searchParams;
      const kind = params.get("kind");
      const connectedAt = params.get("connectedAt");
      const ws =
        connectedAt &&
        this.ctx.getWebSockets().find((candidate) => {
          const attachment = readAttachment(candidate);
          return (
            attachment?.protocol === "v1" &&
            attachment.connectedAt === connectedAt
          );
        });
      if (!connectedAt || !ws || (kind !== "sample" && kind !== "snapshot")) {
        return new Response(null, { status: 204 });
      }
      const result = await this.telemetry.request(connectedAt, kind, (frame) =>
        ws.send(frame),
      );
      return result
        ? Response.json(result)
        : new Response(null, { status: 204 });
    }
    if (pathname === "/internal/notify") {
      return this.notify(request);
    }
    if (pathname === "/internal/connect") {
      return this.connect(request);
    }
    return new Response("Not Found", { status: 404 });
  }

  private async notify(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const body = (await request.json()) as {
      frame?: unknown;
      protocol?: unknown;
    };
    if (typeof body.frame !== "string") {
      return new Response("Bad Request", { status: 400 });
    }
    // A v1 frame goes only to v1 sockets, and a v2 push only to welcomed v2
    // sockets. Neither is ever sent across the other protocol.
    const target = body.protocol === "v2" ? "v2" : "v1";
    for (const ws of this.ctx.getWebSockets()) {
      if (readPtyAttachment(ws)) {
        continue;
      }
      const attachment = readAttachment(ws);
      if (attachment?.protocol !== target) {
        continue;
      }
      if (
        attachment.protocol === "v2" &&
        (!attachment.welcomed || attachment.superseded)
      ) {
        continue;
      }
      try {
        ws.send(body.frame);
      } catch {
        // A stale socket is cleaned up through webSocketClose.
      }
    }
    return new Response(null, { status: 204 });
  }

  private async connect(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return new Response("WebSocket upgrade required", {
        status: 426,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
    }

    const serverId = request.headers.get(AGENT_WS_INTERNAL_SERVER_ID);
    const connectedAt = request.headers.get(AGENT_WS_INTERNAL_CONNECTED_AT);
    if (request.headers.get(AGENT_WS_INTERNAL_PROTOCOL) === "v2") {
      return this.connectV2(request, serverId, connectedAt);
    }
    const welcomeHeader = request.headers.get(AGENT_WS_INTERNAL_WELCOME);
    const sessionId = request.headers.get(AGENT_WS_INTERNAL_SESSION_ID);
    if (!serverId || !connectedAt || !welcomeHeader) {
      return new Response("Bad Request", { status: 400 });
    }

    let welcome: AgentWsWelcomePayload;
    try {
      welcome = agentWsWelcomePayloadSchema.parse(
        JSON.parse(decodeURIComponent(welcomeHeader)),
      );
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [serverId]);
    server.serializeAttachment({
      protocol: "v1",
      serverId,
      connectedAt,
      welcome,
      ...(sessionId ? { sessionId } : {}),
    } satisfies V1AgentSessionAttachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  private async connectV2(
    request: Request,
    serverId: string | null,
    connectedAt: string | null,
  ): Promise<Response> {
    const sessionId = request.headers.get(AGENT_WS_INTERNAL_SESSION_ID);
    if (!serverId || !connectedAt || !sessionId) {
      return new Response("Bad Request", { status: 400 });
    }
    const credentialKind =
      request.headers.get(AGENT_WS_INTERNAL_CREDENTIAL_KIND) === "oauth"
        ? "oauth"
        : "static";
    const identityId = request.headers.get(AGENT_WS_INTERNAL_IDENTITY_ID);
    const identityGeneration = Number(
      request.headers.get(AGENT_WS_INTERNAL_IDENTITY_GENERATION),
    );
    const expiresAtRaw = request.headers.get(
      AGENT_WS_INTERNAL_SESSION_EXPIRES_AT,
    );
    const expiresAt = expiresAtRaw === null ? null : Number(expiresAtRaw);
    if (
      credentialKind === "oauth" &&
      (!identityId ||
        !Number.isInteger(identityGeneration) ||
        identityGeneration <= 0 ||
        expiresAt === null ||
        !Number.isFinite(expiresAt))
    ) {
      return new Response("Bad Request", { status: 400 });
    }

    // A newer handshake makes older v2 sockets inert here: their messages and
    // pushes are ignored until the database fence stops them. Terminal relays
    // are tied to the exact session, so they never blend across the two.
    for (const existing of this.ctx.getWebSockets(serverId)) {
      const attachment = readAttachment(existing);
      if (attachment?.protocol === "v2" && !attachment.superseded) {
        existing.serializeAttachment({
          ...attachment,
          superseded: true,
        } satisfies V2AgentSessionAttachment);
      }
    }

    // The database already made this session current. Every relay bound to an
    // older session is now non-authoritative; end it before accepting the new
    // agent socket so no tail survives across the fence.
    if (this.ctx.getWebSockets(`logs:${serverId}`).length > 0) {
      await this.withDatabase((database) =>
        closeLogSocketsForAgent(
          this.ctx,
          serverId,
          sessionId,
          "session_replaced",
          this.logDependencies(database),
        ),
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [serverId]);
    server.serializeAttachment({
      protocol: "v2",
      serverId,
      connectedAt,
      sessionId,
      welcomed: false,
      pending: request.headers.get(AGENT_WS_INTERNAL_SESSION_PENDING) === "1",
      credentialKind,
      ...(identityId ? { identityId } : {}),
      ...(credentialKind === "oauth"
        ? { identityGeneration, expiresAt }
        : { expiresAt: null }),
    } satisfies V2AgentSessionAttachment);
    this.scheduleV2Alarm();

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": AGENT_WS_V2_SUBPROTOCOL },
    } as ResponseInit & { webSocket: WebSocket });
  }

  /** Reconstructs the non-secret credential descriptor from the attachment. */
  private credentialOf(
    attachment: V2AgentSessionAttachment,
  ): AgentSessionCredential {
    if (attachment.credentialKind === "oauth" && attachment.identityId) {
      return {
        kind: "oauth",
        identityId: attachment.identityId,
        generation: attachment.identityGeneration ?? 0,
        clientId: "",
        expiresAt: attachment.expiresAt ?? 0,
        identityStatus: attachment.pending ? "pending" : "active",
      };
    }
    // The static token hash is not kept in the attachment; the session fence
    // already stores its rotation state in the server row.
    return { kind: "static", tokenHash: "" };
  }

  /**
   * Wakes the object at least every 30 seconds (or at the earliest token
   * expiry) so revocation, replacement and expiry close idle sockets without
   * waiting for the next frame.
   */
  private scheduleV2Alarm(): void {
    const storage = this.ctx.storage;
    if (!storage?.setAlarm) {
      return;
    }
    const now = Date.now();
    const deadlines = this.ctx
      .getWebSockets()
      .map(readAttachment)
      .filter(
        (attachment): attachment is V2AgentSessionAttachment =>
          attachment?.protocol === "v2",
      )
      .map((attachment) =>
        attachment.expiresAt === null
          ? now + 30_000
          : attachment.expiresAt * 1000,
      );
    if (deadlines.length === 0) {
      void storage.deleteAlarm().catch(() => undefined);
      return;
    }
    const next = Math.max(now + 1_000, Math.min(now + 30_000, ...deadlines));
    void storage.setAlarm(next).catch(() => undefined);
  }

  async alarm(): Promise<void> {
    await revalidatePtySockets(this.ctx, this.recordPtyClose, (attachment) =>
      this.withDatabase((database) =>
        isPtySessionAuthorized(database, attachment),
      ),
    );
    await this.withDatabase((database) =>
      revalidateLogSockets(this.ctx, this.logDependencies(database)),
    );
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (attachment?.protocol !== "v2") {
        continue;
      }
      if (attachment.expiresAt !== null && attachment.expiresAt * 1000 <= now) {
        ws.close(4000, "session_replaced");
        continue;
      }
      const credential = this.credentialOf(attachment);
      try {
        if (attachment.pending) {
          const usable = await this.withDatabase((database) =>
            revalidatePendingAgentV2Session(
              attachment.serverId,
              credential,
              database,
            ),
          );
          if (!usable) {
            ws.close(4000, "session_replaced");
          }
          continue;
        }
        const row = await this.withDatabase((database) =>
          loadCurrentAgentServer(
            attachment.serverId,
            attachment.sessionId,
            database,
          ),
        );
        if (!row) {
          ws.close(4000, "session_replaced");
        } else if (!row.enabled) {
          ws.close(4000, "server_disabled");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(
          `agent durable object lease check failed for ${attachment.serverId}: ${message}`,
        );
      }
    }
    this.scheduleV2Alarm();
  }

  private connectMetricsAdmin(request: Request): Response {
    if (!isWebSocketUpgrade(request)) {
      return new Response("WebSocket upgrade required", {
        status: 426,
        headers: { Connection: "Upgrade", Upgrade: "websocket" },
      });
    }
    const url = new URL(request.url);
    const serverId = url.searchParams.get("serverId");
    const connectedAt = request.headers.get("x-blossom-metrics-connected-at");
    const adminSessionId = request.headers.get(
      "x-blossom-metrics-admin-session",
    );
    const userId = request.headers.get("x-blossom-metrics-user");
    const protocol = request.headers.get("x-blossom-metrics-protocol");
    const sessionId = request.headers.get("x-blossom-metrics-session-id");
    if (
      !serverId ||
      !connectedAt ||
      !adminSessionId ||
      !userId ||
      (protocol !== "v1" && protocol !== "v2")
    ) {
      return new Response("Bad Request", { status: 400 });
    }
    if (protocol === "v2" && !sessionId) {
      return new Response("Bad Request", { status: 400 });
    }
    const agent = this.findAgentSocket(
      connectedAt,
      protocol === "v2" ? sessionId : null,
    );
    if (!agent) {
      return Response.json(
        { error: "agent_unavailable" },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [serverId]);
    server.serializeAttachment({
      kind: "metrics-admin",
      serverId,
      connectedAt,
      sessionId: protocol === "v2" ? sessionId : null,
      protocol,
      adminSessionId,
      userId,
    } satisfies MetricsAdminAttachment);
    this.ensureMetricsSampling();
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  private metricsViewers(): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => readMetricsAttachment(ws) !== null);
  }

  private findAgentSocket(
    connectedAt: string,
    sessionId: string | null,
  ): WebSocket | undefined {
    return this.ctx.getWebSockets().find((ws) => {
      const attachment = readAttachment(ws);
      if (!attachment || attachment.connectedAt !== connectedAt) {
        return false;
      }
      if (sessionId) {
        return (
          attachment.protocol === "v2" && attachment.sessionId === sessionId
        );
      }
      return attachment.protocol === "v1";
    });
  }

  private ensureMetricsSampling(): void {
    if (this.metricsViewers().length === 0) {
      this.stopMetricsSampling();
      return;
    }
    if (this.metricsTimer) return;
    this.metricsTimer = setInterval(() => {
      void this.sampleMetrics().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`admin metric sampling failed: ${message}`);
      });
    }, LIVE_METRIC_INTERVAL_MS);
    void this.sampleMetrics().catch(() => undefined);
  }

  private stopMetricsSampling(): void {
    if (this.metricsTimer) {
      clearInterval(this.metricsTimer);
      this.metricsTimer = undefined;
    }
    this.metricsSubscriptionId = undefined;
    this.lastMetricsAuthorityCheck = 0;
  }

  private sendMetricsEvent(message: AdminMetricsServerMessage): void {
    const text = JSON.stringify(message);
    for (const ws of this.metricsViewers()) {
      try {
        ws.send(text);
      } catch {
        // A stale socket is removed by webSocketClose.
      }
    }
  }

  private broadcastLiveSample(sample: LiveMetricSample): void {
    if (this.metricsViewers().length === 0) return;
    this.sendMetricsEvent({ type: "sample", sample });
  }

  /**
   * One sampler per Durable Object. v1 is polled and v2 subscribes once; the
   * timer also revalidates admin and agent authority while viewers are idle.
   */
  private async sampleMetrics(): Promise<void> {
    const viewers = this.metricsViewers();
    if (viewers.length === 0) {
      this.stopMetricsSampling();
      return;
    }
    const now = Date.now();
    if (now - this.lastMetricsAuthorityCheck >= AUTHORITY_CHECK_INTERVAL_MS) {
      this.lastMetricsAuthorityCheck = now;
      await this.checkMetricsAuthority(viewers);
      if (this.metricsViewers().length === 0) {
        this.stopMetricsSampling();
        return;
      }
    }

    const v2 = viewers
      .map(readMetricsAttachment)
      .find((attachment) => attachment?.protocol === "v2");
    if (v2?.sessionId) {
      const agent = this.findAgentSocket(v2.connectedAt, v2.sessionId);
      if (!agent) {
        this.closeMetricsViewers("agent_replaced");
        return;
      }
      const agentAttachment = readAttachment(agent);
      if (agentAttachment?.protocol !== "v2" || !agentAttachment.welcomed) {
        return;
      }
      const subscriptionId = `live-${v2.sessionId}`;
      if (this.metricsSubscriptionId !== subscriptionId) {
        this.metricsSubscriptionId = subscriptionId;
        agent.send(
          encodeAgentWsV2Frame(
            createAgentWsV2Frame("telemetry.subscribe", {
              subscriptionId,
              purpose: "live",
              intervalMs: LIVE_METRIC_INTERVAL_MS,
            }),
          ),
        );
      }
      return;
    }

    const v1 = viewers
      .map(readMetricsAttachment)
      .find((attachment) => attachment?.protocol === "v1");
    if (!v1) return;
    const agent = this.findAgentSocket(v1.connectedAt, null);
    if (!agent) {
      this.closeMetricsViewers("agent_replaced");
      return;
    }
    const reply = await this.telemetry.request(
      v1.connectedAt,
      "sample",
      (frame) => agent.send(frame),
    );
    if (reply?.kind === "sample") {
      this.broadcastLiveSample(liveSampleFromV1(reply.data, Date.now()));
    }
  }

  private async checkMetricsAuthority(viewers: WebSocket[]): Promise<void> {
    const attachments = viewers
      .map(readMetricsAttachment)
      .filter((attachment): attachment is MetricsAdminAttachment =>
        Boolean(attachment),
      );
    await this.withDatabase(async (database) => {
      for (const attachment of attachments) {
        const allowed = await verifyAdminMetricsAuthority(
          {
            serverId: attachment.serverId,
            connectedAt: attachment.connectedAt,
            sessionId: attachment.sessionId,
            adminSessionId: attachment.adminSessionId,
            userId: attachment.userId,
          },
          database,
        );
        if (allowed) {
          const agent = this.findAgentSocket(
            attachment.connectedAt,
            attachment.sessionId,
          );
          if (agent) continue;
        }
        this.closeMetricsViewer(attachment);
      }
    });
  }

  private closeMetricsViewer(attachment: MetricsAdminAttachment): void {
    for (const ws of this.metricsViewers()) {
      const current = readMetricsAttachment(ws);
      if (
        current?.adminSessionId === attachment.adminSessionId &&
        current.connectedAt === attachment.connectedAt
      ) {
        try {
          ws.send(
            JSON.stringify({
              type: "error",
              code: "unauthorized",
              message: "admin metric stream authorization was revoked",
            } satisfies AdminMetricsServerMessage),
          );
          ws.close(1008, "authorization revoked");
        } catch {
          // Already closed.
        }
      }
    }
  }

  private closeMetricsViewers(code: "agent_replaced" | "unavailable"): void {
    const message =
      code === "agent_replaced"
        ? "the agent session was replaced"
        : "live metrics are unavailable";
    this.sendMetricsEvent({ type: "error", code, message });
    for (const ws of this.metricsViewers()) {
      try {
        ws.close(1008, code);
      } catch {
        // Already closed.
      }
    }
    this.stopMetricsSampling();
  }

  private session(
    attachment: V1AgentSessionAttachment,
    store: AgentWsStore,
  ): Promise<AgentWsSession> {
    return openAgentWsSession({
      serverId: attachment.serverId,
      welcome: attachment.welcome,
      connectedAt: new Date(attachment.connectedAt),
      ...(attachment.sessionId ? { sessionId: attachment.sessionId } : {}),
      store,
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const raw = decodeMessage(message);
    const logs = readLogSocketAttachment(ws);
    if (logs) {
      await this.withDatabase((database) =>
        handleLogsBrowserMessage(
          this.ctx,
          ws,
          logs,
          raw,
          this.logDependencies(database),
        ),
      );
      return;
    }
    const pty = readPtyAttachment(ws);
    if (pty) {
      await handlePtyBrowserMessage(
        this.ctx,
        ws,
        pty,
        raw,
        this.recordPtyClose,
      );
      return;
    }
    const metrics = readMetricsAttachment(ws);
    if (metrics) {
      await this.handleMetricsMessage(ws, metrics, decodeMessage(message));
      return;
    }
    const attachment = readAttachment(ws);
    if (!attachment) {
      ws.close(1008, "missing session attachment");
      return;
    }
    if (attachment.protocol === "v2") {
      await this.handleV2Message(ws, attachment, raw);
      return;
    }
    if (
      await handleAgentPtyFrame(
        this.ctx,
        attachment.serverId,
        attachment.connectedAt,
        raw,
        this.recordPtyClose,
      )
    ) {
      return;
    }
    const reply = telemetryReply(raw);
    if (reply) {
      this.telemetry.accept(attachment.connectedAt, reply);
      return;
    }
    await this.withDatabase(async (database) => {
      const store = createAgentWsStore(database);
      const session = await this.session(attachment, store);
      await handleAgentWsMessage(session, ws, raw);
    });
  }

  async webSocketClose(
    ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const logs = readLogSocketAttachment(ws);
    if (logs) {
      await this.withDatabase((database) =>
        handleLogsBrowserClose(
          this.ctx,
          ws,
          logs,
          this.logDependencies(database),
        ),
      );
      return;
    }
    const pty = readPtyAttachment(ws);
    if (pty) {
      await handlePtyBrowserClose(this.ctx, ws, pty, this.recordPtyClose);
      return;
    }
    const metrics = readMetricsAttachment(ws);
    if (metrics) {
      const remaining = this.ctx
        .getWebSockets()
        .some(
          (candidate) => candidate !== ws && readMetricsAttachment(candidate),
        );
      if (!remaining) {
        this.stopMetricsSampling();
      }
      return;
    }
    const attachment = readAttachment(ws);
    if (!attachment) {
      return;
    }
    if (this.metricsViewers().length > 0) {
      this.closeMetricsViewers("unavailable");
    }
    await closePtySocketsForAgent(
      this.ctx,
      attachment.serverId,
      attachment.protocol === "v2"
        ? {
            protocol: "v2",
            connectedAt: attachment.connectedAt,
            agentSessionId: attachment.sessionId,
          }
        : {
            protocol: "v1",
            connectedAt: attachment.connectedAt,
            agentSessionId: null,
          },
      this.recordPtyClose,
    );
    if (attachment.protocol === "v2") {
      await this.withDatabase(async (database) => {
        await closeLogSocketsForAgent(
          this.ctx,
          attachment.serverId,
          attachment.sessionId,
          "agent_disconnected",
          this.logDependencies(database),
        );
        await endAgentWsSession(
          attachment.serverId,
          attachment.sessionId,
          database,
        );
      });
      this.scheduleV2Alarm();
      return;
    }
    await this.withDatabase(async (database) => {
      const session = await this.session(
        attachment,
        createAgentWsStore(database),
      );
      await closeAgentWsSession(session);
    });
  }

  private async handleMetricsMessage(
    ws: WebSocket,
    attachment: MetricsAdminAttachment,
    raw: string,
  ): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const message = adminMetricsClientMessageSchema.safeParse(parsed);
    if (!message.success || message.data.type !== "inspect") return;
    const snapshot = await this.inspectMetrics(attachment);
    if (!snapshot) {
      try {
        ws.send(
          JSON.stringify({
            type: "error",
            code: "unavailable",
            message: "telemetry inspection is unavailable",
          } satisfies AdminMetricsServerMessage),
        );
      } catch {
        // The viewer closed while the inspection ran.
      }
      return;
    }
    try {
      ws.send(
        JSON.stringify({
          type: "snapshot",
          requestId: message.data.requestId,
          snapshot,
        } satisfies AdminMetricsServerMessage),
      );
    } catch {
      // The viewer closed while the inspection ran.
    }
  }

  private async inspectMetrics(
    attachment: MetricsAdminAttachment,
  ): Promise<unknown> {
    const agent = this.findAgentSocket(
      attachment.connectedAt,
      attachment.sessionId,
    );
    if (!agent) return null;
    if (attachment.sessionId) {
      const agentAttachment = readAttachment(agent);
      if (agentAttachment?.protocol !== "v2" || !agentAttachment.welcomed) {
        return null;
      }
    }
    if (!attachment.sessionId) {
      const reply = await this.telemetry.request(
        attachment.connectedAt,
        "snapshot",
        (frame) => agent.send(frame),
      );
      return reply?.kind === "snapshot" ? reply.data : null;
    }

    const requestId = crypto.randomUUID();
    let finish!: (snapshot: unknown) => void;
    const result = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    this.pendingMetricsSnapshots.set(requestId, finish);
    const timer = setTimeout(
      () => this.resolveMetricsSnapshot(requestId, null),
      2_500,
    );
    try {
      agent.send(
        encodeAgentWsV2Frame(
          createAgentWsV2Frame("telemetry.inspect", { requestId }),
        ),
      );
      return await result;
    } finally {
      clearTimeout(timer);
      this.pendingMetricsSnapshots.delete(requestId);
    }
  }

  private resolveMetricsSnapshot(requestId: string, snapshot: unknown): void {
    const finish = this.pendingMetricsSnapshots.get(requestId);
    if (!finish) return;
    this.pendingMetricsSnapshots.delete(requestId);
    finish(snapshot);
  }

  /**
   * Each v2 message rebuilds the session from the attachment, so `welcomed` is
   * written back to the socket and survives hibernation. The database work
   * runs inside the message handler, which Durable Object input gates keep
   * ordered per server.
   */
  private async handleV2Message(
    ws: WebSocket,
    attachment: V2AgentSessionAttachment,
    raw: string,
  ): Promise<void> {
    if (attachment.superseded) {
      return;
    }
    await this.withDatabase(async (database) => {
      const logs = this.logDependencies(database);
      const session = openAgentWsV2Session({
        serverId: attachment.serverId,
        sessionId: attachment.sessionId,
        credential: this.credentialOf(attachment),
        pending: attachment.pending,
        peer: ws,
        store: createAgentWsV2Store(database),
        welcomed: attachment.welcomed,
        onPtyFrame: (frame) =>
          handleAgentV2PtyFrame(
            this.ctx,
            attachment.serverId,
            attachment.sessionId,
            frame,
            this.recordPtyClose,
          ),
        onLogFrame: (text) =>
          handleAgentLogFrame(
            this.ctx,
            attachment.serverId,
            attachment.sessionId,
            text,
            logs,
          ),
        onSample: (sample) => {
          if (sample.purpose === "live") {
            this.broadcastLiveSample(liveSampleFromV2(sample));
          }
        },
        onSnapshot: (snapshot) =>
          this.resolveMetricsSnapshot(snapshot.requestId, snapshot),
      });
      await session.handleText(raw);
      if (
        session.welcomed !== attachment.welcomed ||
        session.pending !== attachment.pending
      ) {
        ws.serializeAttachment({
          ...attachment,
          welcomed: session.welcomed,
          pending: session.pending,
        } satisfies V2AgentSessionAttachment);
      }
      this.scheduleV2Alarm();
    });
  }

  async webSocketError(ws: WebSocket, error: unknown): Promise<void> {
    const logs = readLogSocketAttachment(ws);
    if (logs) {
      await this.withDatabase((database) =>
        handleLogsBrowserClose(
          this.ctx,
          ws,
          logs,
          this.logDependencies(database),
        ),
      ).catch(() => undefined);
      return;
    }
    const pty = readPtyAttachment(ws);
    if (pty) {
      await handlePtyBrowserClose(
        this.ctx,
        ws,
        pty,
        this.recordPtyClose,
        "io_error",
      );
      return;
    }
    const attachment = readAttachment(ws);
    if (attachment) {
      await closePtySocketsForAgent(
        this.ctx,
        attachment.serverId,
        attachment.protocol === "v2"
          ? {
              protocol: "v2",
              connectedAt: attachment.connectedAt,
              agentSessionId: attachment.sessionId,
            }
          : {
              protocol: "v1",
              connectedAt: attachment.connectedAt,
              agentSessionId: null,
            },
        this.recordPtyClose,
        "io_error",
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `agent durable object websocket error${attachment ? ` for ${attachment.serverId}` : ""}: ${message}`,
    );
  }
}
