import { describe, expect, it } from "vitest";

import { defaultSection } from "./settings";
import {
  buildContentDisposition,
  buildProfileUpdateInterval,
  DEFAULT_PROFILE_TITLE,
  DEFAULT_PROFILE_UPDATE_INTERVAL_HOURS,
} from "./subscription-headers";

describe("buildContentDisposition", () => {
  it("reproduces the historical header for the default title", () => {
    expect(buildContentDisposition(DEFAULT_PROFILE_TITLE)).toBe(
      'attachment; filename="blossom.yaml"',
    );
  });

  it("uses the plain form for an ASCII title", () => {
    expect(buildContentDisposition("My VPN")).toBe(
      'attachment; filename="My VPN.yaml"',
    );
  });

  it("adds an RFC 6266 filename* for non-ASCII titles", () => {
    const header = buildContentDisposition("花朵 VPN");
    expect(header).toBe(
      "attachment; filename=\"__ VPN.yaml\"; filename*=UTF-8''%E8%8A%B1%E6%9C%B5%20VPN.yaml",
    );
  });

  it("falls back to the default name when nothing ASCII is left", () => {
    expect(buildContentDisposition("花朵")).toBe(
      "attachment; filename=\"blossom.yaml\"; filename*=UTF-8''%E8%8A%B1%E6%9C%B5.yaml",
    );
  });

  it("never lets quotes, slashes or control characters into the header", () => {
    const header = buildContentDisposition('a"b\\c/d\r\ne');
    expect(header).toBe('attachment; filename="a b c d e.yaml"');
    expect(header).not.toMatch(/[\r\n]/);
  });

  it("encodes RFC 5987 reserved characters in filename*", () => {
    expect(buildContentDisposition("é(1)*'")).toContain("%C3%A9%281%29%2A%27");
  });

  it("falls back to the default when the title is blank", () => {
    expect(buildContentDisposition("   ")).toBe(
      'attachment; filename="blossom.yaml"',
    );
  });
});

describe("default subscription-output settings", () => {
  it("produce the exact headers the endpoint always sent", () => {
    const defaults = defaultSection("subscription_output");
    expect(buildContentDisposition(defaults.profileTitle)).toBe(
      'attachment; filename="blossom.yaml"',
    );
    expect(
      buildProfileUpdateInterval(defaults.profileUpdateIntervalHours),
    ).toBe("24");
  });
});

describe("buildProfileUpdateInterval", () => {
  it("defaults to 24, as before settings existed", () => {
    expect(
      buildProfileUpdateInterval(DEFAULT_PROFILE_UPDATE_INTERVAL_HOURS),
    ).toBe("24");
  });

  it("emits whole hours", () => {
    expect(buildProfileUpdateInterval(6)).toBe("6");
    expect(buildProfileUpdateInterval(1.9)).toBe("1");
  });

  it("falls back to 24 for nonsense", () => {
    expect(buildProfileUpdateInterval(0)).toBe("24");
    expect(buildProfileUpdateInterval(Number.NaN)).toBe("24");
  });
});
