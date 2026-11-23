import {
  parseAgentWsFrame,
  type AgentWsFrame,
  type AgentWsPtyDataPayload,
  type AgentWsPtyExitPayload,
  type AgentWsPtyExitReason,
  type AgentWsPtyStartedPayload,
} from "@blossom/contracts/agent-ws";
import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { session, user } from "@/db/auth-schema";
import { server as serverTable } from "@/db/proxy-schema";
import {
  encodePtyFrameForAgentV2,
  v2PtyFrameForBrowser,
} from "@/lib/agent-ws-v2-pty";
import {
  isPtyAuthorized,
  type PtyAuthorizationRecord,
  type PtyProtocol,
} from "@/lib/pty-authorization";
import {
  clampPtyDimensions,
  encodePtyFrame,
  isValidPtySessionId,
  parsePtyAgentFrame,
  parsePtyBrowserFrame,
  PTY_MAX_SESSIONS_PER_SERVER,
  ptyCloseFrame,
  ptyExitFrame,
  ptyOpenFrame,
} from "@/lib/pty-protocol";
import type { AgentPtyTarget } from "@/lib/realtime-hub-types";
import type { AdminPtyActor } from "@/query/pty-audit";

/**
 * Re-checks every open shell this often. A hibernated Durable Object loses its
 * in-memory timers, so the re-check runs from a storage alarm, which wakes the
 * object even when the browser sends nothing.
 */
export const PTY_REVALIDATE_INTERVAL_MS = 30 * 1000;
/** A re-check that does not answer within this window counts as failed. */
export const PTY_REVALIDATE_TIMEOUT_MS = 10 * 1000;

export interface PtyDoContext {
  getWebSockets(tag?: string): WebSocket[];
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  /** Re-arms the object's single storage alarm from every subsystem's deadline. */
  reconcileAlarm(): Promise<void>;
}

export interface AgentSocketAttachment {
  serverId: string;
  connectedAt: string;
  protocol: PtyProtocol;
  /** Present for v2; identifies the exact session the terminal may use. */
  sessionId: string | null;
}

export interface PtySocketAttachment {
  kind: "pty";
  serverId: string;
  connectedAt: string;
  agentProtocol: PtyProtocol;
  agentSessionId: string | null;
  sessionId: string;
  /** better-auth session row id; the cookie and bearer token are never stored. */
  authSessionId: string;
  actor: AdminPtyActor;
  startedAt: string;
  cols: number;
  rows: number;
  closeAudited?: boolean;
  closeReason?: string;
}

export type RecordPtyClose = (
  attachment: PtySocketAttachment,
  reason: AgentWsPtyExitReason | "browser_closed",
  outcome?: { code?: number; signal?: string },
) => Promise<void>;

function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export function readAgentAttachment(
  ws: WebSocket,
): AgentSocketAttachment | null {
  const attachment = ws.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const candidate = attachment as Partial<AgentSocketAttachment> & {
    kind?: string;
    protocol?: string;
    sessionId?: string;
  };
  if (
    candidate.kind === "pty" ||
    typeof candidate.serverId !== "string" ||
    typeof candidate.connectedAt !== "string"
  ) {
    return null;
  }
  if (candidate.protocol === "v2") {
    return typeof candidate.sessionId === "string"
      ? {
          serverId: candidate.serverId,
          connectedAt: candidate.connectedAt,
          protocol: "v2",
          sessionId: candidate.sessionId,
        }
      : null;
  }
  return {
    serverId: candidate.serverId,
    connectedAt: candidate.connectedAt,
    protocol: "v1",
    sessionId: null,
  };
}

export function readPtyAttachment(ws: WebSocket): PtySocketAttachment | null {
  const attachment = ws.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const candidate = attachment as Partial<PtySocketAttachment>;
  if (
    candidate.kind !== "pty" ||
    typeof candidate.serverId !== "string" ||
    typeof candidate.connectedAt !== "string" ||
    (candidate.agentProtocol !== "v1" && candidate.agentProtocol !== "v2") ||
    (candidate.agentProtocol === "v2" &&
      typeof candidate.agentSessionId !== "string") ||
    typeof candidate.sessionId !== "string" ||
    typeof candidate.authSessionId !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.cols !== "number" ||
    typeof candidate.rows !== "number" ||
    !candidate.actor
  ) {
    return null;
  }
  return candidate as PtySocketAttachment;
}

function findAgentSocket(
  ctx: PtyDoContext,
  serverId: string,
  target: AgentPtyTarget,
): WebSocket | undefined {
  return ctx.getWebSockets(serverId).find((ws) => {
    const attachment = readAgentAttachment(ws);
    return attachment
      ? attachment.protocol === target.protocol &&
          (target.protocol === "v2"
            ? Boolean(
                target.agentSessionId &&
                attachment.sessionId === target.agentSessionId,
              )
            : attachment.connectedAt === target.connectedAt)
      : false;
  });
}

function targetOf(attachment: PtySocketAttachment): AgentPtyTarget {
  return {
    protocol: attachment.agentProtocol,
    connectedAt: attachment.connectedAt,
    agentSessionId: attachment.agentSessionId,
  };
}

function encodeForAgent(
  attachment: PtySocketAttachment,
  frame: AgentWsFrame,
): string | null {
  return attachment.agentProtocol === "v2"
    ? encodePtyFrameForAgentV2(frame)
    : encodePtyFrame(frame);
}

function ptySockets(
  ctx: PtyDoContext,
  serverId: string,
): Array<{ ws: WebSocket; attachment: PtySocketAttachment }> {
  return ctx.getWebSockets(`pty:${serverId}`).flatMap((ws) => {
    const attachment = readPtyAttachment(ws);
    return attachment ? [{ ws, attachment }] : [];
  });
}

function parseActor(value: string): AdminPtyActor | null {
  try {
    const parsed = JSON.parse(
      decodeURIComponent(value),
    ) as Partial<AdminPtyActor>;
    if (typeof parsed.id !== "string" || parsed.id.length === 0) {
      return null;
    }
    return {
      id: parsed.id,
      email: typeof parsed.email === "string" ? parsed.email : null,
      impersonatedBy:
        typeof parsed.impersonatedBy === "string"
          ? parsed.impersonatedBy
          : null,
      ip: typeof parsed.ip === "string" ? parsed.ip : null,
      userAgent: typeof parsed.userAgent === "string" ? parsed.userAgent : null,
    };
  } catch {
    return null;
  }
}

/**
 * Accepts the browser socket and opens the shell on the agent. The Node relay
 * does the same: it registers the relay, then sends `pty.open`, and a failed
 * send closes the browser with `agent_disconnected` after the close audit.
 */
export async function handlePtyConnect(
  ctx: PtyDoContext,
  request: Request,
  recordClose: RecordPtyClose,
): Promise<Response> {
  if (!isUpgrade(request)) {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const sessionId = request.headers.get("x-blossom-pty-session") ?? "";
  const connectedAt = request.headers.get("x-blossom-pty-connected-at") ?? "";
  const protocolHeader = request.headers.get("x-blossom-pty-protocol");
  const agentProtocol: PtyProtocol = protocolHeader === "v2" ? "v2" : "v1";
  const agentSessionId =
    request.headers.get("x-blossom-pty-agent-session") ?? null;
  const startedAt = request.headers.get("x-blossom-pty-started-at") ?? "";
  const authSessionId = request.headers.get("x-blossom-pty-auth-session") ?? "";
  const actor = parseActor(request.headers.get("x-blossom-pty-actor") ?? "");
  if (
    !isValidPtySessionId(sessionId) ||
    !connectedAt ||
    (protocolHeader !== "v1" && protocolHeader !== "v2") ||
    (agentProtocol === "v2" && !agentSessionId) ||
    !authSessionId ||
    Number.isNaN(Date.parse(connectedAt)) ||
    Number.isNaN(Date.parse(startedAt)) ||
    !actor
  ) {
    return json(400, { error: "invalid_terminal_session" });
  }
  const serverId = new URL(request.url).searchParams.get("serverId") ?? "";
  if (!serverId) {
    return json(400, { error: "missing_server" });
  }
  const target: AgentPtyTarget = {
    protocol: agentProtocol,
    connectedAt,
    agentSessionId,
  };
  if (!findAgentSocket(ctx, serverId, target)) {
    return json(409, { error: "agent_unavailable" });
  }

  const existing = ptySockets(ctx, serverId);
  if (existing.length >= PTY_MAX_SESSIONS_PER_SERVER) {
    return json(429, { error: "session_limit" });
  }
  if (existing.some(({ attachment }) => attachment.sessionId === sessionId)) {
    return json(409, { error: "duplicate_session" });
  }

  const dimensions = clampPtyDimensions(
    Number(request.headers.get("x-blossom-pty-cols")),
    Number(request.headers.get("x-blossom-pty-rows")),
  );
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server, [`pty:${serverId}`]);
  const attachment: PtySocketAttachment = {
    kind: "pty",
    serverId,
    connectedAt,
    agentProtocol,
    agentSessionId,
    sessionId,
    authSessionId,
    actor,
    startedAt,
    cols: dimensions.cols,
    rows: dimensions.rows,
  };
  server.serializeAttachment(attachment);

  // Nothing awaits between registering the browser socket and sending
  // `pty.open`, so the agent's `pty.started` or `pty.data` always finds this
  // relay.
  let opened = false;
  try {
    const agent = findAgentSocket(ctx, serverId, target);
    if (agent) {
      const open = ptyOpenFrame(sessionId, {
        cols: dimensions.cols,
        rows: dimensions.rows,
      });
      const encoded =
        agentProtocol === "v2"
          ? encodePtyFrameForAgentV2(open)
          : encodePtyFrame(open);
      if (encoded) {
        agent.send(encoded);
        opened = true;
      }
    }
  } catch {
    // The agent socket is closing; the browser is closed below.
  }
  if (opened) {
    // The relay is counted by the alarm only once it is registered. A failed
    // alarm write must not leave an unchecked shell, so the relay is ended.
    try {
      await ctx.reconcileAlarm();
    } catch {
      await closePtySocket(
        server,
        attachment,
        "agent_disconnected",
        recordClose,
        {
          closeCode: 1011,
          sendExit: true,
        },
      );
    }
  } else {
    // No `pty.open` reached the agent, so no shell exists to orphan.
    await closePtySocket(
      server,
      attachment,
      "agent_disconnected",
      recordClose,
      {
        closeCode: 1011,
        sendExit: true,
      },
    );
  }
  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
}

export async function closePtySocket(
  ws: WebSocket,
  attachment: PtySocketAttachment,
  reason: AgentWsPtyExitReason | "browser_closed",
  recordClose: RecordPtyClose,
  options: {
    code?: number;
    signal?: string;
    closeCode?: number;
    sendExit?: boolean;
    audit?: boolean;
  } = {},
): Promise<void> {
  if (attachment.closeAudited) {
    return;
  }
  const updated: PtySocketAttachment = {
    ...attachment,
    closeAudited: true,
    closeReason: reason,
  };
  try {
    ws.serializeAttachment(updated);
  } catch {
    // The socket may already be closing.
  }
  if (options.sendExit) {
    try {
      ws.send(
        encodePtyFrame(
          ptyExitFrame(
            attachment.sessionId,
            reason === "browser_closed" ? "closed" : reason,
            options.code,
            options.signal,
          ),
        ),
      );
    } catch {
      // The close still records the session.
    }
  }
  if (options.audit ?? true) {
    await recordClose(updated, reason, {
      ...(options.code === undefined ? {} : { code: options.code }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).catch((error: unknown) => {
      console.warn("PTY close audit failed", error);
    });
  }
  try {
    ws.close(options.closeCode ?? 1000, reason);
  } catch {
    // Already closed.
  }
}

export async function handlePtyBrowserMessage(
  ctx: PtyDoContext,
  ws: WebSocket,
  attachment: PtySocketAttachment,
  text: string,
  recordClose: RecordPtyClose,
): Promise<void> {
  if (attachment.closeAudited) {
    // The shell was already closed (revoked or exited); late input is dropped.
    return;
  }
  const parsed = parsePtyBrowserFrame(text, attachment.sessionId);
  if (!parsed.ok) {
    await closePtySocket(
      ws,
      attachment,
      parsed.code === "too-large" ? "frame_too_large" : "closed",
      recordClose,
      { closeCode: 1008, sendExit: true },
    );
    return;
  }
  const agent = findAgentSocket(ctx, attachment.serverId, targetOf(attachment));
  if (!agent) {
    await closePtySocket(ws, attachment, "agent_disconnected", recordClose, {
      closeCode: 1011,
      sendExit: true,
    });
    return;
  }
  try {
    const encoded = encodeForAgent(attachment, parsed.frame);
    if (!encoded) {
      throw new Error("PTY frame could not be encoded for the agent");
    }
    agent.send(encoded);
  } catch {
    await closePtySocket(ws, attachment, "agent_disconnected", recordClose, {
      closeCode: 1011,
      sendExit: true,
    });
    return;
  }
  if (parsed.message.type === "pty.close") {
    await closePtySocket(ws, attachment, "closed", recordClose, {
      sendExit: false,
    });
  }
}

export async function handlePtyBrowserClose(
  ctx: PtyDoContext,
  ws: WebSocket,
  attachment: PtySocketAttachment,
  recordClose: RecordPtyClose,
  reason: AgentWsPtyExitReason | "browser_closed" = "browser_closed",
): Promise<void> {
  if (attachment.closeAudited) {
    return;
  }
  const updated: PtySocketAttachment = {
    ...attachment,
    closeAudited: true,
    closeReason: reason,
  };
  try {
    ws.serializeAttachment(updated);
  } catch {
    // The socket is already closed; the audit row still records the session.
  }
  const agent = findAgentSocket(ctx, attachment.serverId, targetOf(attachment));
  if (agent) {
    try {
      const encoded = encodeForAgent(
        attachment,
        ptyCloseFrame(attachment.sessionId),
      );
      if (encoded) {
        agent.send(encoded);
      }
    } catch {
      // The agent socket is already closing.
    }
  }
  await recordClose(updated, reason).catch((error: unknown) => {
    console.warn("PTY close audit failed", error);
  });
}

export async function handleAgentPtyFrame(
  ctx: PtyDoContext,
  serverId: string,
  connectedAt: string,
  text: string,
  recordClose: RecordPtyClose,
): Promise<boolean> {
  const parsedFrame = parseAgentWsFrame(text);
  if (!parsedFrame.ok || !parsedFrame.frame.type.startsWith("pty.")) {
    return false;
  }
  const parsed = parsePtyAgentFrame(
    parsedFrame.frame,
    typeof parsedFrame.frame.payload === "object" &&
      parsedFrame.frame.payload !== null &&
      "sessionId" in parsedFrame.frame.payload &&
      typeof parsedFrame.frame.payload.sessionId === "string"
      ? parsedFrame.frame.payload.sessionId
      : "",
  );
  if (!parsed.ok) {
    return true;
  }
  const delivered = await deliverAgentPtyFrame(
    ctx,
    serverId,
    { protocol: "v1", connectedAt, agentSessionId: null },
    parsed.message.type,
    parsed.message.payload,
    encodePtyFrame(parsed.frame),
    recordClose,
  );
  if (!delivered && parsed.message.type === "pty.data") {
    const agent = findAgentSocket(ctx, serverId, {
      protocol: "v1",
      connectedAt,
      agentSessionId: null,
    });
    if (agent) {
      try {
        agent.send(
          encodePtyFrame(ptyCloseFrame(parsed.message.payload.sessionId)),
        );
      } catch {
        // The agent socket is already gone.
      }
    }
  }
  return true;
}

export type AgentV2PtyMessage =
  | { type: "pty.started"; payload: AgentWsPtyStartedPayload }
  | { type: "pty.data"; payload: AgentWsPtyDataPayload }
  | { type: "pty.exit"; payload: AgentWsPtyExitPayload };

/**
 * Delivers an agent v2 terminal frame only to browser sockets bound to the
 * same agent session. The agent's session is the relay's correlation key, so a
 * replaced session cannot write into a newer terminal.
 */
export async function handleAgentV2PtyFrame(
  ctx: PtyDoContext,
  serverId: string,
  agentSessionId: string,
  message: AgentV2PtyMessage,
  recordClose: RecordPtyClose,
): Promise<boolean> {
  const browserFrame = v2PtyFrameForBrowser(message.type, message.payload);
  if (!browserFrame) {
    return true;
  }
  return deliverAgentPtyFrame(
    ctx,
    serverId,
    { protocol: "v2", connectedAt: "", agentSessionId },
    message.type,
    message.payload,
    browserFrame,
    recordClose,
  );
}

async function deliverAgentPtyFrame(
  ctx: PtyDoContext,
  serverId: string,
  target: AgentPtyTarget,
  messageType: "pty.started" | "pty.data" | "pty.exit",
  payload: {
    sessionId: string;
    reason?: string;
    code?: number;
    signal?: string;
  },
  browserFrame: string,
  recordClose: RecordPtyClose,
): Promise<boolean> {
  const sessionId = payload.sessionId;
  const matching = ptySockets(ctx, serverId).filter(
    ({ attachment }) =>
      attachment.sessionId === sessionId &&
      attachment.agentProtocol === target.protocol &&
      (target.protocol === "v2"
        ? Boolean(
            target.agentSessionId &&
            attachment.agentSessionId === target.agentSessionId,
          )
        : attachment.connectedAt === target.connectedAt),
  );
  for (const { ws, attachment } of matching) {
    if (attachment.closeAudited) {
      continue;
    }
    try {
      ws.send(browserFrame);
    } catch {
      await closePtySocket(ws, attachment, "agent_disconnected", recordClose, {
        closeCode: 1011,
        audit: true,
      });
      continue;
    }
    if (messageType === "pty.exit") {
      await closePtySocket(
        ws,
        { ...attachment, closeAudited: false },
        (payload.reason as AgentWsPtyExitReason | undefined) ?? "closed",
        recordClose,
        {
          code: payload.code,
          signal: payload.signal,
          sendExit: false,
          audit: true,
        },
      );
    }
  }

  return matching.length > 0;
}

export async function closePtySocketsForAgent(
  ctx: PtyDoContext,
  serverId: string,
  target: AgentPtyTarget,
  recordClose: RecordPtyClose,
  reason: AgentWsPtyExitReason = "agent_disconnected",
): Promise<void> {
  const matching = ptySockets(ctx, serverId).filter(
    ({ attachment }) =>
      attachment.agentProtocol === target.protocol &&
      (target.protocol === "v2"
        ? Boolean(
            target.agentSessionId &&
            attachment.agentSessionId === target.agentSessionId,
          )
        : attachment.connectedAt === target.connectedAt),
  );
  await Promise.all(
    matching.map(({ ws, attachment }) =>
      closePtySocket(ws, attachment, reason, recordClose, {
        closeCode: 1011,
        sendExit: true,
      }),
    ),
  );
}

export type PtyAuthorizationCheck = (
  attachment: PtySocketAttachment,
) => Promise<boolean>;

/**
 * Next moment the shells need this object to wake: one re-check interval from
 * `now` while any shell is open, nothing otherwise. A caller keeps an alarm
 * that is already earlier, so a steady stream of frames cannot push it back.
 */
export function nextPtyAlarm(ctx: PtyDoContext, now: number): number | null {
  for (const ws of ctx.getWebSockets()) {
    const attachment = readPtyAttachment(ws);
    if (attachment ? !attachment.closeAudited : isPtyKindAttachment(ws)) {
      return now + PTY_REVALIDATE_INTERVAL_MS;
    }
  }
  return null;
}

function isPtyKindAttachment(ws: WebSocket): boolean {
  const attachment = ws.deserializeAttachment?.();
  return (
    typeof attachment === "object" &&
    attachment !== null &&
    (attachment as { kind?: unknown }).kind === "pty"
  );
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("PTY re-check timed out")), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/** A failed or timed-out check is a revocation: the shell must not stay open. */
async function passesRecheck(
  attachment: PtySocketAttachment,
  check: PtyAuthorizationCheck,
): Promise<boolean> {
  try {
    return (
      (await withDeadline(check(attachment), PTY_REVALIDATE_TIMEOUT_MS)) ===
      true
    );
  } catch {
    return false;
  }
}

/**
 * Alarm body. Every open shell is checked from its persisted attachment alone,
 * so this runs correctly after hibernation. A shell that fails the check is
 * closed with `authorization_revoked` and its agent session is told to stop.
 */
export async function revalidatePtySockets(
  ctx: PtyDoContext,
  recordClose: RecordPtyClose,
  check: PtyAuthorizationCheck,
): Promise<void> {
  const open: Array<{ ws: WebSocket; attachment: PtySocketAttachment }> = [];
  for (const ws of ctx.getWebSockets()) {
    const attachment = readPtyAttachment(ws);
    if (attachment) {
      if (!attachment.closeAudited) {
        open.push({ ws, attachment });
      }
    } else if (isPtyKindAttachment(ws)) {
      // Opened before the attachment carried its session row: no re-check is possible.
      try {
        ws.close(1008, "authorization_revoked");
      } catch {
        // Already closing.
      }
    }
  }
  if (open.length === 0) {
    return;
  }
  // Re-arm before checking, so an unexpected error cannot leave shells unchecked.
  await ctx.reconcileAlarm();

  for (const { ws, attachment } of open) {
    const agent = findAgentSocket(
      ctx,
      attachment.serverId,
      targetOf(attachment),
    );
    // Without the agent socket the shell cannot be served, so close it
    // without asking the database.
    if (agent && (await passesRecheck(attachment, check))) {
      continue;
    }
    if (agent) {
      try {
        const encoded = encodeForAgent(
          attachment,
          ptyCloseFrame(attachment.sessionId),
        );
        if (encoded) {
          agent.send(encoded);
        }
      } catch {
        // The agent socket is already closing.
      }
    }
    await closePtySocket(ws, attachment, "authorization_revoked", recordClose, {
      closeCode: 1008,
      sendExit: true,
    });
  }
}

/**
 * Reads what the Node relay's re-check reads, in one query: the session row
 * (live, owned by the actor), its user's role, and the server row. An inner
 * join means a missing row fails the check.
 */
export async function isPtySessionAuthorized(
  database: Database,
  attachment: PtySocketAttachment,
  now: Date = new Date(),
): Promise<boolean> {
  const [row] = await database
    .select({
      sessionUserId: session.userId,
      sessionExpiresAt: session.expiresAt,
      role: user.role,
      enabled: serverTable.enabled,
      transportMode: serverTable.transportMode,
      wsConnectedAt: serverTable.wsConnectedAt,
      wsSessionId: serverTable.wsSessionId,
      agentCapabilities: serverTable.agentCapabilities,
    })
    .from(session)
    .innerJoin(user, eq(user.id, session.userId))
    .innerJoin(serverTable, eq(serverTable.id, attachment.serverId))
    .where(eq(session.id, attachment.authSessionId))
    .limit(1);
  const record: PtyAuthorizationRecord = row
    ? {
        sessionUserId: row.sessionUserId,
        sessionExpiresAt: row.sessionExpiresAt,
        role: row.role,
        server: {
          enabled: row.enabled,
          transportMode: row.transportMode,
          wsConnectedAt: row.wsConnectedAt,
          wsSessionId: row.wsSessionId,
          agentCapabilities: row.agentCapabilities,
        },
      }
    : { sessionUserId: null, sessionExpiresAt: null, role: null, server: null };
  return isPtyAuthorized(record, {
    userId: attachment.actor.id,
    protocol: attachment.agentProtocol,
    serverConnectedAt: attachment.connectedAt,
    serverSessionId: attachment.agentSessionId,
    now,
  });
}
