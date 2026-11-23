import type { AgentWsConfigNotifyPayload } from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invalidate: vi.fn(
    async (_serverIds?: readonly string[], _database?: unknown) => undefined,
  ),
  buildDesiredState: vi.fn(async (_row: unknown, _options?: unknown) => ({
    desiredRevision: "8:sha256:db",
  })),
  notifyConfigChanged: vi.fn(
    async (_serverId: string, _payload: unknown) => undefined,
  ),
}));

vi.mock("@/db", () => ({
  get db() {
    throw new Error("the request-scoped database must not be touched");
  },
}));
vi.mock("@/query/agent", () => ({
  invalidateDesiredConfigRevisions: mocks.invalidate,
}));
vi.mock("@/orpc/proxy/agent-desired-state", () => ({
  buildAgentDesiredState: mocks.buildDesiredState,
}));
vi.mock("@/lib/realtime-hub", () => ({
  getRealtimeHub: () => ({ notifyConfigChanged: mocks.notifyConfigChanged }),
}));

import type { Server } from "@/db/proxy-schema";

import {
  notifyAgentConfigChanged,
  type AgentNotificationDependencies,
} from "./agent-notifications";
import type { RealtimeHub } from "./realtime-hub-types";

const server = {
  id: "srv-1",
  name: "edge",
  enabled: true,
  desiredRevisionSeq: 8,
} as Server;

function dependencies(notifyConfigChanged: RealtimeHub["notifyConfigChanged"]) {
  return {
    loadServer: vi.fn(async () => server),
    loadDesiredRevision: vi.fn(async () => "8:sha256:rev"),
    hub: {
      acceptAgent: vi.fn(),
      notifyConfigChanged,
      notifyUpdateTrigger: vi.fn(),
    },
  } satisfies AgentNotificationDependencies;
}

describe("agent config notifications", () => {
  it("emits the revision returned by the shared desired-state builder", async () => {
    const notifyConfigChanged = vi.fn(async () => undefined);
    await notifyAgentConfigChanged(
      ["srv-1"],
      "node updated",
      dependencies(notifyConfigChanged),
    );

    expect(notifyConfigChanged).toHaveBeenCalledWith("srv-1", {
      desiredRevisionSeq: 8,
      desiredRevision: "8:sha256:rev",
      reason: "node updated",
    } satisfies AgentWsConfigNotifyPayload);
  });

  it("swallows unavailable transport failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notifyConfigChanged = vi.fn(async () => {
      throw new Error("AgentSessionDO unavailable");
    });

    await expect(
      notifyAgentConfigChanged(
        ["srv-1"],
        undefined,
        dependencies(notifyConfigChanged),
      ),
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("deduplicates server ids and still notifies disabled servers", async () => {
    const notifyConfigChanged = vi.fn(async () => undefined);
    const deps = dependencies(notifyConfigChanged);
    deps.loadServer.mockResolvedValueOnce({ ...server, enabled: false });
    await notifyAgentConfigChanged(["srv-1", "srv-1"], "test", deps);
    expect(deps.loadServer).toHaveBeenCalledTimes(1);
    expect(notifyConfigChanged).toHaveBeenCalledWith("srv-1", {
      desiredRevisionSeq: 8,
      desiredRevision: "8:sha256:rev",
      reason: "test",
    });
  });
});

describe("agent config notifications with an explicit database", () => {
  it("reads, invalidates and compiles through the supplied handle", async () => {
    const where = vi.fn(async () => [server]);
    const database = {
      select: () => ({ from: () => ({ where }) }),
    };

    await notifyAgentConfigChanged(
      ["srv-1"],
      "certificate renewed",
      undefined,
      database as never,
    );

    expect(where).toHaveBeenCalledTimes(1);
    expect(mocks.invalidate).toHaveBeenCalledWith(["srv-1"], database);
    expect(mocks.buildDesiredState).toHaveBeenCalledWith(server, {
      database,
      advanceCertificates: false,
    });
    expect(mocks.notifyConfigChanged).toHaveBeenCalledWith("srv-1", {
      desiredRevisionSeq: 8,
      desiredRevision: "8:sha256:db",
      reason: "certificate renewed",
    });
  });
});
