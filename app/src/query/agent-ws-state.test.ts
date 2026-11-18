import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updates: [] as Record<string, unknown>[],
  prune: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        mocks.updates.push(values);
        return { where: async () => undefined };
      },
    }),
  },
}));

vi.mock("@/query/config-change", () => ({
  pruneAppliedConfigChanges: mocks.prune,
}));

import {
  recordAgentConfigAck,
  recordAgentHello,
  recordAgentUpdateStatus,
} from "./agent";

beforeEach(() => {
  mocks.updates = [];
  mocks.prune.mockReset();
});

describe("agent WebSocket state writes", () => {
  it("records a config ack without resetting heartbeat-owned state", async () => {
    await recordAgentConfigAck("srv-1", {
      appliedRevision: "5:sha256:abc",
      certificateDeployments: [],
    });

    const values = mocks.updates[0]!;
    expect(values).toMatchObject({
      appliedRevision: "5:sha256:abc",
      configState: "applied",
    });
    expect(values).not.toHaveProperty("runtimeState");
    expect(values).not.toHaveProperty("activeNodeIds");
    expect(values).not.toHaveProperty("agentBuildId");
    expect(values).not.toHaveProperty("agentCapabilities");
    expect(mocks.prune).toHaveBeenCalledWith("srv-1", 5, expect.anything());
  });

  it("keeps a failed ack truthful without erasing runtime state", async () => {
    await recordAgentConfigAck("srv-1", {
      appliedRevision: "",
      error: "preflight failed\n/tmp/agent-config.json",
    });

    const values = mocks.updates[0]!;
    expect(values).toMatchObject({
      configState: "apply_failed",
      lastErrorPhase: "config",
      lastErrorCode: "config_ack",
    });
    expect(values.lastErrorMessage).toContain("preflight failed");
    expect(values.lastErrorMessage).toContain("<config>");
    expect(values).not.toHaveProperty("appliedRevision");
    expect(values).not.toHaveProperty("runtimeState");
    expect(values).not.toHaveProperty("activeNodeIds");
  });

  it("records hello metadata without touching runtime or active-node fields", async () => {
    await recordAgentHello("srv-1", {
      agentVersion: "0.2.0",
      agentBuildId: "local-test",
      capabilities: ["ws-v1"],
      appliedRevision: "6:sha256:def",
      certificateDeployments: [],
    });

    const values = mocks.updates[0]!;
    expect(values).toMatchObject({
      agentVersion: "0.2.0",
      agentBuildId: "local-test",
      agentCapabilities: ["ws-v1"],
      appliedRevision: "6:sha256:def",
    });
    expect(values).not.toHaveProperty("runtimeState");
    expect(values).not.toHaveProperty("configState");
    expect(values).not.toHaveProperty("activeNodeIds");
  });

  it("records update statuses only in their own columns", async () => {
    await recordAgentUpdateStatus("srv-1", {
      agent: {
        state: "downloading",
        targetVersion: "0.3.0",
        message: '{"token":"secret"} /tmp/update',
      },
    });

    const values = mocks.updates[0]!;
    expect(values).toMatchObject({
      agentUpdateState: "downloading",
      agentUpdateTarget: "0.3.0",
    });
    expect(values.agentUpdateError).toContain("<redacted>");
    expect(values.agentUpdateError).toContain("<config>");
    expect(values).not.toHaveProperty("runtimeState");
    expect(values).not.toHaveProperty("configState");
    expect(values).not.toHaveProperty("agentCapabilities");
    expect(values).not.toHaveProperty("appliedRevision");
  });
});
