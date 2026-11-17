import { describe, expect, it } from "vitest";

import { createServerSchema, heartbeatSchema } from "./schema";

const heartbeat = {
  agentBuildId: "build-1",
  agentCapabilities: ["config-v3"],
  certificateDeployments: [],
  updates: {
    agent: { state: "downloading", targetVersion: "0.3.0" },
    singBox: { state: "up_to_date", targetVersion: "1.14.4" },
  },
};

describe("agent update contract", () => {
  it("accepts update statuses in the heartbeat", () => {
    const parsed = heartbeatSchema.parse(heartbeat);
    expect(parsed.updates?.agent?.state).toBe("downloading");
    expect(parsed.updates?.singBox?.state).toBe("up_to_date");
  });

  it("rejects an unknown update state", () => {
    expect(() =>
      heartbeatSchema.parse({
        ...heartbeat,
        updates: { agent: { state: "installing" } },
      }),
    ).toThrow();
  });

  it("accepts latest or an exact desired version", () => {
    for (const version of ["latest", "0.3.0", "v1.14.4"]) {
      const parsed = createServerSchema.parse({
        name: "edge",
        address: "edge.example.com",
        desiredAgentVersion: version,
        desiredSingBoxVersion: version,
      });
      expect(parsed.desiredAgentVersion).toBe(version);
      expect(parsed.desiredSingBoxVersion).toBe(version);
    }
  });

  it("rejects a non-version update target", () => {
    expect(() =>
      createServerSchema.parse({
        name: "edge",
        address: "edge.example.com",
        desiredAgentVersion: "main",
      }),
    ).toThrow();
  });
});
