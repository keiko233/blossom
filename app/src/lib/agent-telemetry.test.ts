import {
  createAgentWsFrame,
  encodeAgentWsFrame,
} from "@blossom/contracts/agent-ws";
import { describe, expect, it, vi } from "vitest";

import { telemetryReply, TelemetryRequests } from "./agent-telemetry";

function snapshot(requestId: string, fields: object = {}) {
  return encodeAgentWsFrame(
    createAgentWsFrame("telemetry.snapshot", {
      requestId,
      partial: false,
      listeners: [{ protocol: "tcp", address: "::1", port: 443 }],
      interfaces: [{ name: "lo", address: "127.0.0.1" }],
      ...fields,
    }),
  );
}

describe("agent telemetry", () => {
  it("strips unrecognized data and rejects invalid or oversized details", () => {
    const reply = telemetryReply(
      snapshot("inspect", { extra: "not in the DTO" }),
    );
    expect(reply?.data).not.toHaveProperty("extra");
    expect(
      telemetryReply(
        snapshot("inspect", {
          listeners: [{ protocol: "tcp", address: "bad", port: 443 }],
        }),
      ),
    ).toBeNull();
    expect(
      telemetryReply(snapshot("inspect", { extra: "x".repeat(50_000) })),
    ).toBeNull();
  });

  it("only resolves a reply with the requesting server and matching ID", async () => {
    const broker = new TelemetryRequests();
    let id = "";
    const pending = broker.request("one", "snapshot", (frame) => {
      id = JSON.parse(frame).payload.requestId;
    });
    const duplicate = broker.request("one", "snapshot", () => {
      throw new Error("Duplicate request");
    });

    const reply = telemetryReply(snapshot(id));
    const unrelated = telemetryReply(snapshot("other"));
    if (!reply || !unrelated) throw new Error("Invalid fixture");
    broker.accept("two", reply);
    broker.accept("one", unrelated);
    broker.accept("one", reply);
    await expect(pending).resolves.toEqual(reply);
    await expect(duplicate).resolves.toEqual(reply);
  });

  it("expires unanswered requests and releases their slot", async () => {
    vi.useFakeTimers();
    try {
      const broker = new TelemetryRequests();
      const send = vi.fn();
      const first = broker.request("one", "sample", send);
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(first).resolves.toBeNull();
      const second = broker.request("one", "sample", send);
      await vi.advanceTimersByTimeAsync(2_500);
      await expect(second).resolves.toBeNull();
      expect(send).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
