import { describe, expect, it } from "vitest";

import {
  CODEC_VERSION_TAG,
  decodeTrafficUser,
  encodeTrafficUser,
  resolveReportedTrafficUser,
} from "./traffic-user-codec";

describe("encodeTrafficUser", () => {
  it("encodes node + subscription ids by length-prefixed concat", () => {
    expect(encodeTrafficUser("n1", "sub1")).toBe("blz.1.2.4.n1sub1");
  });

  it("represents an empty node id as zero length", () => {
    expect(encodeTrafficUser("", "sub1")).toBe("blz.1.0.4.sub1");
  });

  it("represents an empty subscription id as zero length", () => {
    expect(encodeTrafficUser("n1", "")).toBe("blz.1.2.0.n1");
  });

  it("round-trips UUIDs without ambiguity", () => {
    const nodeId = "550e8400-e29b-41d4-a716-446655440000";
    const subId = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
    const encoded = encodeTrafficUser(nodeId, subId);
    expect(decodeTrafficUser(encoded)).toEqual({
      nodeId,
      subscriptionId: subId,
    });
  });

  it("round-trips ids that contain the version tag and the '.' separator", () => {
    // The length header — not the '.' — defines the split, so an id that happens
    // to contain a '.' or even the version tag substring itself round-trips
    // unchanged. The split still uses the header lengths, not the separators.
    const nodeId = `prefix.${CODEC_VERSION_TAG}middle`;
    const subId = "also.has.dots";
    const encoded = encodeTrafficUser(nodeId, subId);
    expect(decodeTrafficUser(encoded)).toEqual({
      nodeId,
      subscriptionId: subId,
    });
  });

  it("round-trips non-ASCII characters using JS code-unit length", () => {
    // string `.length` is UTF-16 code units, not bytes; the codec uses it
    // consistently on both sides so multi-byte chars survive.
    const nodeId = "nüame-爱";
    const subId = "sub-カ";
    const encoded = encodeTrafficUser(nodeId, subId);
    expect(decodeTrafficUser(encoded)).toEqual({
      nodeId,
      subscriptionId: subId,
    });
  });
});

describe("decodeTrafficUser", () => {
  it("round-trips for typical ids", () => {
    const encoded = encodeTrafficUser("node-x", "sub-z");
    expect(decodeTrafficUser(encoded)).toEqual({
      nodeId: "node-x",
      subscriptionId: "sub-z",
    });
  });

  it("returns null for legacy bare subscription ids", () => {
    expect(
      decodeTrafficUser("550e8400-e29b-41d4-a716-446655440000"),
    ).toBeNull();
  });

  it("returns null for an unversioned prefix", () => {
    expect(decodeTrafficUser("blz.2.0.0.")).toBeNull();
  });

  it("returns null when total length does not match the prefix sum", () => {
    expect(decodeTrafficUser("blz.1.6.5.node-1sub-1")).not.toBeNull();
    expect(decodeTrafficUser("blz.1.6.5.short")).toBeNull();
  });

  it("returns null when length fields are not numeric digits", () => {
    expect(decodeTrafficUser("blz.1.0.x.")).toBeNull();
    expect(decodeTrafficUser("blz.1.x.0.")).toBeNull();
  });

  it("returns null when separator is missing", () => {
    expect(decodeTrafficUser("blz.1.24")).toBeNull();
    expect(decodeTrafficUser("blz.1.2.4")).toBeNull();
    expect(decodeTrafficUser("blz.1.2.4.")).toBeNull();
  });

  it("returns null when version tag is missing", () => {
    expect(decodeTrafficUser("2.4.n1sub1")).toBeNull();
  });

  it("handles large length fields correctly", () => {
    const big = "x".repeat(100);
    const encoded = encodeTrafficUser(big, big);
    expect(decodeTrafficUser(encoded)).toEqual({
      nodeId: big,
      subscriptionId: big,
    });
  });

  it("rejects extremely long length prefixes (overflow guard)", () => {
    expect(decodeTrafficUser("blz.1.1234567890.0.")).toBeNull();
  });
});

describe("resolveReportedTrafficUser", () => {
  const ids = new Set(["n1", "n2"]);

  it("decodes a coded name and keeps the nodeId when it belongs to the server", () => {
    const coded = encodeTrafficUser("n1", "s1");
    expect(resolveReportedTrafficUser(coded, ids)).toEqual({
      subscriptionId: "s1",
      nodeId: "n1",
    });
  });

  it("decodes a coded name but nulls the nodeId when it moved off the server", () => {
    const coded = encodeTrafficUser("n-other", "s1");
    expect(resolveReportedTrafficUser(coded, ids)).toEqual({
      subscriptionId: "s1",
      nodeId: null,
    });
  });

  it("keeps the subscription id but nulls nodeId when coded node is empty", () => {
    const coded = encodeTrafficUser("", "s1");
    expect(resolveReportedTrafficUser(coded, ids)).toEqual({
      subscriptionId: "s1",
      nodeId: null,
    });
  });

  it("attributes a legacy bare id to the sole node when the server has exactly one", () => {
    expect(resolveReportedTrafficUser("s1", new Set(["only-node"]))).toEqual({
      subscriptionId: "s1",
      nodeId: "only-node",
    });
  });

  it("cannot attribute a legacy bare id when the server has several nodes", () => {
    expect(resolveReportedTrafficUser("s1", ids)).toEqual({
      subscriptionId: "s1",
      nodeId: null,
    });
  });

  it("cannot attribute a legacy bare id when the server has no nodes", () => {
    expect(resolveReportedTrafficUser("s1", new Set<string>())).toEqual({
      subscriptionId: "s1",
      nodeId: null,
    });
  });

  it("rejects a malformed coded input as legacy", () => {
    // Length mismatch -> decoder returns null -> treated as bare legacy id.
    expect(resolveReportedTrafficUser("blz.1.3.3.short", ids)).toEqual({
      subscriptionId: "blz.1.3.3.short",
      nodeId: null,
    });
  });
});
