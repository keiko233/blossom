import {
  parseAgentWsFrame,
  type AgentWsPtyExitReason,
} from "@blossom/contracts/agent-ws";
import { eq } from "drizzle-orm";

import type { Database } from "@/db";
import { session, user } from "@/db/auth-schema";
import { server as serverTable } from "@/db/proxy-schema";
import {
  isPtyAuthorized,
  type PtyAuthorizationRecord,
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
import type { AdminPtyActor } from "@/query/pty-audit";

/**
 * Re-checks every open shell this often. A hibernated Durable Object loses its
 * in-memory timers, so the re-check runs from a storage alarm, which wakes the
 * object even when the browser sends nothing.
 */
export const PTY_REVALIDATE_INTERVAL_MS = 30 * 1000;
/** A re-check that does not answer within this window counts as failed. */
export const PTY_REVALIDATE_TIMEOUT_MS = 10 * 1000;

export interface PtyDoStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
}

export interface PtyDoContext {
  getWebSockets(tag?: string): WebSocket[];
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  storage: PtyDoStorage;
}

export interface AgentSocketAttachment {
  serverId: string;
  connectedAt: string;
}

export interface PtySocketAttachment {
  kind: "pty";
  serverId: string;
  connectedAt: string;
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
  };
  if (
    candidate.kind === "pty" ||
    typeof candidate.serverId !== "string" ||
    typeof candidate.connectedAt !== "string"
  ) {
    return null;
  }
  return {
    serverId: candidate.serverId,
    connectedAt: candidate.connectedAt,
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
  connectedAt: string,
): WebSocket | undefined {
  return ctx
    .getWebSockets(serverId)
    .find((ws) => readAgentAttachment(ws)?.connectedAt === connectedAt);
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
  const startedAt = request.headers.get("x-blossom-pty-started-at") ?? "";
  const authSessionId = request.headers.get("x-blossom-pty-auth-session") ?? "";
  const actor = parseActor(request.headers.get("x-blossom-pty-actor") ?? "");
  if (
    !isValidPtySessionId(sessionId) ||
    !connectedAt ||
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
  if (!findAgentSocket(ctx, serverId, connectedAt)) {
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
  // Arm before accepting, so a failed alarm write leaves no unchecked shell.
  await schedulePtyRevalidation(ctx);
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server, [`pty:${serverId}`]);
  const attachment: PtySocketAttachment = {
    kind: "pty",
    serverId,
    connectedAt,
    sessionId,
    authSessionId,
    actor,
    startedAt,
    cols: dimensions.cols,
    rows: dimensions.rows,
  };
  server.serializeAttachment(attachment);

  // The agent is looked up again here: it may have gone during the alarm
  // write above. Nothing awaits between registering the browser socket and
  // sending `pty.open`, so the agent's `pty.started` or `pty.data` always
  // finds this relay.
  let opened = false;
  try {
    const agent = findAgentSocket(ctx, serverId, connectedAt);
    if (agent) {
      agent.send(
        encodePtyFrame(
          ptyOpenFrame(sessionId, {
            cols: dimensions.cols,
            rows: dimensions.rows,
          }),
        ),
      );
      opened = true;
    }
  } catch {
    // The agent socket is closing; the browser is closed below.
  }
  if (!opened) {
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
  const agent = findAgentSocket(
    ctx,
    attachment.serverId,
    attachment.connectedAt,
  );
  if (!agent) {
    await closePtySocket(ws, attachment, "agent_disconnected", recordClose, {
      closeCode: 1011,
      sendExit: true,
    });
    return;
  }
  try {
    agent.send(encodePtyFrame(parsed.frame));
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
  const agent = findAgentSocket(
    ctx,
    attachment.serverId,
    attachment.connectedAt,
  );
  if (agent) {
    try {
      agent.send(encodePtyFrame(ptyCloseFrame(attachment.sessionId)));
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

  const sessionId = parsed.message.payload.sessionId;
  const matching = ptySockets(ctx, serverId).filter(
    ({ attachment }) =>
      attachment.sessionId === sessionId &&
      attachment.connectedAt === connectedAt,
  );
  for (const { ws, attachment } of matching) {
    if (attachment.closeAudited) {
      continue;
    }
    try {
      ws.send(encodePtyFrame(parsed.frame));
    } catch {
      await closePtySocket(ws, attachment, "agent_disconnected", recordClose, {
        closeCode: 1011,
        audit: true,
      });
      continue;
    }
    if (parsed.message.type === "pty.exit") {
      await closePtySocket(
        ws,
        { ...attachment, closeAudited: false },
        parsed.message.payload.reason ?? "closed",
        recordClose,
        {
          code: parsed.message.payload.code,
          signal: parsed.message.payload.signal,
          sendExit: false,
          audit: true,
        },
      );
    }
  }

  if (matching.length === 0 && parsed.message.type === "pty.data") {
    const agent = findAgentSocket(ctx, serverId, connectedAt);
    if (agent) {
      try {
        agent.send(encodePtyFrame(ptyCloseFrame(sessionId)));
      } catch {
        // The agent socket is already gone.
      }
    }
  }
  return true;
}

export async function closePtySocketsForAgent(
  ctx: PtyDoContext,
  serverId: string,
  connectedAt: string,
  recordClose: RecordPtyClose,
  reason: AgentWsPtyExitReason = "agent_disconnected",
): Promise<void> {
  const matching = ptySockets(ctx, serverId).filter(
    ({ attachment }) => attachment.connectedAt === connectedAt,
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
 * Arms the re-check alarm when the first shell opens. An alarm that is already
 * set is kept, so a steady stream of new shells cannot push the re-check back.
 */
export async function schedulePtyRevalidation(
  ctx: PtyDoContext,
): Promise<void> {
  if ((await ctx.storage.getAlarm()) === null) {
    await ctx.storage.setAlarm(Date.now() + PTY_REVALIDATE_INTERVAL_MS);
  }
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
  await ctx.storage.setAlarm(Date.now() + PTY_REVALIDATE_INTERVAL_MS);

  for (const { ws, attachment } of open) {
    const agent = findAgentSocket(
      ctx,
      attachment.serverId,
      attachment.connectedAt,
    );
    // Without the agent socket the shell cannot be served, so close it
    // without asking the database.
    if (agent && (await passesRecheck(attachment, check))) {
      continue;
    }
    if (agent) {
      try {
        agent.send(encodePtyFrame(ptyCloseFrame(attachment.sessionId)));
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
          agentCapabilities: row.agentCapabilities,
        },
      }
    : { sessionUserId: null, sessionExpiresAt: null, role: null, server: null };
  return isPtyAuthorized(record, {
    userId: attachment.actor.id,
    serverConnectedAt: attachment.connectedAt,
    now,
  });
}
