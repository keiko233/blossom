import { describe, expect, it } from "vitest";

import {
  MANAGED_NETWORKING_ACTIVATION_ENABLED,
  managedRuntimeTag,
} from "./managed-networking";

describe("managedRuntimeTag", () => {
  it("derives distinct tags per kind that cannot collide with subscriber or built-in tags", () => {
    const tags = [
      managedRuntimeTag("peer_inbound", "abc"),
      managedRuntimeTag("peer_link", "abc"),
      managedRuntimeTag("direct_profile", "abc"),
    ];
    expect(tags).toEqual(["peer-in-abc", "peer-out-abc", "direct-abc"]);
    for (const tag of tags) {
      expect(tag.startsWith("node-")).toBe(false);
      expect(tag).not.toBe("direct");
    }
  });

  it("rejects an empty identity", () => {
    expect(() => managedRuntimeTag("peer_inbound", "")).toThrow();
  });
});

describe("managed activation", () => {
  it("stays disabled until the rollout gate ships", () => {
    expect(MANAGED_NETWORKING_ACTIVATION_ENABLED).toBe(false);
  });
});
