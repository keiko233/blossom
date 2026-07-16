import { describe, expect, it } from "vitest";

import { isLoopbackUrl } from "./oauth-callback";

describe("isLoopbackUrl", () => {
  it.each([
    "http://localhost:3000/callback?code=test",
    "http://127.0.0.1:3000/callback?code=test",
    "http://[::1]:3000/callback?code=test",
  ])("accepts the loopback callback %s", (value) => {
    expect(isLoopbackUrl(value)).toBe(true);
  });

  it.each([
    "https://agent.example.com/callback",
    "https://localhost.example.com/callback",
    "not-a-url",
  ])("rejects the non-loopback callback %s", (value) => {
    expect(isLoopbackUrl(value)).toBe(false);
  });
});
