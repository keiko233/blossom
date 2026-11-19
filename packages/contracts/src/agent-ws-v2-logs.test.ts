import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENT_WS_V2_AGENT_MESSAGE_TYPES,
  AGENT_WS_V2_CONTROL_MESSAGE_TYPES,
  AGENT_WS_V2_LIMITS,
  parseAgentWsV2Frame,
} from "./agent-ws-v2";
import {
  AGENT_WS_V2_LOGS_LIMITS,
  AGENT_WS_V2_LOGS_SEARCH_CAPABILITY,
  AGENT_WS_V2_LOGS_TAIL_CAPABILITY,
  agentWsV2LogQuerySchema,
  parseAdminLogsClientFrame,
  parseAdminLogsServerFrame,
} from "./agent-ws-v2-logs";

const fixtures = JSON.parse(
  readFileSync(
    new URL("../fixtures/agent-ws-v2-logs.frames.json", import.meta.url),
    "utf8",
  ),
) as {
  frames: {
    name: string;
    sender: "agent" | "control-plane" | "browser" | "control-plane-browser";
    expect: string;
    frame: unknown;
  }[];
};

function parseFixture(sender: string, text: string) {
  if (sender === "agent" || sender === "control-plane") {
    return parseAgentWsV2Frame(
      text,
      sender === "agent" ? "agent" : "control-plane",
    );
  }
  if (sender === "browser") {
    return parseAdminLogsClientFrame(text);
  }
  return parseAdminLogsServerFrame(text);
}

describe("agent WebSocket v2 log wire fixtures", () => {
  it.each(fixtures.frames.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      const result = parseFixture(
        fixture.sender,
        JSON.stringify(fixture.frame),
      );
      if (fixture.expect === "ok") {
        expect(result.ok, JSON.stringify(result)).toBe(true);
        return;
      }
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe(fixture.expect);
      }
    },
  );

  it("has at least one fixture for every log message type in each direction", () => {
    const covered = new Set(
      fixtures.frames
        .filter((fixture) => fixture.expect === "ok")
        .map((fixture) => (fixture.frame as { type: string }).type),
    );
    for (const type of [
      "logs.subscribe",
      "logs.unsubscribe",
      "logs.search",
      "logs.search.cancel",
      "logs.context",
      "logs.batch",
      "logs.gap",
      "logs.search.result",
      "logs.context.result",
      "logs.error",
    ]) {
      expect(covered, type).toContain(type);
    }
  });
});

describe("agent WebSocket v2 log registration", () => {
  it("extends the agent and control-plane type lists without removing v2 types", () => {
    expect(AGENT_WS_V2_AGENT_MESSAGE_TYPES).toContain("traffic.report");
    expect(AGENT_WS_V2_AGENT_MESSAGE_TYPES).toContain("logs.batch");
    expect(AGENT_WS_V2_CONTROL_MESSAGE_TYPES).toContain("welcome");
    expect(AGENT_WS_V2_CONTROL_MESSAGE_TYPES).toContain("logs.subscribe");
  });

  it("keeps the v2 frame limit unchanged", () => {
    expect(AGENT_WS_V2_LIMITS.maxFrameBytes).toBe(4 * 1024 * 1024);
  });

  it("names the two capabilities that gate the log surfaces", () => {
    expect(AGENT_WS_V2_LOGS_TAIL_CAPABILITY).toBe("logs-tail-v1");
    expect(AGENT_WS_V2_LOGS_SEARCH_CAPABILITY).toBe("logs-search-v1");
  });
});

describe("log frame bounds", () => {
  it("keeps a worst-case tail batch under the agent frame limit", () => {
    const text = '"\\'.repeat(2048); // 4096 characters, each escaped on the wire
    const record = {
      seq: 1,
      time: "2026-11-19T00:00:00.000Z",
      source: "sing-box",
      level: "error",
      processGeneration: 1,
      text,
      truncated: true,
    };
    const frame = {
      v: 2,
      type: "logs.batch",
      ts: "2026-11-19T00:00:00.000Z",
      payload: {
        subscriptionId: "sub-1",
        next: { generation: "1", seq: 200 },
        hasMore: true,
        records: Array.from(
          { length: AGENT_WS_V2_LOGS_LIMITS.batchMaxRecords },
          () => record,
        ),
      },
    };
    const bytes = new TextEncoder().encode(JSON.stringify(frame)).byteLength;
    expect(bytes).toBeLessThan(AGENT_WS_V2_LIMITS.maxFrameBytes);
    expect(parseAgentWsV2Frame(JSON.stringify(frame), "agent").ok).toBe(true);
  });

  it("rejects a browser request frame above its own byte bound", () => {
    const padded = JSON.stringify({
      v: 2,
      type: "logs.search",
      ts: "2026-11-19T00:00:00.000Z",
      payload: {
        requestId: "s",
        query: { text: "x".repeat(200) },
        cursor: null,
        limit: 10,
      },
    });
    const result = parseAdminLogsClientFrame(padded, { maxFrameBytes: 64 });
    expect(result).toEqual({ ok: false, code: "frame-too-large" });
  });

  it("counts search text in characters, as the agent does", () => {
    const astral = "\u{1F600}".repeat(256);
    expect(agentWsV2LogQuerySchema.safeParse({ text: astral }).success).toBe(
      true,
    );
    expect(
      agentWsV2LogQuerySchema.safeParse({ text: `${astral}x` }).success,
    ).toBe(false);
  });

  it("rejects invalid JSON and an unsupported envelope version on both browser surfaces", () => {
    expect(parseAdminLogsClientFrame("{")).toEqual({
      ok: false,
      code: "invalid-json",
    });
    expect(
      parseAdminLogsServerFrame(
        JSON.stringify({
          v: 1,
          type: "logs.batch",
          ts: "2026-11-19T00:00:00.000Z",
          payload: {},
        }),
      ),
    ).toEqual({ ok: false, code: "unsupported-version" });
  });
});
