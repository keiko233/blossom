import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  parseAgentWsV2Frame,
  type AgentWsV2PayloadOf,
} from "@blossom/contracts/agent-ws-v2";
import {
  parseAdminLogsServerFrame,
  type AgentWsV2LogRecord,
} from "@blossom/contracts/agent-ws-v2-logs";
import { describe, expect, it } from "vitest";

import {
  createLogRelayState,
  LOG_RELAY_CLOSE,
  LOG_RELAY_LIMITS,
  ownedAgentIds,
  reduceLogRelay,
  type LogRelayAuditRecord,
  type LogRelayEffect,
  type LogRelayEvent,
  type LogRelayRevocation,
  type LogRelayState,
} from "./logs-relay";

const T0 = Date.parse("2026-11-19T00:00:00.000Z");
const GEN = "9007199254740993"; // above 2^53: must survive as a string
const SERVER = "srv-1";
const SESSION = "sess-1";

// ---------------------------------------------------------------------------
// Stand-in agent: the agent side of the v2 log contract, with the retained
// buffer semantics of `server-agent/src/logs/` (sequence per generation,
// FIFO eviction reported as a gap, newest-first search pages, same-run context).
// ---------------------------------------------------------------------------

interface StoredRecord extends AgentWsV2LogRecord {
  generation: string;
}

interface AgentSubscription {
  filter: { source?: string; minLevel?: string };
  cursor: { generation: string; seq: number };
}

class StandInAgent {
  generation = GEN;
  records: StoredRecord[] = [];
  nextSeq = 1;
  evictedThrough = 0;
  readonly subscriptions = new Map<string, AgentSubscription>();
  /** When set, searches are answered later by `releaseHeld`: a slow scan. */
  holdSearches = false;
  readonly held: string[] = [];
  readonly seen: { type: string; payload: unknown }[] = [];
  private readonly cancelled = new Set<string>();
  private readonly levels = ["trace", "debug", "info", "warn", "error"];

  constructor(
    private readonly maxLines = 1000,
    private readonly capabilities: string[] = [
      "logs-tail-v1",
      "logs-search-v1",
    ],
  ) {}

  append(
    text: string,
    source: "agent" | "sing-box" = "agent",
    level = "info",
  ): void {
    const seq = this.nextSeq++;
    this.records.push({
      seq,
      time: new Date(T0 + seq * 1000).toISOString(),
      source,
      level: level as AgentWsV2LogRecord["level"],
      processGeneration: source === "agent" ? 0 : 1,
      text,
      truncated: false,
      generation: this.generation,
    });
    while (this.records.length > this.maxLines) {
      const evicted = this.records.shift()!;
      this.evictedThrough = evicted.seq;
    }
  }

  restart(generation: string): void {
    this.generation = generation;
    this.records = [];
    this.nextSeq = 1;
    this.evictedThrough = 0;
    this.subscriptions.clear();
  }

  /** Handles one control-plane frame and returns the agent's replies. */
  handle(text: string): string[] {
    const parsed = parseAgentWsV2Frame(text, "control-plane");
    if (!parsed.ok || parsed.message.kind === "unknown") {
      throw new Error(
        `stand-in agent rejected a frame: ${JSON.stringify(parsed)}`,
      );
    }
    const message = parsed.message;
    this.seen.push({ type: message.kind, payload: message.payload });
    if (
      !this.capabilities.includes("logs-search-v1") &&
      message.kind !== "logs.subscribe"
    ) {
      return [];
    }
    switch (message.kind) {
      case "logs.subscribe":
        return this.subscribe(message.payload);
      case "logs.unsubscribe":
        this.subscriptions.delete(message.payload.subscriptionId);
        return [];
      case "logs.search":
        return this.search(message.payload);
      case "logs.search.cancel":
        // A reply already in flight still arrives; the relay must drop it.
        this.cancelled.add(message.payload.requestId);
        return [];
      case "logs.context":
        return [this.context(message.payload)];
      default:
        return [];
    }
  }

  /** Sends every search reply the agent held, as a slow scan that finished. */
  releaseHeld(): string[] {
    return this.held.splice(0);
  }

  private frame(type: string, payload: object): string {
    return encodeAgentWsV2Frame(
      createAgentWsV2Frame(type as never, payload as never, {
        ts: new Date(T0 + this.nextSeq * 1000).toISOString(),
      }),
    );
  }

  private matches(
    record: StoredRecord,
    filter: AgentSubscription["filter"],
  ): boolean {
    if (filter.source && record.source !== filter.source) return false;
    if (
      filter.minLevel &&
      this.levels.indexOf(record.level) < this.levels.indexOf(filter.minLevel)
    )
      return false;
    return true;
  }

  private subscribe(payload: AgentWsV2PayloadOf<"logs.subscribe">): string[] {
    this.subscriptions.set(payload.subscriptionId, {
      filter: payload.filter,
      cursor: payload.resume ?? {
        generation: this.generation,
        seq: this.nextSeq - 1,
      },
    });
    const replies: string[] = [];
    const resume = payload.resume;
    const newest = this.nextSeq - 1;
    let after = resume?.seq ?? Math.max(0, newest - payload.limit);
    if (resume && resume.generation !== this.generation) {
      replies.push(
        this.frame("logs.gap", {
          subscriptionId: payload.subscriptionId,
          generation: this.generation,
          gap: { reason: "restarted", fromSeq: 0, toSeq: 0 },
        }),
      );
      after = Math.max(0, newest - payload.limit);
    } else if (resume && resume.seq + 1 <= this.evictedThrough) {
      replies.push(
        this.frame("logs.gap", {
          subscriptionId: payload.subscriptionId,
          generation: this.generation,
          gap: {
            reason: "overwritten",
            fromSeq: resume.seq + 1,
            toSeq: this.evictedThrough,
          },
        }),
      );
    }
    const pending = this.records.filter(
      (record) => record.seq > after && this.matches(record, payload.filter),
    );
    const page = pending.slice(0, payload.limit);
    const last = this.records
      .filter((record) => record.seq > after)
      .slice(0, payload.limit)
      .at(-1);
    replies.push(
      this.frame("logs.batch", {
        subscriptionId: payload.subscriptionId,
        next: { generation: this.generation, seq: last ? last.seq : after },
        hasMore:
          this.records.filter((record) => record.seq > after).length >
          payload.limit,
        records: page.map(stripGeneration),
      }),
    );
    return replies;
  }

  private search(payload: AgentWsV2PayloadOf<"logs.search">): string[] {
    const cursor = payload.cursor;
    const query = payload.query;
    const needle = query.text?.toLowerCase();
    let before = this.nextSeq;
    let pinned = this.nextSeq - 1;
    let floor = this.evictedThrough;
    let gap: "restarted" | "overwritten" | null = null;
    if (cursor) {
      if (
        cursor.generation !== this.generation ||
        cursor.before > this.nextSeq
      ) {
        gap = "restarted";
      } else {
        if (
          this.evictedThrough > cursor.floor &&
          cursor.floor + 1 < cursor.before
        ) {
          gap = "overwritten";
        }
        before = cursor.before;
        pinned = cursor.pinnedSeq;
        floor = cursor.floor;
      }
    }
    const matches: StoredRecord[] = [];
    let next: AgentWsV2PayloadOf<"logs.search.result">["next"] = null;
    if (gap === null) {
      const window = this.records
        .filter((record) => record.seq < before)
        .reverse();
      for (const [index, record] of window.entries()) {
        if (needle && !record.text.toLowerCase().includes(needle)) continue;
        if (query.source && record.source !== query.source) continue;
        if (
          query.minLevel &&
          this.levels.indexOf(record.level) <
            this.levels.indexOf(query.minLevel)
        )
          continue;
        if (query.since && record.time < query.since) continue;
        if (query.until && record.time >= query.until) continue;
        matches.push(record);
        if (matches.length === payload.limit) {
          const more = index + 1 < window.length;
          next = more
            ? {
                generation: this.generation,
                pinnedSeq: pinned,
                before: record.seq,
                floor,
              }
            : null;
          break;
        }
      }
    }
    const reply = this.frame("logs.search.result", {
      requestId: payload.requestId,
      generation: this.generation,
      pinnedSeq: pinned,
      matches: matches.map(stripGeneration),
      next,
      coverage: {
        gap,
        searchableFrom: this.records[0]?.time ?? null,
        searchableTo: this.records.at(-1)?.time ?? null,
      },
    });
    if (this.cancelled.has(payload.requestId)) {
      return [];
    }
    if (this.holdSearches) {
      this.held.push(reply);
      return [];
    }
    return [reply];
  }

  private context(payload: AgentWsV2PayloadOf<"logs.context">): string {
    if (payload.generation !== this.generation) {
      return this.frame("logs.error", {
        code: "restarted",
        requestId: payload.requestId,
        message: "the buffer restarted",
      });
    }
    const index = this.records.findIndex(
      (record) => record.seq === payload.seq,
    );
    if (index === -1) {
      const code =
        payload.seq <= this.evictedThrough ? "overwritten" : "not_found";
      return this.frame("logs.error", {
        code,
        requestId: payload.requestId,
        message: "record is not retained",
      });
    }
    const target = this.records[index]!;
    const sameRun = (record: StoredRecord) =>
      record.source === target.source &&
      record.processGeneration === target.processGeneration;
    const before = this.records
      .slice(0, index)
      .filter(sameRun)
      .slice(-payload.before);
    const after = this.records
      .slice(index + 1)
      .filter(sameRun)
      .slice(0, payload.after);
    return this.frame("logs.context.result", {
      requestId: payload.requestId,
      generation: this.generation,
      target: stripGeneration(target),
      before: before.map(stripGeneration),
      after: after.map(stripGeneration),
    });
  }
}

function stripGeneration(record: StoredRecord): AgentWsV2LogRecord {
  const { generation: _generation, ...rest } = record;
  return rest;
}

// ---------------------------------------------------------------------------
// Harness: runs the reducer, performs its effects against the stand-in agent,
// and collects what the browser, the audit log and the close see.
// ---------------------------------------------------------------------------

interface Harness {
  state: LogRelayState;
  agent: StandInAgent;
  browserFrames: { type: string; payload: Record<string, unknown> }[];
  browserRaw: string[];
  audits: LogRelayAuditRecord[];
  closes: { code: number; reason: string }[];
  browser(text: string, nowMs?: number): void;
  tick(nowMs: number): void;
  agentFrame(
    text: string,
    nowMs?: number,
    sessionId?: string,
    serverId?: string,
  ): void;
  revoke(reason: LogRelayRevocation, nowMs?: number): void;
  event(event: LogRelayEvent): void;
  now: number;
}

function harness(options: { agent?: StandInAgent } = {}): Harness {
  let counter = 0;
  const dependencies = { newId: () => `agent-${++counter}` };
  const agent = options.agent ?? new StandInAgent();
  const state = createLogRelayState({
    relayId: "relay-1",
    serverId: SERVER,
    sessionId: SESSION,
    nowMs: T0,
  });
  const h: Harness = {
    state,
    agent,
    browserFrames: [],
    browserRaw: [],
    audits: [],
    closes: [],
    now: T0,
    browser(text, nowMs = h.now) {
      h.now = nowMs;
      run({ type: "browser", text, nowMs });
    },
    tick(nowMs) {
      h.now = nowMs;
      run({ type: "tick", nowMs });
    },
    agentFrame(text, nowMs = h.now, sessionId = SESSION, serverId = SERVER) {
      h.now = nowMs;
      run({ type: "agent", serverId, sessionId, text, nowMs });
    },
    revoke(reason, nowMs = h.now) {
      h.now = nowMs;
      run({ type: "revoked", reason, nowMs });
    },
    event(event) {
      h.now = event.nowMs;
      run(event);
    },
  };

  function run(event: LogRelayEvent): void {
    const effects = reduceLogRelay(state, event, dependencies);
    perform(effects, event.nowMs);
  }

  function perform(effects: LogRelayEffect[], nowMs: number): void {
    for (const effect of effects) {
      switch (effect.type) {
        case "send": {
          h.browserRaw.push(effect.frame);
          const parsed = parseAdminLogsServerFrame(effect.frame);
          if (!parsed.ok) {
            throw new Error(
              `browser received an invalid frame: ${JSON.stringify(parsed)}`,
            );
          }
          h.browserFrames.push({
            type: parsed.frame.type,
            payload: parsed.frame.payload as Record<string, unknown>,
          });
          break;
        }
        case "toAgent":
          for (const reply of agent.handle(effect.frame)) {
            run({
              type: "agent",
              serverId: SERVER,
              sessionId: SESSION,
              text: reply,
              nowMs,
            });
          }
          break;
        case "audit":
          h.audits.push(effect.record);
          break;
        case "close":
          h.closes.push({ code: effect.code, reason: effect.reason });
          break;
      }
    }
  }

  return h;
}

function browserFrame(type: string, payload: object, ts = T0): string {
  return JSON.stringify({
    v: 2,
    type,
    ts: new Date(ts).toISOString(),
    payload,
  });
}

const TAIL = "tab-1";

function subscribe(h: Harness, overrides: Record<string, unknown> = {}): void {
  h.browser(
    browserFrame("logs.subscribe", {
      subscriptionId: TAIL,
      filter: {},
      resume: null,
      limit: 200,
      ...overrides,
    }),
  );
}

function fill(
  agent: StandInAgent,
  count: number,
  source: "agent" | "sing-box" = "agent",
): void {
  for (let n = 0; n < count; n += 1) {
    agent.append(
      `line ${agent.nextSeq}`,
      source,
      n % 3 === 0 ? "warn" : "info",
    );
  }
}

// ---------------------------------------------------------------------------

describe("log relay tail subscription", () => {
  it("binds the agent to a relay-generated id and returns batches under the browser's id", () => {
    const h = harness();
    fill(h.agent, 3);
    subscribe(h);

    const subscribeToAgent = h.agent.seen.find(
      (entry) => entry.type === "logs.subscribe",
    )!;
    const agentId = (subscribeToAgent.payload as { subscriptionId: string })
      .subscriptionId;
    expect(agentId).not.toBe(TAIL);
    expect(ownedAgentIds(h.state)).toEqual([agentId]);

    const batch = h.browserFrames.find((frame) => frame.type === "logs.batch")!;
    expect(batch.payload.subscriptionId).toBe(TAIL);
    expect((batch.payload.records as unknown[]).length).toBe(3);
    expect(h.browserRaw.join("")).not.toContain(agentId);
    expect(h.audits).toContainEqual({
      action: "server.logs_subscribe",
      failed: false,
      input: { resumed: false },
    });
  });

  it("reports an overwritten gap when a resumed cursor fell behind eviction", () => {
    const agent = new StandInAgent(4);
    const h = harness({ agent });
    fill(agent, 10);
    subscribe(h, { resume: { generation: GEN, seq: 2 } });

    const gap = h.browserFrames.find((frame) => frame.type === "logs.gap")!;
    expect(gap.payload.gap).toEqual({
      reason: "overwritten",
      fromSeq: 3,
      toSeq: 6,
    });
    expect(gap.payload.subscriptionId).toBe(TAIL);
    const batch = h.browserFrames.find((frame) => frame.type === "logs.batch")!;
    expect(
      (batch.payload.records as { seq: number }[]).map((record) => record.seq),
    ).toEqual([7, 8, 9, 10]);
  });

  it("reports a restart gap with no range when the generation changed", () => {
    const h = harness();
    fill(h.agent, 2);
    subscribe(h, { resume: { generation: "1", seq: 1 } });
    const gap = h.browserFrames.find((frame) => frame.type === "logs.gap")!;
    expect(gap.payload.gap).toEqual({
      reason: "restarted",
      fromSeq: 0,
      toSeq: 0,
    });
  });

  it("replaces a live tail and ignores a batch from the replaced subscription", () => {
    const h = harness();
    fill(h.agent, 2);
    subscribe(h);
    const first = ownedAgentIds(h.state)[0]!;
    subscribe(h);
    const second = ownedAgentIds(h.state)[0]!;
    expect(second).not.toBe(first);

    const sentBefore = h.browserFrames.length;
    h.agentFrame(
      encodeAgentWsV2Frame(
        createAgentWsV2Frame(
          "logs.batch",
          {
            subscriptionId: first,
            next: { generation: GEN, seq: 9 },
            hasMore: false,
            records: [],
          },
          { ts: new Date(T0).toISOString() },
        ),
      ),
    );
    expect(h.browserFrames.length).toBe(sentBefore);
  });

  it("drops tail batches over the outbound budget and reports the dropped range", () => {
    const h = harness();
    subscribe(h);
    const subscriptionId = ownedAgentIds(h.state)[0]!;
    const sentBefore = h.browserFrames.length;
    // An empty bucket, so the next batch is over budget.
    h.state.bucket = { tokens: 0, updatedMs: T0 };
    h.agentFrame(
      encodeAgentWsV2Frame(
        createAgentWsV2Frame(
          "logs.batch",
          {
            subscriptionId,
            next: { generation: GEN, seq: 5 },
            hasMore: false,
            records: [1, 2, 3, 4, 5].map((seq) => ({
              seq,
              time: new Date(T0).toISOString(),
              source: "agent",
              level: "info",
              processGeneration: 0,
              text: "x",
              truncated: false,
            })),
          },
          { ts: new Date(T0).toISOString() },
        ),
      ),
      T0,
    );
    const sentSince = h.browserFrames.slice(sentBefore);
    expect(
      sentSince.filter((frame) => frame.type === "logs.batch"),
    ).toHaveLength(0);
    expect(sentSince.at(-1)).toMatchObject({
      type: "logs.gap",
      payload: { gap: { reason: "dropped", fromSeq: 1, toSeq: 5 } },
    });
    h.event({ type: "browserClosed", nowMs: T0 + 1 });
    expect(h.audits.at(-1)).toMatchObject({
      action: "server.logs_close",
      droppedBatches: 1,
      droppedRecords: 5,
    });
  });

  it("refills the outbound budget with elapsed time", () => {
    const h = harness();
    subscribe(h);
    const subscriptionId = ownedAgentIds(h.state)[0]!;
    h.state.bucket = { tokens: 0, updatedMs: T0 };
    const batch = (seq: number) =>
      encodeAgentWsV2Frame(
        createAgentWsV2Frame(
          "logs.batch",
          {
            subscriptionId,
            next: { generation: GEN, seq },
            hasMore: false,
            records: [
              {
                seq,
                time: new Date(T0).toISOString(),
                source: "agent",
                level: "info",
                processGeneration: 0,
                text: "x",
                truncated: false,
              },
            ],
          },
          { ts: new Date(T0).toISOString() },
        ),
      );
    const sentBefore = h.browserFrames.length;
    // Empty bucket: a record batch is over budget at once.
    h.agentFrame(batch(1), T0);
    expect(
      h.browserFrames.slice(sentBefore).map((frame) => frame.type),
    ).toEqual(["logs.gap"]);
    // One second later the bucket holds `outboundBytesPerSecond` bytes: enough
    // for this batch, and the refill never exceeds the burst allowance.
    h.agentFrame(batch(2), T0 + 1000);
    expect(
      h.browserFrames.slice(sentBefore).map((frame) => frame.type),
    ).toEqual(["logs.gap", "logs.batch"]);
    expect(h.state.bucket.tokens).toBeLessThanOrEqual(
      LOG_RELAY_LIMITS.outboundBurstBytes,
    );
  });

  it("reports a missing subscription to unsubscribe as not_found", () => {
    const h = harness();
    h.browser(browserFrame("logs.unsubscribe", { subscriptionId: "nope" }));
    expect(h.browserFrames.at(-1)).toMatchObject({
      type: "logs.error",
      payload: { code: "not_found", subscriptionId: "nope" },
    });
  });
});

describe("log relay search", () => {
  it("pages newest-first matches and returns the caller's request id", () => {
    const h = harness();
    for (const text of [
      "dial tcp refused",
      "ok",
      "Dial TCP timeout",
      "ok",
      "dial tcp reset",
    ]) {
      h.agent.append(text, "sing-box", "error");
    }
    h.browser(
      browserFrame("logs.search", {
        requestId: "s-1",
        query: { text: "DIAL TCP" },
        cursor: null,
        limit: 2,
      }),
    );
    const first = h.browserFrames.at(-1)!;
    expect(first.type).toBe("logs.search.result");
    expect(first.payload.requestId).toBe("s-1");
    expect(
      (first.payload.matches as { text: string }[]).map(
        (record) => record.text,
      ),
    ).toEqual(["dial tcp reset", "Dial TCP timeout"]);
    expect(first.payload.next).not.toBeNull();

    h.browser(
      browserFrame("logs.search", {
        requestId: "s-2",
        query: { text: "DIAL TCP" },
        cursor: first.payload.next,
        limit: 2,
      }),
    );
    const second = h.browserFrames.at(-1)!;
    expect(
      (second.payload.matches as { text: string }[]).map(
        (record) => record.text,
      ),
    ).toEqual(["dial tcp refused"]);
    expect(second.payload.next).toBeNull();
  });

  it("reports incomplete coverage when eviction overtakes a continuation", () => {
    const agent = new StandInAgent(6);
    const h = harness({ agent });
    for (let n = 0; n < 6; n += 1) agent.append(`match ${n}`);
    h.browser(
      browserFrame("logs.search", {
        requestId: "s-1",
        query: { text: "match" },
        cursor: null,
        limit: 2,
      }),
    );
    const first = h.browserFrames.at(-1)!;
    for (let n = 0; n < 6; n += 1) agent.append(`later ${n}`);
    h.browser(
      browserFrame("logs.search", {
        requestId: "s-2",
        query: { text: "match" },
        cursor: first.payload.next,
        limit: 2,
      }),
    );
    const second = h.browserFrames.at(-1)!;
    expect(second.payload.coverage).toMatchObject({ gap: "overwritten" });
    expect(second.payload.matches).toEqual([]);
  });

  it("limits concurrent searches and audits the busy outcome", () => {
    const agent = new StandInAgent();
    agent.holdSearches = true;
    const h = harness({ agent });
    fill(agent, 2);
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-1",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-2",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-3",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    expect(h.browserFrames.at(-1)).toMatchObject({
      type: "logs.error",
      payload: { code: "busy", requestId: "slow-3" },
    });
    expect(h.audits.at(-1)).toMatchObject({
      action: "server.logs_search",
      failed: true,
      outcome: "busy",
    });
  });

  it("answers a request past its deadline with timeout and drops the late reply", () => {
    const agent = new StandInAgent();
    agent.holdSearches = true;
    const h = harness({ agent });
    fill(agent, 2);
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-1",
        query: {},
        cursor: null,
        limit: 5,
      }),
      T0,
    );
    h.tick(T0 + LOG_RELAY_LIMITS.requestTimeoutMs);
    expect(h.browserFrames.at(-1)).toMatchObject({
      type: "logs.error",
      payload: { code: "timeout", requestId: "slow-1" },
    });
    // The agent was told to stop, and its late answer now finds no owner.
    expect(agent.seen.at(-1)?.type).toBe("logs.search.cancel");
    const framesBefore = h.browserFrames.length;
    for (const reply of agent.releaseHeld()) {
      h.agentFrame(reply, T0 + LOG_RELAY_LIMITS.requestTimeoutMs + 1);
    }
    expect(h.browserFrames.length).toBe(framesBefore);
    expect(ownedAgentIds(h.state)).toEqual([]);
  });

  it("cancels a search and drops the result that arrives afterwards", () => {
    const agent = new StandInAgent();
    agent.holdSearches = true;
    const h = harness({ agent });
    fill(agent, 2);
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-1",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    const framesBefore = h.browserFrames.length;
    h.browser(browserFrame("logs.search.cancel", { requestId: "slow-1" }));
    expect(agent.seen.at(-1)).toMatchObject({ type: "logs.search.cancel" });
    for (const reply of agent.releaseHeld()) h.agentFrame(reply);
    expect(h.browserFrames.length).toBe(framesBefore);
    expect(h.audits.at(-1)).toMatchObject({
      action: "server.logs_search",
      failed: false,
      outcome: "cancelled",
    });
  });

  it("rejects a reused request id", () => {
    const agent = new StandInAgent();
    agent.holdSearches = true;
    const h = harness({ agent });
    fill(agent, 1);
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-1",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-1",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    expect(h.browserFrames.at(-1)).toMatchObject({
      type: "logs.error",
      payload: { code: "invalid_request", requestId: "slow-1" },
    });
  });

  it("audits search metadata without the query text", () => {
    const h = harness();
    fill(h.agent, 2);
    h.browser(
      browserFrame("logs.search", {
        requestId: "s-1",
        query: {
          text: "password=hunter2",
          source: "sing-box",
          minLevel: "warn",
        },
        cursor: null,
        limit: 10,
      }),
    );
    const audit = h.audits.find(
      (record) => record.action === "server.logs_search" && !record.failed,
    );
    expect(audit).toMatchObject({
      input: {
        source: "sing-box",
        minLevel: "warn",
        limit: 10,
        textSearch: true,
        continued: false,
      },
    });
    expect(JSON.stringify(h.audits)).not.toContain("hunter2");
  });
});

describe("log relay context lookup", () => {
  it("returns same-run neighbours for a record", () => {
    const h = harness();
    fill(h.agent, 5);
    h.browser(
      browserFrame("logs.context", {
        requestId: "c-1",
        generation: GEN,
        seq: 3,
        before: 1,
        after: 1,
      }),
    );
    const result = h.browserFrames.at(-1)!;
    expect(result.type).toBe("logs.context.result");
    expect(result.payload.requestId).toBe("c-1");
    expect((result.payload.target as { seq: number }).seq).toBe(3);
    expect(
      (result.payload.before as { seq: number }[]).map((record) => record.seq),
    ).toEqual([2]);
    expect(
      (result.payload.after as { seq: number }[]).map((record) => record.seq),
    ).toEqual([4]);
  });

  it("maps an evicted record to overwritten and a stale generation to restarted", () => {
    const agent = new StandInAgent(3);
    const h = harness({ agent });
    fill(agent, 6);
    h.browser(
      browserFrame("logs.context", {
        requestId: "c-1",
        generation: GEN,
        seq: 1,
        before: 0,
        after: 0,
      }),
    );
    expect(h.browserFrames.at(-1)).toMatchObject({
      type: "logs.error",
      payload: { code: "overwritten", requestId: "c-1" },
    });
    h.browser(
      browserFrame("logs.context", {
        requestId: "c-2",
        generation: "7",
        seq: 5,
        before: 0,
        after: 0,
      }),
    );
    expect(h.browserFrames.at(-1)).toMatchObject({
      type: "logs.error",
      payload: { code: "restarted", requestId: "c-2" },
    });
  });

  it("refuses context windows above the contract's line bound", () => {
    const h = harness();
    fill(h.agent, 2);
    h.browser(
      browserFrame("logs.context", {
        requestId: "c-1",
        generation: GEN,
        seq: 1,
        before: 51,
        after: 0,
      }),
    );
    expect(h.browserFrames).toHaveLength(0);
    expect(h.closes).toEqual([
      { code: LOG_RELAY_CLOSE.invalidRequest, reason: "invalid-payload" },
    ]);
  });
});

describe("log relay isolation and lifecycle", () => {
  it("ignores frames from another server or from a replaced session", () => {
    const h = harness();
    fill(h.agent, 2);
    subscribe(h);
    const subscriptionId = ownedAgentIds(h.state)[0]!;
    const batch = encodeAgentWsV2Frame(
      createAgentWsV2Frame(
        "logs.batch",
        {
          subscriptionId,
          next: { generation: GEN, seq: 2 },
          hasMore: false,
          records: [],
        },
        { ts: new Date(T0).toISOString() },
      ),
    );
    const before = h.browserFrames.length;
    h.agentFrame(batch, T0, "sess-old");
    h.agentFrame(batch, T0, SESSION, "srv-other");
    expect(h.browserFrames.length).toBe(before);
    h.agentFrame(batch);
    expect(h.browserFrames.length).toBe(before + 1);
  });

  it("closes with the offline code when the agent is gone, without messaging the agent", () => {
    const h = harness();
    subscribe(h);
    const agentSeen = h.agent.seen.length;
    h.event({ type: "agentGone", reason: "agent_disconnected", nowMs: T0 + 5 });
    expect(h.closes).toEqual([
      { code: LOG_RELAY_CLOSE.offline, reason: "agent_disconnected" },
    ]);
    expect(h.agent.seen.length).toBe(agentSeen);
    expect(h.state.closed).toBe(true);
  });

  it("closes with the replaced code when a newer session takes over", () => {
    const h = harness();
    subscribe(h);
    h.event({ type: "agentGone", reason: "session_replaced", nowMs: T0 + 5 });
    expect(h.closes.at(-1)).toEqual({
      code: LOG_RELAY_CLOSE.sessionReplaced,
      reason: "session_replaced",
    });
  });

  it("ends a relay when access is revoked and stops the agent's tail and searches", () => {
    const agent = new StandInAgent();
    agent.holdSearches = true;
    const h = harness({ agent });
    fill(agent, 2);
    subscribe(h);
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-1",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    h.revoke("forbidden", T0 + 1);
    const types = agent.seen.map((entry) => entry.type);
    expect(types).toContain("logs.unsubscribe");
    expect(types).toContain("logs.search.cancel");
    expect(h.closes.at(-1)).toEqual({
      code: LOG_RELAY_CLOSE.forbidden,
      reason: "forbidden",
    });
    expect(h.audits.at(-1)).toMatchObject({
      action: "server.logs_close",
      reason: "forbidden",
    });
  });

  it("maps each revocation reason to its close code", () => {
    const cases = [
      ["server_disabled", LOG_RELAY_CLOSE.serverDisabled],
      ["session_replaced", LOG_RELAY_CLOSE.sessionReplaced],
      ["offline", LOG_RELAY_CLOSE.offline],
      ["unsupported", LOG_RELAY_CLOSE.unsupported],
    ] as const;
    for (const [reason, code] of cases) {
      const h = harness();
      h.revoke(reason);
      expect(h.closes).toEqual([{ code, reason }]);
    }
  });

  it("ends the relay on browser close and forgets every agent id", () => {
    const h = harness();
    subscribe(h);
    h.event({ type: "browserClosed", nowMs: T0 + 1 });
    expect(h.state.closed).toBe(true);
    expect(ownedAgentIds(h.state)).toEqual([]);
    expect(h.agent.seen.at(-1)?.type).toBe("logs.unsubscribe");
    expect(h.audits.at(-1)).toMatchObject({
      action: "server.logs_close",
      reason: "browser_closed",
    });
  });

  it("closes with 1008 on a malformed browser frame and 1009 when it is too large", () => {
    const malformed = harness();
    malformed.browser("{not json");
    expect(malformed.closes).toEqual([
      { code: LOG_RELAY_CLOSE.invalidRequest, reason: "invalid-json" },
    ]);

    const large = harness();
    large.browser("x".repeat(64 * 1024 + 1));
    expect(large.closes).toEqual([
      { code: LOG_RELAY_CLOSE.frameTooLarge, reason: "frame-too-large" },
    ]);
  });

  it("ignores every event after close", () => {
    const h = harness();
    h.revoke("forbidden");
    const frames = h.browserFrames.length;
    subscribe(h);
    h.tick(T0 + 999_999);
    expect(h.browserFrames.length).toBe(frames);
    expect(h.closes).toHaveLength(1);
  });

  it("keeps the state plain JSON so a Durable Object attachment can hold it", () => {
    const agent = new StandInAgent();
    const h = harness({ agent });
    fill(agent, 2);
    subscribe(h);
    h.browser(
      browserFrame("logs.search", {
        requestId: "slow-1",
        query: {},
        cursor: null,
        limit: 5,
      }),
    );
    const copy = JSON.parse(JSON.stringify(h.state)) as LogRelayState;
    expect(copy).toEqual(h.state);
  });
});
