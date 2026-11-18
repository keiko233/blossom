import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
  type AgentWsCertificateDeployment,
  type AgentWsWelcomePayload,
} from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

import {
  closeAgentWsSession,
  handleAgentWsMessage,
  openAgentWsSession,
  type AgentWsPeer,
  type AgentWsStore,
} from "./agent-ws-session";

const SERVER_ID = "srv-1";
const CONNECTED_AT = new Date("2026-11-19T00:00:00.000Z");

const welcome: AgentWsWelcomePayload = {
  serverId: SERVER_ID,
  serverName: "edge",
  protocolVersion: 1,
  desiredRevisionSeq: 7,
  desiredRevision: "7:sha256:rev",
  pollIntervalSeconds: 60,
  heartbeatIntervalSeconds: 30,
};

const deployment: AgentWsCertificateDeployment = {
  certificateId: "cert-1",
  generation: 2,
  fingerprintSha256: "deadbeef",
  installed: true,
  inUse: false,
};

function makeStore() {
  return {
    markConnected: vi.fn(async () => CONNECTED_AT),
    markDisconnected: vi.fn(async () => undefined),
    recordHello: vi.fn(async () => undefined),
    recordConfigAck: vi.fn(async () => undefined),
    recordUpdateStatus: vi.fn(async () => undefined),
    applyCertificateDeployments: vi.fn(async () => undefined),
    handleAcmeDnsPresent: vi.fn(async () => undefined),
    handleAcmeDnsCleanup: vi.fn(async () => undefined),
    handleAcmeResult: vi.fn(async () => undefined),
  } satisfies AgentWsStore;
}

function makePeer() {
  const sent: string[] = [];
  const peer: AgentWsPeer & { sent: string[] } = {
    sent,
    send: vi.fn((data: string) => {
      sent.push(data);
    }),
  };
  return peer;
}

async function open(store: AgentWsStore, peer: AgentWsPeer) {
  const session = await openAgentWsSession({
    serverId: SERVER_ID,
    welcome,
    store,
  });
  return { session, peer };
}

describe("agent WebSocket session", () => {
  it("sends welcome only after hello and records hello metadata", async () => {
    const store = makeStore();
    const peer = makePeer();
    const { session } = await open(store, peer);
    expect(store.markConnected).toHaveBeenCalledWith(SERVER_ID);

    await handleAgentWsMessage(
      session,
      peer,
      encodeAgentWsFrame(
        createAgentWsFrame("hello", {
          agentVersion: "0.2.0",
          agentBuildId: "local-test",
          capabilities: ["ws-v1"],
          appliedRevision: "7:sha256:rev",
          certificateDeployments: [deployment],
        }),
      ),
    );

    expect(store.recordHello).toHaveBeenCalledWith(
      SERVER_ID,
      expect.objectContaining({ agentBuildId: "local-test" }),
    );
    expect(store.applyCertificateDeployments).toHaveBeenCalledWith(SERVER_ID, [
      deployment,
    ]);
    expect(peer.sent).toHaveLength(1);
    const frame = parseAgentWsFrame(peer.sent[0]!);
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      expect(frame.message).toEqual({ kind: "welcome", payload: welcome });
    }
  });

  it("records config acknowledgements and update status independently", async () => {
    const store = makeStore();
    const peer = makePeer();
    const { session } = await open(store, peer);

    await handleAgentWsMessage(
      session,
      peer,
      encodeAgentWsFrame(
        createAgentWsFrame("config.ack", {
          appliedRevision: "7:sha256:rev",
          certificateDeployments: [deployment],
        }),
      ),
    );
    await handleAgentWsMessage(
      session,
      peer,
      encodeAgentWsFrame(
        createAgentWsFrame("update.status", {
          agent: { state: "checking", targetVersion: "0.3.0" },
        }),
      ),
    );

    expect(store.recordConfigAck).toHaveBeenCalledWith(SERVER_ID, {
      appliedRevision: "7:sha256:rev",
      certificateDeployments: [deployment],
    });
    expect(store.applyCertificateDeployments).toHaveBeenCalledWith(SERVER_ID, [
      deployment,
    ]);
    expect(store.recordUpdateStatus).toHaveBeenCalledWith(SERVER_ID, {
      agent: { state: "checking", targetVersion: "0.3.0" },
    });
    expect(peer.sent).toHaveLength(0);
  });

  it("answers ping with a pong that preserves the nonce and correlation id", async () => {
    const store = makeStore();
    const peer = makePeer();
    const { session } = await open(store, peer);

    await handleAgentWsMessage(
      session,
      peer,
      encodeAgentWsFrame(
        createAgentWsFrame(
          "ping",
          { nonce: "ka-1" },
          { id: "req-1", ts: "2026-11-19T00:00:01.000Z" },
        ),
      ),
    );

    const frame = parseAgentWsFrame(peer.sent[0]!);
    expect(frame.ok).toBe(true);
    if (frame.ok) {
      expect(frame.frame.id).toBe("req-1");
      expect(frame.message).toEqual({
        kind: "pong",
        payload: { nonce: "ka-1" },
      });
    }
  });

  it("ignores malformed and unknown frames without dropping the session", async () => {
    const store = makeStore();
    const peer = makePeer();
    const { session } = await open(store, peer);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      handleAgentWsMessage(session, peer, "{not-json"),
    ).resolves.toBeUndefined();
    await handleAgentWsMessage(
      session,
      peer,
      JSON.stringify({ v: 1, type: "future.frame", payload: {} }),
    );
    await handleAgentWsMessage(
      session,
      peer,
      JSON.stringify({ v: 2, type: "ping", payload: {} }),
    );

    expect(peer.sent).toHaveLength(0);
    warn.mockRestore();
  });

  it("does not let persistence failures escape into the socket", async () => {
    const store = makeStore();
    store.recordHello.mockRejectedValueOnce(new Error("database offline"));
    const peer = makePeer();
    const { session } = await open(store, peer);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(
      handleAgentWsMessage(
        session,
        peer,
        encodeAgentWsFrame(
          createAgentWsFrame("hello", {
            agentVersion: "0.2.0",
            capabilities: ["ws-v1"],
          }),
        ),
      ),
    ).resolves.toBeUndefined();
    expect(peer.sent).toHaveLength(1);
    warn.mockRestore();
  });

  it("clears the stored connection identity on close", async () => {
    const store = makeStore();
    const peer = makePeer();
    const { session } = await open(store, peer);
    await closeAgentWsSession(session);
    expect(store.markDisconnected).toHaveBeenCalledWith(
      SERVER_ID,
      CONNECTED_AT,
    );
  });

  it("dispatches ACME broker frames and contains persistence failures", async () => {
    const store = makeStore();
    store.handleAcmeDnsPresent.mockRejectedValueOnce(
      new Error("database offline"),
    );
    const peer = makePeer();
    const { session } = await open(store, peer);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await handleAgentWsMessage(
      session,
      peer,
      encodeAgentWsFrame(
        createAgentWsFrame("acme.dns_present", {
          jobId: "job-1",
          fqdn: "_acme-challenge.example.com",
          txtValue: "txt-digest",
        }),
      ),
    );
    await handleAgentWsMessage(
      session,
      peer,
      encodeAgentWsFrame(
        createAgentWsFrame("acme.dns_cleanup", {
          jobId: "job-1",
          fqdn: "_acme-challenge.example.com",
          txtValue: "txt-digest",
        }),
      ),
    );
    await handleAgentWsMessage(
      session,
      peer,
      encodeAgentWsFrame(
        createAgentWsFrame("acme.result", {
          jobId: "job-1",
          error: "order expired",
          errorPhase: "timeout",
        }),
      ),
    );

    expect(store.handleAcmeDnsPresent).toHaveBeenCalledWith(SERVER_ID, {
      jobId: "job-1",
      fqdn: "_acme-challenge.example.com",
      txtValue: "txt-digest",
    });
    expect(store.handleAcmeDnsCleanup).toHaveBeenCalledWith(SERVER_ID, {
      jobId: "job-1",
      fqdn: "_acme-challenge.example.com",
      txtValue: "txt-digest",
    });
    expect(store.handleAcmeResult).toHaveBeenCalledWith(SERVER_ID, {
      jobId: "job-1",
      error: "order expired",
      errorPhase: "timeout",
    });
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
