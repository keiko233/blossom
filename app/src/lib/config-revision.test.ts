import { describe, expect, it } from "vitest";

import { formatDesiredRevision, parseRevisionSeq } from "./config-revision";

describe("config revision codec", () => {
  it("round-trips a sequenced revision", () => {
    const revision = formatDesiredRevision(42, "sha256:deadbeef");
    expect(revision).toBe("42:sha256:deadbeef");
    expect(parseRevisionSeq(revision)).toBe(42);
  });

  it("parses zero", () => {
    expect(parseRevisionSeq("0:sha256:abc")).toBe(0);
  });

  it("returns null for legacy hash-only revisions", () => {
    expect(parseRevisionSeq("sha256:deadbeef")).toBeNull();
  });

  it("returns null for missing or malformed revisions", () => {
    expect(parseRevisionSeq(null)).toBeNull();
    expect(parseRevisionSeq(undefined)).toBeNull();
    expect(parseRevisionSeq("")).toBeNull();
    expect(parseRevisionSeq("abc:sha256:deadbeef")).toBeNull();
  });
});
