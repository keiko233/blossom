import { describe, expect, it, vi } from "vitest";

import {
  dispatchManagedRolloutFollowUps,
  sweepManagedRollouts,
  type ManagedRolloutFollowUp,
} from "./managed-rollout-runtime";

const PROBE_REQUEST = {
  probeId: "probe-1",
  rolloutId: "rollout-1",
  stageOrdinal: 1,
  linkId: "link-1",
  credentialGeneration: 1,
  source: {
    serverId: "srv-a",
    managedFingerprint: `sha256:${"a".repeat(64)}`,
    minRevisionSeq: 1,
  },
  destination: {
    serverId: "srv-b",
    managedFingerprint: `sha256:${"b".repeat(64)}`,
    minRevisionSeq: 1,
  },
  issuedAt: "2026-11-20T00:00:00.000Z",
  expiresAt: "2026-11-20T00:01:00.000Z",
};

function notify(serverId: string, seq: number): ManagedRolloutFollowUp {
  return {
    kind: "config_notify",
    serverId,
    payload: {
      desiredRevisionSeq: seq,
      desiredRevision: `${seq}:sha256:${"c".repeat(64)}`,
      reason: "managed rollout",
    },
  };
}

function probe(sessionId: string): ManagedRolloutFollowUp {
  return {
    kind: "link_probe",
    serverId: "srv-a",
    sessionId,
    request: PROBE_REQUEST,
  };
}

describe("managed rollout follow-up delivery", () => {
  it("keeps one notification per server and sends every probe exactly once", async () => {
    const notifyConfigChanged = vi.fn(async () => undefined);
    const sendLinkProbe = vi.fn(async () => true);
    const result = await dispatchManagedRolloutFollowUps(
      [notify("srv-a", 1), notify("srv-b", 2), notify("srv-a", 3), probe("s1")],
      { notifyConfigChanged, sendLinkProbe },
    );

    expect(notifyConfigChanged).toHaveBeenCalledTimes(2);
    expect(notifyConfigChanged).toHaveBeenNthCalledWith(
      1,
      "srv-a",
      expect.objectContaining({ desiredRevisionSeq: 3 }),
    );
    expect(sendLinkProbe).toHaveBeenCalledWith("srv-a", "s1", PROBE_REQUEST);
    expect(result).toEqual({
      notifiedServerIds: ["srv-a", "srv-b"],
      probeIds: ["probe-1"],
    });
  });

  it("reports an unreachable probe as not delivered and continues", async () => {
    const notifyConfigChanged = vi.fn(async () => undefined);
    const sendLinkProbe = vi.fn(async () => false);
    const result = await dispatchManagedRolloutFollowUps(
      [probe("s1"), notify("srv-b", 2)],
      { notifyConfigChanged, sendLinkProbe },
    );
    expect(result.probeIds).toEqual([]);
    expect(result.notifiedServerIds).toEqual(["srv-b"]);
  });

  it("logs and continues when one delivery throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notifyConfigChanged = vi
      .fn()
      .mockRejectedValueOnce(new Error("durable object unavailable"))
      .mockResolvedValueOnce(undefined);
    const sendLinkProbe = vi.fn(async () => true);
    const result = await dispatchManagedRolloutFollowUps(
      [notify("srv-a", 1), notify("srv-b", 2), probe("s1")],
      { notifyConfigChanged, sendLinkProbe },
    );
    expect(result.notifiedServerIds).toEqual(["srv-b"]);
    expect(result.probeIds).toEqual(["probe-1"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("managed rollout maintenance activation gate", () => {
  it("does no database work while managed activation is disabled", async () => {
    expect(await sweepManagedRollouts({ activationEnabled: false })).toEqual({
      activationDisabled: true,
      scanned: 0,
      followUps: [],
      errors: 0,
    });
  });
});
