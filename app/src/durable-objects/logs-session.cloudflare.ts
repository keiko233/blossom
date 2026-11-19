import type { LogRelayRevocation } from "@/lib/logs-authority";
import {
  createLogRelayState,
  reduceLogRelay,
  type LogRelayAuditRecord,
  type LogRelayEffect,
  type LogRelayEvent,
  type LogRelayState,
} from "@/lib/logs-relay";
import type { AdminLogsActor } from "@/query/log-audit";

/**
 * Cloudflare Durable Object side of the admin log relay. Each browser socket
 * keeps its plain-JSON reducer state in the WebSocket attachment, so a
 * hibernated object rebuilds the relay from what it persisted. Authority is
 * re-checked from a storage alarm, because hibernation drops in-memory timers.
 */
export const LOGS_REVALIDATE_INTERVAL_MS = 30 * 1000;
export const LOGS_REVALIDATE_TIMEOUT_MS = 10 * 1000;

export interface LogsDoStorage {
  getAlarm(): Promise<number | null>;
  setAlarm(scheduledTime: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

export interface LogsDoContext {
  getWebSockets(tag?: string): WebSocket[];
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  storage: LogsDoStorage;
}

export interface LogSocketAttachment {
  kind: "logs";
  serverId: string;
  /** The v2 agent session this relay was admitted against. */
  agentSessionId: string;
  /** better-auth session row id; the cookie and bearer token are never stored. */
  authSessionId: string;
  relayId: string;
  actor: AdminLogsActor;
  startedAt: string;
  state: LogRelayState;
  lastRevalidatedAt: number;
  closed?: { code: number; reason: string };
}

export interface LogsRelayDependencies {
  now(): number;
  newId(): string;
  recordAudit(
    serverId: string,
    actor: AdminLogsActor,
    record: LogRelayAuditRecord,
  ): Promise<void>;
  revalidate(
    attachment: LogSocketAttachment,
  ): Promise<LogRelayRevocation | null>;
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function json(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function parseActor(value: string): AdminLogsActor | null {
  try {
    const parsed = JSON.parse(
      decodeURIComponent(value),
    ) as Partial<AdminLogsActor>;
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

export function readLogSocketAttachment(
  ws: WebSocket,
): LogSocketAttachment | null {
  const attachment = ws.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") {
    return null;
  }
  const candidate = attachment as Partial<LogSocketAttachment>;
  if (
    candidate.kind !== "logs" ||
    typeof candidate.serverId !== "string" ||
    typeof candidate.agentSessionId !== "string" ||
    typeof candidate.authSessionId !== "string" ||
    typeof candidate.relayId !== "string" ||
    typeof candidate.startedAt !== "string" ||
    typeof candidate.lastRevalidatedAt !== "number" ||
    !candidate.actor ||
    !candidate.state ||
    typeof candidate.state.relayId !== "string" ||
    !Array.isArray(candidate.state.pending) ||
    typeof candidate.state.bucket !== "object"
  ) {
    return null;
  }
  return candidate as LogSocketAttachment;
}

function logsSockets(
  ctx: LogsDoContext,
  serverId: string,
): Array<{ ws: WebSocket; attachment: LogSocketAttachment }> {
  return ctx.getWebSockets(`logs:${serverId}`).flatMap((ws) => {
    const attachment = readLogSocketAttachment(ws);
    return attachment ? [{ ws, attachment }] : [];
  });
}

/**
 * Only a welcomed v2 agent socket is addressable. A v1 socket, a PTY socket or
 * a not-yet-welcomed v2 socket cannot receive log control frames.
 */
function findV2AgentSocket(
  ctx: LogsDoContext,
  serverId: string,
  sessionId: string,
): WebSocket | undefined {
  return ctx.getWebSockets(serverId).find((ws) => {
    const attachment = ws.deserializeAttachment?.();
    if (!attachment || typeof attachment !== "object") {
      return false;
    }
    const candidate = attachment as {
      protocol?: unknown;
      serverId?: unknown;
      sessionId?: unknown;
      welcomed?: unknown;
    };
    return (
      candidate.protocol === "v2" &&
      candidate.serverId === serverId &&
      candidate.sessionId === sessionId &&
      candidate.welcomed === true
    );
  });
}

function persist(ws: WebSocket, attachment: LogSocketAttachment): void {
  try {
    ws.serializeAttachment(attachment);
  } catch {
    // The socket is closing; the audit row still records the relay.
  }
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("log relay re-check timed out")),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Next moment this object must wake: the earliest request deadline or the
 * next authority check. A closed relay contributes nothing, so the alarm is
 * removed once no relay remains.
 */
function nextAlarm(ctx: LogsDoContext): number | null {
  let next: number | null = null;
  for (const ws of ctx.getWebSockets()) {
    const attachment = readLogSocketAttachment(ws);
    if (!attachment || attachment.closed || attachment.state.closed) {
      continue;
    }
    const candidates = [
      attachment.lastRevalidatedAt + LOGS_REVALIDATE_INTERVAL_MS,
      ...attachment.state.pending.map((request) => request.deadlineMs),
    ];
    for (const candidate of candidates) {
      if (next === null || candidate < next) {
        next = candidate;
      }
    }
  }
  return next;
}

/**
 * Re-arms the single storage alarm. An alarm already scheduled earlier is
 * kept, and no open relay deletes it, so hibernation leaves nothing armed.
 */
export async function scheduleLogAlarm(
  ctx: LogsDoContext,
  now: number,
): Promise<void> {
  const next = nextAlarm(ctx);
  if (next === null) {
    await ctx.storage.deleteAlarm().catch(() => undefined);
    return;
  }
  const current = await ctx.storage.getAlarm();
  if (current === null || next < current) {
    await ctx.storage.setAlarm(Math.max(next, now + 1));
  }
}

/**
 * Applies one event and performs its effects. Agent loss is discovered here
 * too: a control frame that cannot reach the agent ends the relay instead of
 * leaving the browser waiting on a tail that no session owns.
 */
async function applyEvent(
  ctx: LogsDoContext,
  ws: WebSocket,
  attachment: LogSocketAttachment,
  event: LogRelayEvent,
  dependencies: LogsRelayDependencies,
): Promise<LogSocketAttachment> {
  if (attachment.closed || attachment.state.closed) {
    return attachment;
  }
  const effects = reduceLogRelay(attachment.state, event, {
    newId: dependencies.newId,
  });
  for (const effect of effects) {
    const handled = await perform(ctx, ws, attachment, effect, dependencies);
    if (handled === "retry") {
      persist(ws, attachment);
      return attachment;
    }
  }
  persist(ws, attachment);
  return attachment;
}

/** Returns "retry" when the effect ended the relay and recursion must stop. */
async function perform(
  ctx: LogsDoContext,
  ws: WebSocket,
  attachment: LogSocketAttachment,
  effect: LogRelayEffect,
  dependencies: LogsRelayDependencies,
): Promise<"ok" | "retry"> {
  switch (effect.type) {
    case "send":
      try {
        ws.send(effect.frame);
      } catch {
        if (!attachment.state.closed) {
          await applyEvent(
            ctx,
            ws,
            attachment,
            { type: "browserClosed", nowMs: dependencies.now() },
            dependencies,
          );
          return "retry";
        }
      }
      return "ok";
    case "toAgent": {
      const agent = findV2AgentSocket(
        ctx,
        attachment.serverId,
        attachment.agentSessionId,
      );
      if (!agent) {
        if (!attachment.state.closed) {
          await applyEvent(
            ctx,
            ws,
            attachment,
            {
              type: "agentGone",
              reason: "agent_disconnected",
              nowMs: dependencies.now(),
            },
            dependencies,
          );
          return "retry";
        }
        return "ok";
      }
      try {
        agent.send(effect.frame);
      } catch {
        if (!attachment.state.closed) {
          await applyEvent(
            ctx,
            ws,
            attachment,
            {
              type: "agentGone",
              reason: "agent_disconnected",
              nowMs: dependencies.now(),
            },
            dependencies,
          );
          return "retry";
        }
      }
      return "ok";
    }
    case "audit":
      await dependencies
        .recordAudit(attachment.serverId, attachment.actor, effect.record)
        .catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`admin log relay audit failed: ${message}`);
        });
      return "ok";
    case "close":
      attachment.closed = { code: effect.code, reason: effect.reason };
      try {
        ws.close(effect.code, effect.reason);
      } catch {
        // Already closed by the peer.
      }
      return "ok";
  }
}

/**
 * Accepts the browser socket and arms the re-check before the 101 leaves the
 * object. Admission already verified the admin, server and agent session; the
 * alarm catches what changes afterwards.
 */
export async function handleLogsConnect(
  ctx: LogsDoContext,
  request: Request,
  dependencies: Pick<LogsRelayDependencies, "now" | "newId">,
): Promise<Response> {
  if (!isUpgrade(request)) {
    return new Response("WebSocket upgrade required", { status: 426 });
  }
  const serverId = request.headers.get("x-blossom-agent-logs-server-id") ?? "";
  const agentSessionId =
    request.headers.get("x-blossom-agent-logs-session-id") ?? "";
  const authSessionId =
    request.headers.get("x-blossom-agent-logs-auth-session-id") ?? "";
  const relayId = request.headers.get("x-blossom-agent-logs-relay-id") ?? "";
  const startedAt =
    request.headers.get("x-blossom-agent-logs-started-at") ?? "";
  const actor = parseActor(
    request.headers.get("x-blossom-agent-logs-actor") ?? "",
  );
  if (
    !serverId ||
    !agentSessionId ||
    !authSessionId ||
    !relayId ||
    Number.isNaN(Date.parse(startedAt)) ||
    !actor
  ) {
    return json(400, { error: "invalid_log_relay" });
  }
  if (!findV2AgentSocket(ctx, serverId, agentSessionId)) {
    return json(409, { error: "agent_unavailable" });
  }

  const now = dependencies.now();
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  ctx.acceptWebSocket(server, [`logs:${serverId}`]);
  const attachment: LogSocketAttachment = {
    kind: "logs",
    serverId,
    agentSessionId,
    authSessionId,
    relayId,
    actor,
    startedAt,
    state: createLogRelayState({
      relayId,
      serverId,
      sessionId: agentSessionId,
      nowMs: now,
    }),
    lastRevalidatedAt: now,
  };
  persist(server, attachment);
  await scheduleLogAlarm(ctx, now);
  return new Response(null, {
    status: 101,
    webSocket: client,
  } as ResponseInit & { webSocket: WebSocket });
}

export async function handleLogsBrowserMessage(
  ctx: LogsDoContext,
  ws: WebSocket,
  attachment: LogSocketAttachment,
  text: string,
  dependencies: LogsRelayDependencies,
): Promise<void> {
  if (attachment.closed || attachment.state.closed) {
    return;
  }
  const now = dependencies.now();
  await applyEvent(
    ctx,
    ws,
    attachment,
    { type: "browser", text, nowMs: now },
    dependencies,
  );
  await scheduleLogAlarm(ctx, now);
}

export async function handleLogsBrowserClose(
  ctx: LogsDoContext,
  ws: WebSocket,
  attachment: LogSocketAttachment,
  dependencies: LogsRelayDependencies,
): Promise<void> {
  if (attachment.closed || attachment.state.closed) {
    return;
  }
  const now = dependencies.now();
  await applyEvent(
    ctx,
    ws,
    attachment,
    { type: "browserClosed", nowMs: now },
    dependencies,
  );
  await scheduleLogAlarm(ctx, now);
}

/** Routes one validated agent log frame to every relay of its session. */
export async function handleAgentLogFrame(
  ctx: LogsDoContext,
  serverId: string,
  agentSessionId: string,
  text: string,
  dependencies: LogsRelayDependencies,
): Promise<void> {
  const now = dependencies.now();
  for (const { ws, attachment } of logsSockets(ctx, serverId)) {
    if (
      attachment.agentSessionId !== agentSessionId ||
      attachment.closed ||
      attachment.state.closed
    ) {
      continue;
    }
    await applyEvent(
      ctx,
      ws,
      attachment,
      { type: "agent", serverId, sessionId: agentSessionId, text, nowMs: now },
      dependencies,
    );
  }
  await scheduleLogAlarm(ctx, now);
}

export async function closeLogSocketsForAgent(
  ctx: LogsDoContext,
  serverId: string,
  agentSessionId: string,
  reason: "agent_disconnected" | "session_replaced",
  dependencies: LogsRelayDependencies,
): Promise<void> {
  const now = dependencies.now();
  for (const { ws, attachment } of logsSockets(ctx, serverId)) {
    const superseded =
      reason === "session_replaced"
        ? attachment.agentSessionId !== agentSessionId
        : attachment.agentSessionId === agentSessionId;
    if (!superseded || attachment.closed || attachment.state.closed) {
      continue;
    }
    await applyEvent(
      ctx,
      ws,
      attachment,
      { type: "agentGone", reason, nowMs: now },
      dependencies,
    );
  }
  await scheduleLogAlarm(ctx, now);
}

/**
 * Alarm body. It ticks every open relay (expiring request deadlines), rechecks
 * the admin and the session fence when due, and closes a relay whose agent
 * socket is gone. Each relay is rebuilt from its attachment alone, so this
 * runs correctly after hibernation.
 */
export async function revalidateLogSockets(
  ctx: LogsDoContext,
  dependencies: LogsRelayDependencies,
): Promise<void> {
  const now = dependencies.now();
  // Re-arm first, so an unexpected error cannot leave relays unchecked.
  await scheduleLogAlarm(ctx, now);
  for (const { ws, attachment } of ctx.getWebSockets().flatMap((socket) => {
    const read = readLogSocketAttachment(socket);
    return read ? [{ ws: socket, attachment: read }] : [];
  })) {
    if (attachment.closed || attachment.state.closed) {
      continue;
    }
    await applyEvent(
      ctx,
      ws,
      attachment,
      { type: "tick", nowMs: now },
      dependencies,
    );
    if (attachment.closed || attachment.state.closed) {
      continue;
    }
    if (
      !findV2AgentSocket(ctx, attachment.serverId, attachment.agentSessionId)
    ) {
      await applyEvent(
        ctx,
        ws,
        attachment,
        {
          type: "agentGone",
          reason: "agent_disconnected",
          nowMs: now,
        },
        dependencies,
      );
      continue;
    }
    if (now - attachment.lastRevalidatedAt < LOGS_REVALIDATE_INTERVAL_MS) {
      continue;
    }
    let reason: LogRelayRevocation | null = "forbidden";
    try {
      reason = await withDeadline(
        dependencies.revalidate(attachment),
        LOGS_REVALIDATE_TIMEOUT_MS,
      );
    } catch {
      reason = "forbidden";
    }
    attachment.lastRevalidatedAt = now;
    if (reason) {
      await applyEvent(
        ctx,
        ws,
        attachment,
        { type: "revoked", reason, nowMs: now },
        dependencies,
      );
    } else {
      persist(ws, attachment);
    }
  }
  await scheduleLogAlarm(ctx, now);
}
