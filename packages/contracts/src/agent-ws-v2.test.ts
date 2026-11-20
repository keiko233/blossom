import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENT_WS_V2_LIMITS,
  AGENT_WS_V2_SUBPROTOCOL,
  agentWsV2ConfigAckPayloadSchema,
  agentWsV2HelloPayloadSchema,
  agentWsV2SnapshotBeginPayloadSchema,
  agentWsV2TrafficReportPayloadSchema,
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
  negotiateAgentWsProtocol,
  parseAgentWsV2Frame,
  type AgentWsV2Sender,
} from "./agent-ws-v2";

const TS = "2026-11-19T00:00:00.000Z";
const DESIRED = {
  desiredRevisionSeq: 7,
  desiredRevision: `7:sha256:${"a".repeat(64)}`,
};

describe("agent WebSocket v2 negotiation", () => {
  it("speaks v1 when the client offers no subprotocol", () => {
    expect(negotiateAgentWsProtocol(null)).toEqual({ protocol: "v1" });
    expect(negotiateAgentWsProtocol("")).toEqual({ protocol: "v1" });
    expect(negotiateAgentWsProtocol(" , ")).toEqual({ protocol: "v1" });
  });

  it("selects v2 when offered, alongside other tokens", () => {
    expect(negotiateAgentWsProtocol(AGENT_WS_V2_SUBPROTOCOL)).toEqual({
      protocol: "v2",
    });
    expect(
      negotiateAgentWsProtocol(`other.v9, ${AGENT_WS_V2_SUBPROTOCOL}`),
    ).toEqual({ protocol: "v2" });
  });

  it("reports an unsupported subprotocol distinctly instead of guessing", () => {
    expect(negotiateAgentWsProtocol("blossom-agent.v9")).toEqual({
      protocol: "unsupported",
      offered: ["blossom-agent.v9"],
    });
  });
});

describe("agent WebSocket v2 envelope", () => {
  it("round-trips a frame and keeps the correlation id", () => {
    const frame = createAgentWsV2Frame(
      "config.get",
      { requestId: "snap-1", reason: "initial" },
      { id: "corr-1", ts: TS },
    );
    expect(frame).toEqual({
      v: 2,
      id: "corr-1",
      type: "config.get",
      ts: TS,
      payload: { requestId: "snap-1", reason: "initial" },
    });

    const parsed = parseAgentWsV2Frame(encodeAgentWsV2Frame(frame), "agent");
    expect(parsed).toMatchObject({
      ok: true,
      frame: { id: "corr-1" },
      message: { kind: "config.get" },
    });
  });

  it("rejects a frame that does not carry v2 and does not decode as v2", () => {
    const v1 = JSON.stringify({ v: 1, type: "ping", ts: TS, payload: {} });
    expect(parseAgentWsV2Frame(v1, "agent")).toEqual({
      ok: false,
      code: "unsupported-version",
    });
    expect(
      parseAgentWsV2Frame(
        JSON.stringify({ v: 2, type: "config.get", payload: {} }),
        "agent",
      ),
    ).toEqual({ ok: false, code: "invalid-envelope" });
    expect(parseAgentWsV2Frame("{", "agent")).toEqual({
      ok: false,
      code: "invalid-json",
    });
  });

  it("bounds the frame size before decoding", () => {
    const text = JSON.stringify({
      v: 2,
      type: "future.thing",
      ts: TS,
      payload: { data: "x".repeat(64) },
    });
    expect(parseAgentWsV2Frame(text, "agent", { maxFrameBytes: 32 })).toEqual({
      ok: false,
      code: "frame-too-large",
    });
    expect(AGENT_WS_V2_LIMITS.maxFrameBytes).toBeGreaterThan(
      AGENT_WS_V2_LIMITS.snapshotChunkBytes,
    );
  });

  it("ignores well-formed frames of an unknown type", () => {
    const text = encodeAgentWsV2Frame(
      createAgentWsV2Frame("future.thing", { x: 1 }, { ts: TS }),
    );
    expect(parseAgentWsV2Frame(text, "agent")).toMatchObject({
      ok: true,
      message: { kind: "unknown", type: "future.thing" },
    });
  });
});

describe("agent WebSocket v2 direction", () => {
  it.each([
    ["agent", "welcome"],
    ["control-plane", "hello"],
  ] as const)(
    "rejects a %s-sent frame arriving from the wrong side (%s)",
    (sender: AgentWsV2Sender, type) => {
      const text = encodeAgentWsV2Frame(
        createAgentWsV2Frame(type, {} as never, { ts: TS }),
      );
      expect(parseAgentWsV2Frame(text, sender)).toEqual({
        ok: false,
        code: "invalid-direction",
        type,
      });
    },
  );
});

describe("agent WebSocket v2 payloads", () => {
  it("accepts an empty-cache hello and rejects a mismatched identifier", () => {
    expect(
      agentWsV2HelloPayloadSchema.parse({
        agentVersion: "0.4.0",
        agentBuildId: "build",
        applied: null,
      }),
    ).toMatchObject({ capabilities: [], applied: null });

    expect(
      agentWsV2HelloPayloadSchema.safeParse({
        agentVersion: "0.4.0",
        agentBuildId: "build",
        applied: { ...DESIRED, desiredRevisionSeq: 6 },
      }).success,
    ).toBe(false);
  });

  it("requires a failed config.ack to name its stage and error", () => {
    expect(
      agentWsV2ConfigAckPayloadSchema.safeParse({
        desired: DESIRED,
        outcome: "failed",
      }).success,
    ).toBe(false);
    expect(
      agentWsV2ConfigAckPayloadSchema.safeParse({
        desired: DESIRED,
        outcome: "applied",
      }).success,
    ).toBe(true);
  });

  it("requires a traffic report id and a bounded entry list", () => {
    expect(
      agentWsV2TrafficReportPayloadSchema.safeParse({
        reportId: "short",
        entries: [],
      }).success,
    ).toBe(false);
    expect(
      agentWsV2TrafficReportPayloadSchema.safeParse({
        reportId: "report-0001",
        entries: Array.from({ length: 10_001 }, () => ({
          subscriptionId: "sub",
          uplinkBytes: 0,
          downlinkBytes: 0,
        })),
      }).success,
    ).toBe(false);
  });

  it("ties the snapshot chunk count to the byte total", () => {
    const chunk = AGENT_WS_V2_LIMITS.snapshotChunkBytes;
    const base = {
      requestId: "snap-1",
      desired: DESIRED,
      contentType: "application/json" as const,
      digest: "b".repeat(64),
    };
    expect(
      agentWsV2SnapshotBeginPayloadSchema.safeParse({
        ...base,
        totalBytes: chunk * 2 + 1,
        chunkCount: 3,
      }).success,
    ).toBe(true);
    expect(
      agentWsV2SnapshotBeginPayloadSchema.safeParse({
        ...base,
        totalBytes: chunk * 2 + 1,
        chunkCount: 2,
      }).success,
    ).toBe(false);
    expect(
      agentWsV2SnapshotBeginPayloadSchema.safeParse({
        ...base,
        totalBytes: AGENT_WS_V2_LIMITS.maxSnapshotBytes + 1,
        chunkCount: 129,
      }).success,
    ).toBe(false);
  });
});

describe("managed link probe v2 frames", () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL(
        "../fixtures/agent-ws-v2-link-probe.frames.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as {
    subprotocol: string;
    frames: {
      name: string;
      sender: AgentWsV2Sender;
      expect: string;
      frame: unknown;
    }[];
  };

  it("registers both directions and decodes the shared fixtures", () => {
    expect(fixtures.subprotocol).toBe(AGENT_WS_V2_SUBPROTOCOL);
    for (const fixture of fixtures.frames) {
      const result = parseAgentWsV2Frame(
        JSON.stringify(fixture.frame),
        fixture.sender,
      );
      expect(result, fixture.name).toMatchObject({
        ok: true,
        message: { kind: expect.any(String) },
      });
      expect(result.ok ? result.message.kind : null, fixture.name).not.toBe(
        "unknown",
      );
    }
  });

  it("rejects a probe frame sent in the wrong direction", () => {
    const request = fixtures.frames.find(
      (fixture) =>
        fixture.frame &&
        (fixture.frame as { type?: string }).type === "link_probe.request",
    );
    if (!request) throw new Error("link_probe.request fixture is missing");
    expect(
      parseAgentWsV2Frame(JSON.stringify(request.frame), "agent"),
    ).toMatchObject({
      ok: false,
      code: "invalid-direction",
      type: "link_probe.request",
    });
  });
});

describe("agent WebSocket v2 wire fixtures", () => {
  const fixtures = JSON.parse(
    readFileSync(
      new URL("../fixtures/agent-ws-v2.frames.json", import.meta.url),
      "utf8",
    ),
  ) as {
    subprotocol: string;
    frames: {
      name: string;
      sender: AgentWsV2Sender;
      expect: string;
      frame: unknown;
    }[];
  };

  it("names the subprotocol the fixtures were written for", () => {
    expect(fixtures.subprotocol).toBe(AGENT_WS_V2_SUBPROTOCOL);
  });

  it.each(fixtures.frames.map((fixture) => [fixture.name, fixture] as const))(
    "%s",
    (_name, fixture) => {
      const result = parseAgentWsV2Frame(
        JSON.stringify(fixture.frame),
        fixture.sender,
      );
      if (fixture.expect === "ok") {
        expect(result).toMatchObject({ ok: true });
        expect(result.ok && result.message.kind).not.toBe("unknown");
      } else if (fixture.expect === "unknown") {
        expect(result).toMatchObject({
          ok: true,
          message: { kind: "unknown" },
        });
      } else {
        expect(result).toMatchObject({ ok: false, code: fixture.expect });
      }
    },
  );
});
