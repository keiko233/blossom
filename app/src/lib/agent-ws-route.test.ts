import type { AgentWsWelcomePayload } from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

import type { Server } from "@/db/proxy-schema";
import { AgentAuthError } from "@/lib/agent-oauth";
import { hashAgentToken } from "@/lib/agent-token";

import {
  AGENT_WS_DISABLED_STATE_HEADER,
  authenticateAgentWsRequest,
  authenticateDisabledAgentWsRequest,
  handleAgentWsRequest,
} from "./agent-ws-route";
import type { RealtimeHub } from "./realtime-hub-types";

const server = {
  id: "srv-1",
  name: "edge",
  enabled: true,
} as Server;
const staticCredential = { kind: "static" as const, tokenHash: "hash-1" };
const authenticated = (value: Server = server) => ({
  server: value,
  credential: staticCredential,
});

const welcome: AgentWsWelcomePayload = {
  serverId: "srv-1",
  serverName: "edge",
  protocolVersion: 1,
  desiredRevisionSeq: 4,
  desiredRevision: "4:sha256:rev",
  pollIntervalSeconds: 60,
  heartbeatIntervalSeconds: 30,
};

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/agent/ws", { headers });
}

function makeHub() {
  return {
    acceptAgent: vi.fn(
      async () =>
        new Response(null, {
          status: 426,
          headers: { Upgrade: "websocket" },
        }),
    ),
    acceptAgentV2: vi.fn(
      async () =>
        new Response(null, {
          status: 426,
          headers: { Upgrade: "websocket" },
        }),
    ),
    notifyConfigChanged: vi.fn(async () => undefined),
    notifyUpdateTrigger: vi.fn(async () => undefined),
  } satisfies Pick<
    RealtimeHub,
    | "acceptAgent"
    | "acceptAgentV2"
    | "notifyConfigChanged"
    | "notifyUpdateTrigger"
  >;
}

describe("agent WebSocket route", () => {
  it("rejects missing and invalid bearer tokens before the upgrade", async () => {
    expect(await authenticateAgentWsRequest(request())).toBeNull();

    const lookup = vi.fn(async () => null);
    const authenticated = await authenticateAgentWsRequest(
      request({ authorization: "Bearer not-a-real-token" }),
      lookup,
      async () => null,
    );
    expect(authenticated).toBeNull();
    expect(lookup).toHaveBeenCalledWith(hashAgentToken("not-a-real-token"));
  });

  it("rejects disabled servers and returns 401", async () => {
    const disabled = { ...server, enabled: false } as Server;
    const lookup = vi.fn(async () => disabled);
    expect(
      await authenticateAgentWsRequest(
        request({ authorization: "Bearer fake-token" }),
        lookup,
        async () => null,
      ),
    ).toBeNull();

    const hub = makeHub();
    const response = await handleAgentWsRequest(
      request({ authorization: "Bearer fake-token", upgrade: "websocket" }),
      {
        authenticate: async () => null,
        authenticateDisabled: async () => null,
        buildWelcome: async () => welcome,
        wakeCertificateIssuance: async () => undefined,
        hub,
      },
    );
    expect(response.status).toBe(401);
    expect(
      (response as Response & { crossws?: unknown }).crossws,
    ).toBeDefined();
    expect(hub.acceptAgent).not.toHaveBeenCalled();
  });

  it("returns a non-session disable signal only for a current v2 credential", async () => {
    const disabled = { ...server, enabled: false } as Server;
    expect(
      await authenticateDisabledAgentWsRequest(
        request({ authorization: "Bearer fake-token" }),
        async () => null,
        async () => null,
      ),
    ).toBeNull();
    expect(
      await authenticateDisabledAgentWsRequest(
        request({ authorization: "Bearer fake-token" }),
        async () => disabled,
        async () => null,
      ),
    ).toEqual({
      server: disabled,
      credential: {
        kind: "static",
        tokenHash: hashAgentToken("fake-token"),
      },
    });
    expect(
      await authenticateDisabledAgentWsRequest(
        request({ authorization: "Bearer fake-token" }),
        async () => server,
        async () => null,
      ),
    ).toBeNull();

    expect(
      await authenticateDisabledAgentWsRequest(
        request({ authorization: "Bearer machine-token" }),
        async () => null,
        async () => ({
          serverId: "srv-1",
          identityId: "identity-2",
          generation: 3,
          identityStatus: "active",
          clientId: "agent_test",
          expiresAt: 1_900_000_000,
        }),
        async () => disabled,
      ),
    ).toEqual({
      server: disabled,
      credential: {
        kind: "oauth",
        identityId: "identity-2",
        generation: 3,
        clientId: "agent_test",
        expiresAt: 1_900_000_000,
        identityStatus: "active",
      },
    });
  });

  it("rejects bad static, pending, and disabled-client credentials with no disable body", async () => {
    const disabled = { ...server, enabled: false } as Server;
    const pending = {
      serverId: "srv-1",
      identityId: "identity-2",
      generation: 3,
      identityStatus: "pending",
      clientId: "agent_test",
      expiresAt: 1_900_000_000,
    } as const;
    const cases: Array<{
      authorization: string;
      verify?: () => Promise<typeof pending>;
    }> = [
      { authorization: "Bearer stale-token" },
      { authorization: "Bearer no-token", verify: async () => pending },
      { authorization: "Bearer machine-token", verify: async () => pending },
    ];
    for (const item of cases) {
      expect(
        await authenticateDisabledAgentWsRequest(
          request({ authorization: item.authorization }),
          async () => null,
          item.verify ?? (async () => null),
          async () => disabled,
        ),
      ).toBeNull();
    }
    expect(
      await authenticateDisabledAgentWsRequest(
        request({ authorization: "Bearer machine-token" }),
        async () => null,
        async () => {
          throw new AgentAuthError("client_disabled");
        },
        async () => disabled,
      ),
    ).toBeNull();
  });

  it("distinguishes a confirmed disabled v2 credential from an ordinary 401", async () => {
    const hub = makeHub();
    const buildWelcome = vi.fn(async () => welcome);
    const wakeCertificateIssuance = vi.fn(async () => undefined);
    const upgradeRequest = request({
      authorization: "Bearer fake-token",
      upgrade: "websocket",
      "sec-websocket-protocol": "blossom-agent.v2",
    });
    const base = {
      authenticate: async () => null,
      buildWelcome,
      wakeCertificateIssuance,
      hub,
    };
    const disabled = { ...server, enabled: false } as Server;

    const confirmed = await handleAgentWsRequest(upgradeRequest, {
      ...base,
      authenticateDisabled: async () => authenticated(disabled),
    });
    expect(confirmed.status).toBe(409);
    expect(confirmed.headers.get(AGENT_WS_DISABLED_STATE_HEADER)).toBe(
      "disabled",
    );
    expect(await confirmed.text()).toBe("Server disabled");
    expect(buildWelcome).not.toHaveBeenCalled();
    expect(wakeCertificateIssuance).not.toHaveBeenCalled();
    expect(hub.acceptAgent).not.toHaveBeenCalled();
    expect(hub.acceptAgentV2).not.toHaveBeenCalled();

    const disabledForV1 = authenticated(disabled);
    const authenticateDisabled = vi.fn(async () => disabledForV1);
    const legacy = await handleAgentWsRequest(
      request({
        authorization: "Bearer fake-token",
        upgrade: "websocket",
        "sec-websocket-protocol": "blossom-agent.v1",
      }),
      {
        ...base,
        authenticateDisabled,
      },
    );
    expect(legacy.status).toBe(401);
    expect(legacy.headers.get(AGENT_WS_DISABLED_STATE_HEADER)).toBeNull();
    expect(authenticateDisabled).not.toHaveBeenCalled();

    const rejected = await handleAgentWsRequest(upgradeRequest, {
      ...base,
      authenticateDisabled: async () => null,
    });
    expect(rejected.status).toBe(401);
    expect(rejected.headers.get(AGENT_WS_DISABLED_STATE_HEADER)).toBeNull();
  });

  it("maps an OAuth machine token to its identity server and generation", async () => {
    const authenticated = await authenticateAgentWsRequest(
      request({ authorization: "Bearer machine-token" }),
      async () => null,
      async () => ({
        serverId: "srv-1",
        identityId: "identity-2",
        generation: 3,
        identityStatus: "pending",
        clientId: "agent_test",
        expiresAt: 1_900_000_000,
      }),
      async () => server,
    );

    expect(authenticated).toEqual({
      server,
      credential: {
        kind: "oauth",
        identityId: "identity-2",
        generation: 3,
        clientId: "agent_test",
        expiresAt: 1_900_000_000,
        identityStatus: "pending",
      },
    });
  });

  it("authenticates before handing the upgrade to the hub", async () => {
    const hub = makeHub();
    const buildWelcome = vi.fn(async () => welcome);
    const upgradeRequest = request({
      authorization: "Bearer fake-token",
      upgrade: "websocket",
    });

    const response = await handleAgentWsRequest(upgradeRequest, {
      authenticate: async () => authenticated(),
      authenticateDisabled: async () => null,
      buildWelcome,
      wakeCertificateIssuance: async () => undefined,
      hub,
    });

    expect(response.status).toBe(426);
    expect(buildWelcome).toHaveBeenCalledWith(server);
    expect(hub.acceptAgent).toHaveBeenCalledWith(
      upgradeRequest,
      server,
      welcome,
    );
  });

  it("returns 426 for a valid plain HTTP request and 503 on hub failure", async () => {
    const hub = makeHub();
    const plain = await handleAgentWsRequest(request(), {
      authenticate: async () => authenticated(),
      authenticateDisabled: async () => null,
      buildWelcome: async () => welcome,
      wakeCertificateIssuance: async () => undefined,
      hub,
    });
    expect(plain.status).toBe(426);
    expect(hub.acceptAgent).not.toHaveBeenCalled();

    hub.acceptAgent.mockRejectedValueOnce(new Error("DO unavailable"));
    const failed = await handleAgentWsRequest(
      request({ upgrade: "websocket" }),
      {
        authenticate: async () => authenticated(),
        authenticateDisabled: async () => null,
        buildWelcome: async () => welcome,
        wakeCertificateIssuance: async () => undefined,
        hub,
      },
    );
    expect(failed.status).toBe(503);
  });

  it("keeps clients that offer no subprotocol on the v1 handshake", async () => {
    const hub = makeHub();
    const buildWelcome = vi.fn(async () => welcome);
    const upgradeRequest = request({ upgrade: "websocket" });

    await handleAgentWsRequest(upgradeRequest, {
      authenticate: async () => authenticated(),
      authenticateDisabled: async () => null,
      buildWelcome,
      wakeCertificateIssuance: async () => undefined,
      hub,
    });

    expect(buildWelcome).toHaveBeenCalledWith(server);
    expect(hub.acceptAgentV2).not.toHaveBeenCalled();
  });

  it("refuses an OAuth credential on the v1 handshake", async () => {
    const hub = makeHub();
    const response = await handleAgentWsRequest(
      request({ upgrade: "websocket" }),
      {
        authenticate: async () => ({
          server,
          credential: {
            kind: "oauth",
            identityId: "id-1",
            generation: 1,
            clientId: "agent_test",
            expiresAt: 1_900_000_000,
            identityStatus: "active",
          },
        }),
        authenticateDisabled: async () => null,
        buildWelcome: async () => welcome,
        wakeCertificateIssuance: async () => undefined,
        hub,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "OAuth requires the blossom-agent.v2 subprotocol",
    );
    expect(hub.acceptAgent).not.toHaveBeenCalled();
  });

  it("hands a v2 upgrade to the v2 hub without building a v1 welcome", async () => {
    const hub = makeHub();
    const buildWelcome = vi.fn(async () => welcome);
    const upgradeRequest = request({
      upgrade: "websocket",
      "sec-websocket-protocol": "blossom-agent.v2",
    });

    await handleAgentWsRequest(upgradeRequest, {
      authenticate: async () => authenticated(),
      authenticateDisabled: async () => null,
      buildWelcome,
      wakeCertificateIssuance: async () => undefined,
      hub,
    });

    expect(hub.acceptAgentV2).toHaveBeenCalledWith(
      upgradeRequest,
      server,
      staticCredential,
    );
    expect(buildWelcome).not.toHaveBeenCalled();
    expect(hub.acceptAgent).not.toHaveBeenCalled();
  });

  it("rejects an unknown subprotocol before the upgrade", async () => {
    const hub = makeHub();
    const response = await handleAgentWsRequest(
      request({
        upgrade: "websocket",
        "sec-websocket-protocol": "blossom-agent.v9",
      }),
      {
        authenticate: async () => authenticated(),
        authenticateDisabled: async () => null,
        buildWelcome: async () => welcome,
        wakeCertificateIssuance: async () => undefined,
        hub,
      },
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toBe(
      "Unsupported agent WebSocket subprotocol",
    );
    expect(hub.acceptAgent).not.toHaveBeenCalled();
    expect(hub.acceptAgentV2).not.toHaveBeenCalled();
  });
});
