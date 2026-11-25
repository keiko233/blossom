import type {
  AdminLogsServerFrame,
  AgentWsV2LogRecord,
  AgentWsV2LogsPayloadOf,
} from "@blossom/contracts/agent-ws-v2-logs";
import { describe, expect, it } from "vitest";

type AgentWsV2LogsBatchPayload = AgentWsV2LogsPayloadOf<"logs.batch">;
type AgentWsV2LogsGapPayload = AgentWsV2LogsPayloadOf<"logs.gap">;

import {
  adminLogsFrameDestination,
  appendLogBatch,
  appendLogGap,
  applyLogSearchResult,
  beginLogSearch,
  emptyLogSearch,
  emptyLogTail,
  failLogSearch,
  formatLogLine,
  isLogRecordEntry,
  logAvailability,
  logPhaseTone,
  logPolicyToolbarTone,
  logTimeLabel,
  nextLogIndex,
  sanitizeLogText,
  splitLogMatch,
} from "./admin-logs-view";

function record(seq: number, text = `line ${seq}`): AgentWsV2LogRecord {
  return {
    seq,
    time: `2026-11-19T12:00:${String(seq % 60).padStart(2, "0")}.000Z`,
    source: seq % 2 === 0 ? "sing-box" : "agent",
    level: "info",
    processGeneration: 1,
    text,
    truncated: false,
  };
}

function batch(
  records: AgentWsV2LogRecord[],
  nextSeq: number,
  generation = "100",
  hasMore = false,
): AgentWsV2LogsBatchPayload {
  return {
    subscriptionId: "sub-1",
    next: { generation, seq: nextSeq },
    hasMore,
    records,
  };
}

describe("appendLogBatch", () => {
  it("appends ascending records and advances the cursor", () => {
    const state = appendLogBatch(
      emptyLogTail,
      batch([record(1), record(2)], 2),
    );

    expect(state.entries).toHaveLength(2);
    expect(state.entries.map((entry) => entry.id)).toEqual([
      "record:100:1",
      "record:100:2",
    ]);
    expect(state.cursor).toEqual({ generation: "100", seq: 2 });
    expect(state.hasOlder).toBe(false);
  });

  it("ignores duplicate and rewound records", () => {
    const first = appendLogBatch(
      emptyLogTail,
      batch([record(1), record(2)], 2),
    );
    const second = appendLogBatch(first, batch([record(2), record(1)], 2));

    expect(second.entries).toHaveLength(2);
    expect(second.lastSeq).toBe(2);
  });

  it("marks a generation change as a restart", () => {
    const first = appendLogBatch(emptyLogTail, batch([record(1)], 1, "100"));
    const second = appendLogBatch(first, batch([record(1)], 1, "200"));

    expect(second.entries.map((entry) => entry.kind)).toEqual([
      "record",
      "gap",
      "record",
    ]);
    expect(second.entries[1]).toMatchObject({
      kind: "gap",
      reason: "restarted",
      generation: "200",
    });
    expect(second.lastSeq).toBe(1);
  });

  it("keeps older-page availability sticky", () => {
    const state = appendLogBatch(
      emptyLogTail,
      batch([record(5), record(6)], 6, "100", true),
    );
    const next = appendLogBatch(state, batch([record(7)], 7));

    expect(next.hasOlder).toBe(true);
  });
});

describe("adminLogsFrameDestination", () => {
  const ids = {
    subscriptionId: "sub-current",
    searchRequestId: "search-current",
    contextRequestId: "context-current",
  };
  const batchFrame: AdminLogsServerFrame = {
    type: "logs.batch",
    payload: {
      ...batch([record(1)], 1),
      subscriptionId: "sub-current",
    },
  };

  it("accepts frames for the current subscription only", () => {
    expect(adminLogsFrameDestination(batchFrame, ids)).toBe("tail");
    expect(
      adminLogsFrameDestination(
        {
          type: "logs.batch",
          payload: {
            ...batchFrame.payload,
            subscriptionId: "sub-old",
          },
        },
        ids,
      ),
    ).toBe("ignored");
  });

  it("ignores late search and context replies", () => {
    expect(
      adminLogsFrameDestination(
        {
          type: "logs.search.result",
          payload: {
            requestId: "search-old",
            generation: "100",
            pinnedSeq: 10,
            matches: [],
            next: null,
            coverage: {
              gap: null,
              searchableFrom: null,
              searchableTo: null,
            },
          },
        },
        ids,
      ),
    ).toBe("ignored");
    expect(
      adminLogsFrameDestination(
        {
          type: "logs.context.result",
          payload: {
            requestId: "context-current",
            generation: "100",
            target: record(1),
            before: [],
            after: [],
          },
        },
        ids,
      ),
    ).toBe("context");
  });

  it("routes errors by whichever id they name", () => {
    expect(
      adminLogsFrameDestination(
        {
          type: "logs.error",
          payload: {
            code: "timeout",
            requestId: "search-current",
            message: "timed out",
          },
        },
        ids,
      ),
    ).toBe("search");
    expect(
      adminLogsFrameDestination(
        {
          type: "logs.error",
          payload: {
            code: "offline",
            requestId: "search-old",
            message: "offline",
          },
        },
        ids,
      ),
    ).toBe("ignored");
  });
});

describe("appendLogGap", () => {
  it("records an overwritten range once", () => {
    const payload: AgentWsV2LogsGapPayload = {
      subscriptionId: "sub-1",
      generation: "100",
      gap: { reason: "overwritten", fromSeq: 3, toSeq: 7 },
    };
    const first = appendLogGap(emptyLogTail, payload);
    const second = appendLogGap(first, payload);

    expect(first.entries).toHaveLength(1);
    expect(first.entries[0]).toMatchObject({
      kind: "gap",
      reason: "overwritten",
      fromSeq: 3,
      toSeq: 7,
    });
    expect(second).toBe(first);
    expect(first.cursor).toEqual({ generation: "100", seq: 7 });
  });

  it("resets the cursor to the newest page after a restart", () => {
    const state = appendLogGap(emptyLogTail, {
      subscriptionId: "sub-1",
      generation: "200",
      gap: { reason: "restarted", fromSeq: 0, toSeq: 0 },
    });

    expect(state.cursor).toBeNull();
    expect(state.generation).toBe("200");
  });
});

describe("search state", () => {
  it("keeps results newest first and reports incomplete coverage", () => {
    const searching = beginLogSearch(emptyLogSearch, "search-1", "replace");
    expect(searching.status).toBe("searching");

    const complete = applyLogSearchResult(searching, {
      requestId: "search-1",
      generation: "100",
      pinnedSeq: 10,
      matches: [record(4), record(9)],
      next: null,
      coverage: {
        gap: "overwritten",
        searchableFrom: "2026-11-19T00:00:00.000Z",
        searchableTo: "2026-11-19T12:00:00.000Z",
      },
    });

    expect(complete.results.map((item) => item.seq)).toEqual([9, 4]);
    expect(complete.incomplete).toBe(true);
    expect(complete.status).toBe("complete");
  });

  it("appends a later page without duplicating records", () => {
    const first = applyLogSearchResult(emptyLogSearch, {
      requestId: "search-1",
      generation: "100",
      pinnedSeq: 10,
      matches: [record(9), record(7)],
      next: { generation: "100", pinnedSeq: 10, before: 7, floor: 1 },
      coverage: {
        gap: null,
        searchableFrom: null,
        searchableTo: null,
      },
    });
    const more = beginLogSearch(first, "search-2", "more");
    const complete = applyLogSearchResult(more, {
      requestId: "search-2",
      generation: "100",
      pinnedSeq: 10,
      matches: [record(7), record(3)],
      next: null,
      coverage: {
        gap: null,
        searchableFrom: null,
        searchableTo: null,
      },
    });

    expect(complete.results.map((item) => item.seq)).toEqual([9, 7, 3]);
  });

  it("keeps the previous page on failure", () => {
    const failed = failLogSearch(emptyLogSearch, "timeout");
    expect(failed.status).toBe("error");
    expect(failed.error).toBe("timeout");
  });
});

describe("logAvailability", () => {
  const online = {
    enabled: true,
    transportMode: "ws",
    wsConnectedAt: new Date("2026-11-19T00:00:00.000Z"),
    agentCapabilities: ["logs-tail-v1", "logs-search-v1"],
  };

  it("reports each capability independently", () => {
    expect(logAvailability(online)).toEqual({
      kind: "available",
      tail: true,
      search: true,
    });
    expect(
      logAvailability({ ...online, agentCapabilities: ["logs-search-v1"] }),
    ).toEqual({ kind: "available", tail: false, search: true });
  });

  it("distinguishes disabled, offline and unsupported", () => {
    expect(logAvailability({ ...online, enabled: false })).toEqual({
      kind: "disabled",
    });
    expect(logAvailability({ ...online, wsConnectedAt: null })).toEqual({
      kind: "offline",
    });
    expect(logAvailability({ ...online, agentCapabilities: [] })).toEqual({
      kind: "unsupported",
    });
  });
});

describe("safe text", () => {
  it("replaces control characters and flattens line breaks", () => {
    expect(sanitizeLogText("a\u0000b\u001Bc")).toBe("a\uFFFDb\uFFFDc");
    const line = record(1, "one\r\ntwo");
    expect(formatLogLine(line)).toContain("one \u21B5 two");
  });

  it("marks only literal matches", () => {
    expect(splitLogMatch("Error: bad value", "error")).toEqual([
      { text: "Error", match: true },
      { text: ": bad value", match: false },
    ]);
    expect(splitLogMatch("plain", "missing")).toEqual([
      { text: "plain", match: false },
    ]);
    expect(splitLogMatch("a.b", ".")).toEqual([
      { text: "a", match: false },
      { text: ".", match: true },
      { text: "b", match: false },
    ]);
  });

  it("formats the copy line with source, level and truncation", () => {
    const line = { ...record(2, "x"), truncated: true };
    expect(formatLogLine(line)).toMatch(
      /^\S+ \[sing-box\] \[INFO\] x \[truncated\]$/,
    );
    expect(logTimeLabel("2026-11-19T12:00:02.000Z")).toBe("12:00:02.000");
  });

  it("narrows record entries", () => {
    const state = appendLogBatch(emptyLogTail, batch([record(1)], 1));
    expect(isLogRecordEntry(state.entries[0]!)).toBe(true);
  });
});

describe("nextLogIndex", () => {
  it("clamps arrow, page, home and end movement", () => {
    expect(nextLogIndex("ArrowDown", 0, 5)).toBe(1);
    expect(nextLogIndex("ArrowDown", 4, 5)).toBe(4);
    expect(nextLogIndex("ArrowUp", 0, 5)).toBe(0);
    expect(nextLogIndex("PageDown", 1, 30, 10)).toBe(11);
    expect(nextLogIndex("PageUp", 1, 30, 10)).toBe(0);
    expect(nextLogIndex("Home", 9, 10)).toBe(0);
    expect(nextLogIndex("End", 0, 10)).toBe(9);
  });

  it("leaves unrelated keys to the browser and handles an empty list", () => {
    expect(nextLogIndex("Tab", 0, 5)).toBeNull();
    expect(nextLogIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("logPhaseTone", () => {
  it("maps every connection phase to a status tone", () => {
    expect(logPhaseTone("live")).toBe("success");
    expect(logPhaseTone("connecting")).toBe("info");
    expect(logPhaseTone("paused")).toBe("warning");
    expect(logPhaseTone("reconnecting")).toBe("warning");
    expect(logPhaseTone("unauthorized")).toBe("danger");
    expect(logPhaseTone("error")).toBe("danger");
    expect(logPhaseTone("idle")).toBe("muted");
    expect(logPhaseTone("unavailable")).toBe("muted");
    expect(logPhaseTone("unsupported")).toBe("muted");
  });
});

describe("logPolicyToolbarTone", () => {
  it("ranks errors over applying over pending", () => {
    expect(logPolicyToolbarTone(["pending", "error"])).toBe("danger");
    expect(logPolicyToolbarTone(["pending", "applying"])).toBe("info");
    expect(logPolicyToolbarTone(["pending"])).toBe("warning");
  });

  it("signals nothing when no source is waiting", () => {
    expect(logPolicyToolbarTone([])).toBeNull();
    expect(logPolicyToolbarTone(["in-sync", "not-reported"])).toBeNull();
    expect(logPolicyToolbarTone(["offline", "in-sync"])).toBeNull();
  });
});
