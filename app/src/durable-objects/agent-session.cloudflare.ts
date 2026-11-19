import {
  agentWsWelcomePayloadSchema,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import { AGENT_WS_V2_SUBPROTOCOL } from "@blossom/contracts/agent-ws-v2";
import { DurableObject, env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/node-postgres";

import type { Database } from "@/db";
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
import { recordPtySessionClose } from "@/query/pty-audit";

import {
  closePtySocketsForAgent,
  handleAgentPtyFrame,
  handlePtyBrowserClose,
  handlePtyBrowserMessage,
  handlePtyConnect,
  readPtyAttachment,
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
}

interface V2AgentSessionAttachment extends AgentSessionAttachmentBase {
  protocol: "v2";
  sessionId: string;
  welcomed: boolean;
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

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function readAttachment(ws: WebSocket): AgentSessionAttachment | null {
  const attachment = ws.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const candidate = attachment as Partial<V1AgentSessionAttachment> &
    Partial<V2AgentSessionAttachment>;
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

  async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/internal/pty/connect") {
      return handlePtyConnect(this.ctx, request);
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
      if (attachment.protocol === "v2" && !attachment.welcomed) {
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

  private connect(request: Request): Response {
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
    } satisfies V1AgentSessionAttachment);

    return new Response(null, {
      status: 101,
      webSocket: client,
    } as ResponseInit & { webSocket: WebSocket });
  }

  private connectV2(
    request: Request,
    serverId: string | null,
    connectedAt: string | null,
  ): Response {
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

  private session(
    attachment: V1AgentSessionAttachment,
    store: AgentWsStore,
  ): Promise<AgentWsSession> {
    return openAgentWsSession({
      serverId: attachment.serverId,
      welcome: attachment.welcome,
      connectedAt: new Date(attachment.connectedAt),
      store,
    });
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const pty = readPtyAttachment(ws);
    if (pty) {
      await handlePtyBrowserMessage(
        this.ctx,
        ws,
        pty,
        decodeMessage(message),
        this.recordPtyClose,
      );
      return;
    }
    const attachment = readAttachment(ws);
    if (!attachment) {
      ws.close(1008, "missing session attachment");
      return;
    }
    const raw = decodeMessage(message);
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
    const pty = readPtyAttachment(ws);
    if (pty) {
      await handlePtyBrowserClose(this.ctx, ws, pty, this.recordPtyClose);
      return;
    }
    const attachment = readAttachment(ws);
    if (!attachment) {
      return;
    }
    await closePtySocketsForAgent(
      this.ctx,
      attachment.serverId,
      attachment.connectedAt,
      this.recordPtyClose,
    );
    if (attachment.protocol === "v2") {
      await this.withDatabase((database) =>
        endAgentWsSession(attachment.serverId, attachment.sessionId, database),
      );
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
    await this.withDatabase(async (database) => {
      const session = openAgentWsV2Session({
        serverId: attachment.serverId,
        sessionId: attachment.sessionId,
        credential: this.credentialOf(attachment),
        pending: attachment.pending,
        peer: ws,
        store: createAgentWsV2Store(database),
        welcomed: attachment.welcomed,
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
        attachment.connectedAt,
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
