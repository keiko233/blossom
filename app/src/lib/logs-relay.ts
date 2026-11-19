import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2PayloadOf,
} from "@blossom/contracts/agent-ws-v2";
import {
  AGENT_WS_V2_LOGS_LIMITS,
  parseAdminLogsClientFrame,
  type AdminLogsClientFrame,
  type AgentWsV2LogQuery,
} from "@blossom/contracts/agent-ws-v2-logs";

/**
 * The browser relay for the admin log WebSocket, as a pure state machine.
 *
 * The reducer owns every rule that does not depend on a runtime: which agent
 * session and server a relay is bound to, the id mapping that keeps browser
 * ids and agent ids apart, per-relay request budgets, outbound pacing, request
 * deadlines and close codes. A runtime (the Nitro registry or the agent-session
 * Durable Object) supplies events, performs the returned effects, and persists
 * the state. The state is plain JSON, so it can sit in a WebSocket attachment.
 * The clock is an input, so tests advance it directly.
 *
 * Budgets, per relay: one live tail, the search and context concurrency from
 * the contract, a token bucket that paces tail batches, and a deadline on every
 * agent request. A request past its deadline is answered with `timeout` and
 * its agent id is forgotten, so a late agent reply finds no owner and is dropped.
 */

export const LOG_RELAY_LIMITS = {
  /** An agent request not answered by then fails with `timeout`. */
  requestTimeoutMs: 10_000,
  /** Burst allowance for tail batches before pacing drops them. */
  outboundBurstBytes: 1024 * 1024,
  /** Sustained tail throughput to one browser. */
  outboundBytesPerSecond: 256 * 1024,
  /** How often the runtime rechecks the admin session and the server fence. */
  revalidateIntervalMs: 30_000,
  searchConcurrent: AGENT_WS_V2_LOGS_LIMITS.searchConcurrentPerRelay,
  contextConcurrent: AGENT_WS_V2_LOGS_LIMITS.contextConcurrentPerRelay,
} as const;

/** Close codes for the admin log socket. The 4000 range names relay states. */
export const LOG_RELAY_CLOSE = {
  browserClosed: 1000,
  invalidRequest: 1008,
  frameTooLarge: 1009,
  forbidden: 4001,
  serverDisabled: 4002,
  sessionReplaced: 4003,
  offline: 4004,
  unsupported: 4005,
} as const;

/** Why an admin relay that was accepted must now end. */
export type LogRelayRevocation =
  | "forbidden"
  | "server_disabled"
  | "session_replaced"
  | "offline"
  | "unsupported";

const REVOCATION_CLOSE: Record<LogRelayRevocation, number> = {
  forbidden: LOG_RELAY_CLOSE.forbidden,
  server_disabled: LOG_RELAY_CLOSE.serverDisabled,
  session_replaced: LOG_RELAY_CLOSE.sessionReplaced,
  offline: LOG_RELAY_CLOSE.offline,
  unsupported: LOG_RELAY_CLOSE.unsupported,
};

export interface LogSearchAuditInput {
  source?: string;
  minLevel?: string;
  since?: string;
  until?: string;
  limit: number;
  /** Whether the query had text. The text itself is never recorded. */
  textSearch: boolean;
  continued: boolean;
}

export interface LogContextAuditInput {
  before: number;
  after: number;
}

/**
 * Metadata-only audit records. Search text, record contents and cursors never
 * appear here. The runtime adds the operator and the server.
 */
export type LogRelayAuditRecord =
  | {
      action: "server.logs_subscribe";
      failed: false;
      input: { source?: string; minLevel?: string; resumed: boolean };
    }
  | {
      action: "server.logs_search";
      failed: boolean;
      outcome: string;
      input: LogSearchAuditInput;
      durationMs: number;
      matches?: number;
      coverageGap?: string | null;
    }
  | {
      action: "server.logs_context";
      failed: boolean;
      outcome: string;
      input: LogContextAuditInput;
      durationMs: number;
    }
  | {
      action: "server.logs_close";
      failed: false;
      reason: string;
      droppedBatches: number;
      droppedRecords: number;
    };

export type LogRelayEvent =
  | { type: "browser"; text: string; nowMs: number }
  | { type: "browserClosed"; nowMs: number }
  /** A text frame from the agent of one session. Other sessions are ignored. */
  | {
      type: "agent";
      serverId: string;
      sessionId: string;
      text: string;
      nowMs: number;
    }
  /** The agent session ended or was replaced. */
  | {
      type: "agentGone";
      reason: "agent_disconnected" | "session_replaced";
      nowMs: number;
    }
  | { type: "tick"; nowMs: number }
  | { type: "revoked"; reason: LogRelayRevocation; nowMs: number };

export type LogRelayEffect =
  | { type: "send"; frame: string }
  | { type: "toAgent"; frame: string }
  | { type: "audit"; record: LogRelayAuditRecord }
  | { type: "close"; code: number; reason: string };

export interface LogRelayBinding {
  clientId: string;
  agentId: string;
}

export interface LogRelayPending extends LogRelayBinding {
  kind: "search" | "context";
  deadlineMs: number;
  startedMs: number;
  search: LogSearchAuditInput | null;
  context: LogContextAuditInput | null;
}

export interface LogRelayState {
  readonly relayId: string;
  readonly serverId: string;
  /** The agent session this relay is bound to. */
  readonly sessionId: string;
  subscription: LogRelayBinding | null;
  pending: LogRelayPending[];
  bucket: { tokens: number; updatedMs: number };
  dropped: { batches: number; records: number };
  closed: boolean;
}

export interface LogRelayDependencies {
  /** Returns an id no other relay holds; agent-side ids are unique per relay. */
  newId(): string;
}

export function createLogRelayState(input: {
  relayId: string;
  serverId: string;
  sessionId: string;
  nowMs: number;
}): LogRelayState {
  return {
    relayId: input.relayId,
    serverId: input.serverId,
    sessionId: input.sessionId,
    subscription: null,
    pending: [],
    bucket: {
      tokens: LOG_RELAY_LIMITS.outboundBurstBytes,
      updatedMs: input.nowMs,
    },
    dropped: { batches: 0, records: 0 },
    closed: false,
  };
}

/** Agent-side ids this relay answers to, for a runtime's routing index. */
export function ownedAgentIds(state: LogRelayState): string[] {
  const ids = state.subscription ? [state.subscription.agentId] : [];
  return [...ids, ...state.pending.map((request) => request.agentId)];
}

/**
 * Applies one event and returns the effects to perform. Mutates `state`, which
 * stays plain JSON. A closed relay accepts no further events.
 */
export function reduceLogRelay(
  state: LogRelayState,
  event: LogRelayEvent,
  dependencies: LogRelayDependencies,
): LogRelayEffect[] {
  if (state.closed) {
    return [];
  }
  const effects: LogRelayEffect[] = [];
  switch (event.type) {
    case "browser":
      onBrowserFrame(state, event, dependencies, effects);
      break;
    case "browserClosed":
      finish(state, "browser_closed", event.nowMs, effects, {
        cancelAgent: true,
        closeCode: LOG_RELAY_CLOSE.browserClosed,
      });
      break;
    case "agent":
      if (
        event.serverId === state.serverId &&
        event.sessionId === state.sessionId
      ) {
        onAgentFrame(state, event.text, event.nowMs, effects);
      }
      break;
    case "agentGone":
      finish(state, event.reason, event.nowMs, effects, {
        cancelAgent: false,
        closeCode:
          event.reason === "session_replaced"
            ? LOG_RELAY_CLOSE.sessionReplaced
            : LOG_RELAY_CLOSE.offline,
      });
      break;
    case "tick":
      expireRequests(state, event.nowMs, effects);
      break;
    case "revoked":
      finish(state, event.reason, event.nowMs, effects, {
        cancelAgent: true,
        closeCode: REVOCATION_CLOSE[event.reason],
      });
      break;
  }
  return effects;
}

// ---------------------------------------------------------------------------
// Browser -> agent
// ---------------------------------------------------------------------------

function onBrowserFrame(
  state: LogRelayState,
  event: { text: string; nowMs: number },
  dependencies: LogRelayDependencies,
  effects: LogRelayEffect[],
): void {
  const { nowMs } = event;
  const parsed = parseAdminLogsClientFrame(event.text);
  if (!parsed.ok) {
    // A malformed request has no id that could be answered, so the socket
    // closes. The client is our own UI, so this signals a bug, not a retry.
    finish(state, parsed.code, nowMs, effects, {
      cancelAgent: true,
      closeCode:
        parsed.code === "frame-too-large"
          ? LOG_RELAY_CLOSE.frameTooLarge
          : LOG_RELAY_CLOSE.invalidRequest,
    });
    return;
  }
  const frame: AdminLogsClientFrame = parsed.frame;
  switch (frame.type) {
    case "logs.subscribe":
      subscribe(state, frame.payload, nowMs, dependencies, effects);
      return;
    case "logs.unsubscribe":
      unsubscribe(state, frame.payload.subscriptionId, nowMs, effects);
      return;
    case "logs.search":
      search(state, frame.payload, nowMs, dependencies, effects);
      return;
    case "logs.search.cancel":
      cancelSearch(state, frame.payload.requestId, nowMs, effects);
      return;
    case "logs.context":
      context(state, frame.payload, nowMs, dependencies, effects);
      return;
  }
}

function subscribe(
  state: LogRelayState,
  payload: AgentWsV2PayloadOf<"logs.subscribe">,
  nowMs: number,
  dependencies: LogRelayDependencies,
  effects: LogRelayEffect[],
): void {
  // One live tail per relay. A new subscribe replaces the previous one.
  if (state.subscription) {
    toAgent(
      effects,
      "logs.unsubscribe",
      {
        subscriptionId: state.subscription.agentId,
      },
      nowMs,
    );
  }
  const agentId = dependencies.newId();
  state.subscription = { clientId: payload.subscriptionId, agentId };
  toAgent(
    effects,
    "logs.subscribe",
    {
      subscriptionId: agentId,
      filter: payload.filter,
      resume: payload.resume,
      limit: payload.limit,
    },
    nowMs,
  );
  effects.push({
    type: "audit",
    record: {
      action: "server.logs_subscribe",
      failed: false,
      input: {
        ...(payload.filter.source ? { source: payload.filter.source } : {}),
        ...(payload.filter.minLevel
          ? { minLevel: payload.filter.minLevel }
          : {}),
        resumed: payload.resume !== null,
      },
    },
  });
}

function unsubscribe(
  state: LogRelayState,
  subscriptionId: string,
  nowMs: number,
  effects: LogRelayEffect[],
): void {
  const current = state.subscription;
  if (!current || current.clientId !== subscriptionId) {
    effects.push(
      clientError(
        "not_found",
        { subscriptionId },
        "no such subscription",
        nowMs,
      ),
    );
    return;
  }
  state.subscription = null;
  toAgent(
    effects,
    "logs.unsubscribe",
    { subscriptionId: current.agentId },
    nowMs,
  );
}

function search(
  state: LogRelayState,
  payload: AgentWsV2PayloadOf<"logs.search">,
  nowMs: number,
  dependencies: LogRelayDependencies,
  effects: LogRelayEffect[],
): void {
  const requestId = payload.requestId;
  if (state.pending.some((request) => request.clientId === requestId)) {
    effects.push(
      clientError(
        "invalid_request",
        { requestId },
        "request id is in use",
        nowMs,
      ),
    );
    return;
  }
  const audit = searchAuditInput(
    payload.query,
    payload.limit,
    payload.cursor !== null,
  );
  const searches = state.pending.filter(
    (request) => request.kind === "search",
  ).length;
  if (searches >= LOG_RELAY_LIMITS.searchConcurrent) {
    effects.push(
      clientError(
        "busy",
        { requestId },
        "too many concurrent log searches",
        nowMs,
      ),
    );
    effects.push({
      type: "audit",
      record: {
        action: "server.logs_search",
        failed: true,
        outcome: "busy",
        input: audit,
        durationMs: 0,
      },
    });
    return;
  }
  const agentId = dependencies.newId();
  state.pending.push({
    kind: "search",
    clientId: requestId,
    agentId,
    deadlineMs: nowMs + LOG_RELAY_LIMITS.requestTimeoutMs,
    startedMs: nowMs,
    search: audit,
    context: null,
  });
  toAgent(
    effects,
    "logs.search",
    {
      requestId: agentId,
      query: payload.query,
      cursor: payload.cursor,
      limit: payload.limit,
    },
    nowMs,
  );
}

function cancelSearch(
  state: LogRelayState,
  requestId: string,
  nowMs: number,
  effects: LogRelayEffect[],
): void {
  const index = state.pending.findIndex(
    (request) => request.kind === "search" && request.clientId === requestId,
  );
  if (index === -1) {
    return; // Already answered, timed out, or never accepted.
  }
  const [request] = state.pending.splice(index, 1);
  if (!request) {
    return;
  }
  toAgent(effects, "logs.search.cancel", { requestId: request.agentId }, nowMs);
  effects.push({
    type: "audit",
    record: {
      action: "server.logs_search",
      failed: false,
      outcome: "cancelled",
      input: request.search!,
      durationMs: nowMs - request.startedMs,
    },
  });
}

function context(
  state: LogRelayState,
  payload: AgentWsV2PayloadOf<"logs.context">,
  nowMs: number,
  dependencies: LogRelayDependencies,
  effects: LogRelayEffect[],
): void {
  const requestId = payload.requestId;
  if (state.pending.some((request) => request.clientId === requestId)) {
    effects.push(
      clientError(
        "invalid_request",
        { requestId },
        "request id is in use",
        nowMs,
      ),
    );
    return;
  }
  const contexts = state.pending.filter(
    (request) => request.kind === "context",
  ).length;
  if (contexts >= LOG_RELAY_LIMITS.contextConcurrent) {
    effects.push(
      clientError(
        "busy",
        { requestId },
        "too many concurrent context lookups",
        nowMs,
      ),
    );
    return;
  }
  const agentId = dependencies.newId();
  state.pending.push({
    kind: "context",
    clientId: requestId,
    agentId,
    deadlineMs: nowMs + LOG_RELAY_LIMITS.requestTimeoutMs,
    startedMs: nowMs,
    search: null,
    context: { before: payload.before, after: payload.after },
  });
  toAgent(
    effects,
    "logs.context",
    {
      requestId: agentId,
      generation: payload.generation,
      seq: payload.seq,
      before: payload.before,
      after: payload.after,
    },
    nowMs,
  );
}

function searchAuditInput(
  query: AgentWsV2LogQuery,
  limit: number,
  continued: boolean,
): LogSearchAuditInput {
  return {
    ...(query.source ? { source: query.source } : {}),
    ...(query.minLevel ? { minLevel: query.minLevel } : {}),
    ...(query.since ? { since: query.since } : {}),
    ...(query.until ? { until: query.until } : {}),
    limit,
    textSearch: query.text !== undefined,
    continued,
  };
}

// ---------------------------------------------------------------------------
// Agent -> browser
// ---------------------------------------------------------------------------

function onAgentFrame(
  state: LogRelayState,
  text: string,
  nowMs: number,
  effects: LogRelayEffect[],
): void {
  const parsed = parseAgentWsV2Frame(text, "agent");
  if (!parsed.ok || parsed.message.kind === "unknown") {
    return;
  }
  const message = parsed.message;
  switch (message.kind) {
    case "logs.batch":
      onTailBatch(state, message.payload, nowMs, effects);
      return;
    case "logs.gap": {
      const current = state.subscription;
      if (!current || current.agentId !== message.payload.subscriptionId) {
        return;
      }
      effects.push({
        type: "send",
        frame: browserFrame(
          "logs.gap",
          { ...message.payload, subscriptionId: current.clientId },
          nowMs,
        ),
      });
      return;
    }
    case "logs.search.result": {
      const request = takeRequest(state, "search", message.payload.requestId);
      if (!request) {
        return; // Cancelled, timed out, or not ours: the late reply is dropped.
      }
      effects.push({
        type: "send",
        frame: browserFrame(
          "logs.search.result",
          { ...message.payload, requestId: request.clientId },
          nowMs,
        ),
      });
      effects.push({
        type: "audit",
        record: {
          action: "server.logs_search",
          failed: false,
          outcome: "ok",
          input: request.search!,
          durationMs: nowMs - request.startedMs,
          matches: message.payload.matches.length,
          coverageGap: message.payload.coverage.gap,
        },
      });
      return;
    }
    case "logs.context.result": {
      const request = takeRequest(state, "context", message.payload.requestId);
      if (!request) {
        return;
      }
      effects.push({
        type: "send",
        frame: browserFrame(
          "logs.context.result",
          { ...message.payload, requestId: request.clientId },
          nowMs,
        ),
      });
      effects.push({
        type: "audit",
        record: {
          action: "server.logs_context",
          failed: false,
          outcome: "ok",
          input: request.context!,
          durationMs: nowMs - request.startedMs,
        },
      });
      return;
    }
    case "logs.error":
      onAgentError(state, message.payload, nowMs, effects);
      return;
    default:
      return;
  }
}

function onTailBatch(
  state: LogRelayState,
  payload: AgentWsV2PayloadOf<"logs.batch">,
  nowMs: number,
  effects: LogRelayEffect[],
): void {
  const current = state.subscription;
  if (!current || current.agentId !== payload.subscriptionId) {
    return; // A batch for a subscription this relay no longer holds.
  }
  const frame = browserFrame(
    "logs.batch",
    { ...payload, subscriptionId: current.clientId },
    nowMs,
  );
  // An empty batch loses nothing and only moves the cursor, so it is not paced.
  if (
    payload.records.length === 0 ||
    takeOutbound(state, frame.length, nowMs)
  ) {
    effects.push({ type: "send", frame });
    return;
  }
  // The browser cannot keep up. Report the range it will not receive, and keep
  // the tail running: the browser's own cursor decides what it must re-read.
  state.dropped.batches += 1;
  state.dropped.records += payload.records.length;
  const first = payload.records[0];
  const last = payload.records[payload.records.length - 1];
  if (first && last) {
    effects.push({
      type: "send",
      frame: browserFrame(
        "logs.gap",
        {
          subscriptionId: current.clientId,
          generation: payload.next.generation,
          gap: { reason: "dropped", fromSeq: first.seq, toSeq: last.seq },
        },
        nowMs,
      ),
    });
  }
}

function onAgentError(
  state: LogRelayState,
  payload: AgentWsV2PayloadOf<"logs.error">,
  nowMs: number,
  effects: LogRelayEffect[],
): void {
  if (payload.subscriptionId !== undefined) {
    const current = state.subscription;
    if (!current || current.agentId !== payload.subscriptionId) {
      return;
    }
    state.subscription = null;
    effects.push({
      type: "send",
      frame: browserFrame(
        "logs.error",
        {
          code: payload.code,
          subscriptionId: current.clientId,
          message: payload.message,
        },
        nowMs,
      ),
    });
    return;
  }
  const requestId = payload.requestId;
  const request =
    requestId === undefined ? undefined : takeRequestById(state, requestId);
  if (!request) {
    return;
  }
  effects.push({
    type: "send",
    frame: browserFrame(
      "logs.error",
      {
        code: payload.code,
        requestId: request.clientId,
        message: payload.message,
      },
      nowMs,
    ),
  });
  effects.push({
    type: "audit",
    record:
      request.kind === "search"
        ? {
            action: "server.logs_search",
            failed: true,
            outcome: payload.code,
            input: request.search!,
            durationMs: nowMs - request.startedMs,
          }
        : {
            action: "server.logs_context",
            failed: true,
            outcome: payload.code,
            input: request.context!,
            durationMs: nowMs - request.startedMs,
          },
  });
}

/** Removes and returns the pending request of `kind` that the agent id names. */
function takeRequest(
  state: LogRelayState,
  kind: "search" | "context",
  agentId: string,
): LogRelayPending | undefined {
  const index = state.pending.findIndex(
    (request) => request.kind === kind && request.agentId === agentId,
  );
  if (index === -1) {
    return undefined;
  }
  return state.pending.splice(index, 1)[0];
}

function takeRequestById(
  state: LogRelayState,
  agentId: string,
): LogRelayPending | undefined {
  const index = state.pending.findIndex(
    (request) => request.agentId === agentId,
  );
  if (index === -1) {
    return undefined;
  }
  return state.pending.splice(index, 1)[0];
}

// ---------------------------------------------------------------------------
// Deadlines, pacing and lifecycle
// ---------------------------------------------------------------------------

function expireRequests(
  state: LogRelayState,
  nowMs: number,
  effects: LogRelayEffect[],
): void {
  const expired = state.pending.filter(
    (request) => request.deadlineMs <= nowMs,
  );
  if (expired.length === 0) {
    return;
  }
  state.pending = state.pending.filter((request) => request.deadlineMs > nowMs);
  for (const request of expired) {
    if (request.kind === "search") {
      // Stop the agent's scan too. Its late reply then finds no owner.
      toAgent(
        effects,
        "logs.search.cancel",
        { requestId: request.agentId },
        nowMs,
      );
    }
    effects.push(
      clientError(
        "timeout",
        { requestId: request.clientId },
        "the agent did not answer in time",
        nowMs,
      ),
    );
    effects.push({
      type: "audit",
      record:
        request.kind === "search"
          ? {
              action: "server.logs_search",
              failed: true,
              outcome: "timeout",
              input: request.search!,
              durationMs: nowMs - request.startedMs,
            }
          : {
              action: "server.logs_context",
              failed: true,
              outcome: "timeout",
              input: request.context!,
              durationMs: nowMs - request.startedMs,
            },
    });
  }
}

/**
 * Token bucket for tail batches. Refills by elapsed time, then spends `bytes`
 * when enough is available. Returns false, spending nothing, when over budget.
 */
function takeOutbound(
  state: LogRelayState,
  bytes: number,
  nowMs: number,
): boolean {
  const elapsed = Math.max(0, nowMs - state.bucket.updatedMs);
  state.bucket.tokens = Math.min(
    LOG_RELAY_LIMITS.outboundBurstBytes,
    state.bucket.tokens +
      (elapsed * LOG_RELAY_LIMITS.outboundBytesPerSecond) / 1000,
  );
  state.bucket.updatedMs = nowMs;
  if (state.bucket.tokens < bytes) {
    return false;
  }
  state.bucket.tokens -= bytes;
  return true;
}

/**
 * Ends the relay. The agent is told to stop its tail and searches only when
 * this side ends the relay, and never when the agent itself is gone.
 */
function finish(
  state: LogRelayState,
  reason: string,
  nowMs: number,
  effects: LogRelayEffect[],
  options: { cancelAgent: boolean; closeCode: number },
): void {
  if (options.cancelAgent) {
    if (state.subscription) {
      toAgent(
        effects,
        "logs.unsubscribe",
        {
          subscriptionId: state.subscription.agentId,
        },
        nowMs,
      );
    }
    for (const request of state.pending) {
      if (request.kind === "search") {
        toAgent(
          effects,
          "logs.search.cancel",
          { requestId: request.agentId },
          nowMs,
        );
      }
    }
  }
  state.subscription = null;
  state.pending = [];
  state.closed = true;
  effects.push({
    type: "audit",
    record: {
      action: "server.logs_close",
      failed: false,
      reason,
      droppedBatches: state.dropped.batches,
      droppedRecords: state.dropped.records,
    },
  });
  effects.push({ type: "close", code: options.closeCode, reason });
}

// ---------------------------------------------------------------------------
// Frame encoding
// ---------------------------------------------------------------------------

function browserFrame(type: string, payload: object, nowMs: number): string {
  return JSON.stringify({
    v: 2,
    type,
    ts: new Date(nowMs).toISOString(),
    payload,
  });
}

function clientError(
  code: string,
  ids: { subscriptionId?: string; requestId?: string },
  message: string,
  nowMs: number,
): LogRelayEffect {
  return {
    type: "send",
    frame: browserFrame("logs.error", { code, ...ids, message }, nowMs),
  };
}

function toAgent(
  effects: LogRelayEffect[],
  type:
    | "logs.subscribe"
    | "logs.unsubscribe"
    | "logs.search"
    | "logs.search.cancel"
    | "logs.context",
  payload: object,
  nowMs: number,
): void {
  effects.push({
    type: "toAgent",
    frame: encodeAgentWsV2Frame(
      createAgentWsV2Frame(type, payload as never, {
        ts: new Date(nowMs).toISOString(),
      }),
    ),
  });
}
