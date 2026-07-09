import { describe, expect, it } from "vitest";

import { parseClientUserAgent } from "./user-agent";

describe("parseClientUserAgent", () => {
  it("returns nulls for empty input", () => {
    expect(parseClientUserAgent(null)).toEqual({
      clientName: null,
      clientVersion: null,
    });
    expect(parseClientUserAgent("")).toEqual({
      clientName: null,
      clientVersion: null,
    });
  });

  it("detects mihomo with version", () => {
    expect(parseClientUserAgent("mihomo/1.19.2")).toEqual({
      clientName: "mihomo",
      clientVersion: "1.19.2",
    });
  });

  it("detects Clash.Meta", () => {
    expect(parseClientUserAgent("clash.meta/1.18.0")).toEqual({
      clientName: "Clash Meta",
      clientVersion: "1.18.0",
    });
  });

  it("detects Clash Verge Rev", () => {
    expect(parseClientUserAgent("clash-verge/v2.2.0")).toEqual({
      clientName: "Clash Verge",
      clientVersion: "2.2.0",
    });
  });

  it("detects Stash", () => {
    expect(parseClientUserAgent("Stash/2.5")).toEqual({
      clientName: "Stash",
      clientVersion: "2.5",
    });
  });

  it("detects sing-box", () => {
    expect(parseClientUserAgent("sing-box/1.11.0")).toEqual({
      clientName: "sing-box",
      clientVersion: "1.11.0",
    });
  });

  it("detects Shadowrocket", () => {
    expect(parseClientUserAgent("Shadowrocket/1989 CFNetwork/1.0")).toEqual({
      clientName: "Shadowrocket",
      clientVersion: "1989",
    });
  });

  it("falls back to generic Clash", () => {
    expect(parseClientUserAgent("ClashForAndroid/2.5.12")).toEqual({
      clientName: "Clash",
      clientVersion: "2.5.12",
    });
  });

  it("returns nulls for unknown agents", () => {
    expect(parseClientUserAgent("Mozilla/5.0 (Windows NT 10.0)")).toEqual({
      clientName: null,
      clientVersion: null,
    });
  });
});
