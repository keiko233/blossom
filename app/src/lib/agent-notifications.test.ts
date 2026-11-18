import type { AgentWsConfigNotifyPayload } from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

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
      notifyAcmeIssue: vi.fn(),
      notifyAcmeDnsAck: vi.fn(),
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
