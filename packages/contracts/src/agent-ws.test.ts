import { describe, expect, it } from "vitest";

import {
  AGENT_WS_PROTOCOL_VERSION,
  agentWsConfigAckPayloadSchema,
  agentWsHelloPayloadSchema,
  agentWsWelcomePayloadSchema,
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
  parseAgentWsPtyMessage,
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

  it("decodes bounded ACME issue and broker frames as typed messages", () => {
    const issue = parseAgentWsFrame(
      encodeAgentWsFrame(
        createAgentWsFrame("acme.issue", {
          jobId: "job-1",
          certificateId: "cert-1",
          generation: 2,
          domains: ["example.com", "*.example.com"],
          acmeProvider: "letsencrypt",
          acmeStaging: true,
          challengeType: "dns-01",
        }),
      ),
    );
    expect(issue.ok).toBe(true);
    if (issue.ok) {
      expect(issue.message.kind).toBe("acme.issue");
      expect(issue.message.payload).toMatchObject({
        jobId: "job-1",
        generation: 2,
        challengeType: "dns-01",
      });
    }

    const present = parseAgentWsFrame(
      JSON.stringify({
        v: 1,
        type: "acme.dns_present",
        payload: {
          jobId: "job-1",
          fqdn: "_acme-challenge.example.com",
          txtValue: "challenge-digest",
        },
      }),
    );
    expect(present.ok).toBe(true);
    if (present.ok) {
      expect(present.message.kind).toBe("acme.dns_present");
    }
  });

  it("requires an ACME result to be either material or an error", () => {
    const missing = parseAgentWsFrame(
      JSON.stringify({
        v: 1,
        type: "acme.result",
        payload: { jobId: "job-1" },
      }),
    );
    expect(missing).toEqual({
      ok: false,
      code: "invalid-payload",
      type: "acme.result",
    });

    const failed = parseAgentWsFrame(
      JSON.stringify({
        v: 1,
        type: "acme.result",
        payload: {
          jobId: "job-1",
          error: "authorization failed",
          errorPhase: "validation",
        },
      }),
    );
    expect(failed.ok).toBe(true);
  });

  it("rejects unbounded ACME jobs and challenge values", () => {
    const tooManyDomains = parseAgentWsFrame(
      JSON.stringify({
        v: 1,
        type: "acme.issue",
        payload: {
          jobId: "job-1",
          certificateId: "cert-1",
          generation: 1,
          domains: Array.from(
            { length: 101 },
            (_, index) => `d${index}.example.com`,
          ),
          acmeProvider: "letsencrypt",
          challengeType: "dns-01",
        },
      }),
    );
    expect(tooManyDomains).toEqual({
      ok: false,
      code: "invalid-payload",
      type: "acme.issue",
    });

    const oversizedValue = parseAgentWsFrame(
      JSON.stringify({
        v: 1,
        type: "acme.dns_ack",
        payload: {
          jobId: "job-1",
          fqdn: "_acme-challenge.example.com",
          txtValue: "x".repeat(513),
          accepted: true,
        },
      }),
    );
    expect(oversizedValue).toEqual({
      ok: false,
      code: "invalid-payload",
      type: "acme.dns_ack",
    });
  });

  it("parses the PTY extension payloads and rejects bad dimensions", () => {
    const open = parseAgentWsPtyMessage("pty.open", {
      sessionId: "term-1",
      cols: 120,
      rows: 40,
    });
    expect(open).toEqual({
      ok: true,
      message: {
        type: "pty.open",
        payload: { sessionId: "term-1", cols: 120, rows: 40 },
      },
    });

    expect(
      parseAgentWsPtyMessage("pty.data", {
        sessionId: "term-1",
        data: "ls\r",
      }),
    ).toEqual({
      ok: true,
      message: {
        type: "pty.data",
        payload: { sessionId: "term-1", data: "ls\r" },
      },
    });

    expect(
      parseAgentWsPtyMessage("pty.exit", {
        sessionId: "term-1",
        reason: "idle_timeout",
      }),
    ).toEqual({
      ok: true,
      message: {
        type: "pty.exit",
        payload: { sessionId: "term-1", reason: "idle_timeout" },
      },
    });

    expect(
      parseAgentWsPtyMessage("pty.resize", {
        sessionId: "term-1",
        cols: 0,
        rows: 40,
      }),
    ).toEqual({ ok: false, type: "pty.resize" });
    expect(parseAgentWsPtyMessage("config.notify", {})).toBeNull();
  });

  it("parses the shell-started payload and the startup failure reasons", () => {
    expect(
      parseAgentWsPtyMessage("pty.started", {
        sessionId: "term-1",
        shell: "/bin/sh",
        user: "blossom",
      }),
    ).toEqual({
      ok: true,
      message: {
        type: "pty.started",
        payload: { sessionId: "term-1", shell: "/bin/sh", user: "blossom" },
      },
    });
    expect(
      parseAgentWsPtyMessage("pty.started", {
        sessionId: "term-1",
        shell: "",
        user: "blossom",
      }),
    ).toEqual({ ok: false, type: "pty.started" });

    for (const reason of [
      "shell_unavailable",
      "pty_unavailable",
      "relay_timeout",
      "authorization_revoked",
    ] as const) {
      expect(
        parseAgentWsPtyMessage("pty.exit", { sessionId: "term-1", reason }),
      ).toMatchObject({ ok: true, message: { payload: { reason } } });
    }
    expect(
      parseAgentWsPtyMessage("pty.exit", {
        sessionId: "term-1",
        reason: "shell_unavailable",
        detail: "/bin/bash is not executable",
      }),
    ).toMatchObject({
      ok: true,
      message: { payload: { detail: "/bin/bash is not executable" } },
    });
    expect(
      parseAgentWsPtyMessage("pty.exit", {
        sessionId: "term-1",
        detail: "x".repeat(257),
      }),
    ).toEqual({ ok: false, type: "pty.exit" });
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
