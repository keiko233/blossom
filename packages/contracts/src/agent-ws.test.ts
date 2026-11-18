import { describe, expect, it } from "vitest";

import {
  AGENT_WS_PROTOCOL_VERSION,
  agentWsConfigAckPayloadSchema,
  agentWsHelloPayloadSchema,
  agentWsWelcomePayloadSchema,
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
} from "./agent-ws";

const TS = "2026-11-19T00:00:00.000Z";

describe("agent WebSocket contract", () => {
  it("builds and decodes the frozen v1 envelope", () => {
    const frame = createAgentWsFrame("ping", { nonce: "abc" }, { ts: TS });
    expect(frame).toEqual({
      v: AGENT_WS_PROTOCOL_VERSION,
      type: "ping",
      ts: TS,
      payload: { nonce: "abc" },
    });

    const decoded = parseAgentWsFrame(encodeAgentWsFrame(frame));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.message).toEqual({
        kind: "ping",
        payload: { nonce: "abc" },
      });
      expect(decoded.frame.id).toBeUndefined();
    }
  });

  it("accepts the PR #112 hello and welcome payloads", () => {
    const hello = {
      agentVersion: "0.2.0",
      agentBuildId: "local-test",
      capabilities: ["config-v3", "ws-v1"],
      appliedRevision: "7:sha256:abc",
      certificateDeployments: [
        {
          certificateId: "cert-1",
          generation: 2,
          fingerprintSha256: "deadbeef",
          installed: true,
          inUse: false,
        },
      ],
      updates: {
        agent: {
          targetVersion: "0.3.0",
          state: "checking",
          checkedAt: TS,
        },
      },
    };
    expect(agentWsHelloPayloadSchema.parse(hello)).toEqual(hello);

    const welcome = {
      serverId: "srv-1",
      serverName: "edge",
      protocolVersion: 1,
      desiredRevisionSeq: 7,
      desiredRevision: "7:sha256:rev",
      pollIntervalSeconds: 60,
      heartbeatIntervalSeconds: 30,
      reconnectBeforeSeconds: 240,
    };
    expect(agentWsWelcomePayloadSchema.parse(welcome)).toEqual(welcome);
  });

  it("defaults optional envelope fields like the Rust codec", () => {
    const decoded = parseAgentWsFrame(
      JSON.stringify({ type: "pong", payload: {} }),
    );
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.frame.v).toBe(1);
      expect(decoded.frame.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("rejects a different protocol version", () => {
    const decoded = parseAgentWsFrame(
      JSON.stringify({ v: 2, type: "ping", payload: {} }),
    );
    expect(decoded).toEqual({
      ok: false,
      code: "unsupported-version",
      version: 2,
    });
  });

  it("allows an empty applied revision on a failed config.ack", () => {
    expect(
      agentWsConfigAckPayloadSchema.parse({
        appliedRevision: "",
        error: "preflight failed",
      }),
    ).toEqual({ appliedRevision: "", error: "preflight failed" });
  });

  it("ignores unknown types and validates reserved channels", () => {
    const unknown = parseAgentWsFrame(
      JSON.stringify({ v: 1, type: "future.thing", payload: { x: 1 } }),
    );
    expect(unknown.ok).toBe(true);
    if (unknown.ok) {
      expect(unknown.message).toEqual({
        kind: "unknown",
        type: "future.thing",
      });
    }

    const pty = parseAgentWsFrame(
      JSON.stringify({
        v: 1,
        type: "pty.resize",
        payload: { sessionId: "term-1", cols: 120, rows: 40 },
      }),
    );
    expect(pty.ok).toBe(true);
    if (pty.ok) {
      expect(pty.message.kind).toBe("reserved");
    }
  });

  it("reports malformed known payloads without throwing", () => {
    expect(
      parseAgentWsFrame(JSON.stringify({ v: 1, type: "welcome", payload: {} })),
    ).toEqual({ ok: false, code: "invalid-payload", type: "welcome" });
    expect(parseAgentWsFrame("{")).toEqual({
      ok: false,
      code: "invalid-json",
    });
  });
});
