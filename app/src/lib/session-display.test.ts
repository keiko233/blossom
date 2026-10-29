import { describe, expect, it } from "vitest";

import { describeSessionUserAgent } from "./session-display";

describe("describeSessionUserAgent", () => {
  it("returns null for a missing or blank user agent", () => {
    expect(describeSessionUserAgent(null)).toBeNull();
    expect(describeSessionUserAgent(undefined)).toBeNull();
    expect(describeSessionUserAgent("   ")).toBeNull();
  });

  it("names Chrome on Windows with the major version", () => {
    expect(
      describeSessionUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome 126 · Windows");
  });

  it("prefers Edge over the Chrome and Safari tokens it also carries", () => {
    expect(
      describeSessionUserAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.81",
      ),
    ).toBe("Edge 126 · Windows");
  });

  it("names Firefox on Linux", () => {
    expect(
      describeSessionUserAgent(
        "Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0",
      ),
    ).toBe("Firefox 128 · Linux");
  });

  it("names Safari on macOS", () => {
    expect(
      describeSessionUserAgent(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
      ),
    ).toBe("Safari 17 · macOS");
  });

  it("reports Android and iOS rather than the desktop systems they mimic", () => {
    expect(
      describeSessionUserAgent(
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
      ),
    ).toBe("Chrome 126 · Android");
    expect(
      describeSessionUserAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari 17 · iOS");
  });

  it("falls back to proxy-client names", () => {
    expect(describeSessionUserAgent("clash-verge/v1.7.7")).toBe(
      "Clash Verge 1.7.7",
    );
    expect(describeSessionUserAgent("curl/8.4.0")).toBe("curl 8.4.0");
  });

  it("falls back to the raw string, truncated when long", () => {
    expect(describeSessionUserAgent("custom-agent")).toBe("custom-agent");
    const long = "x".repeat(200);
    expect(describeSessionUserAgent(long)).toBe(`${"x".repeat(80)}…`);
  });
});
