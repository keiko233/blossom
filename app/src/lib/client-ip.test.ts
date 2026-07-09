import { describe, expect, it } from "vitest";

import { getClientIp } from "./client-ip";

function makeRequest(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/health", { headers });
}

describe("getClientIp", () => {
  it("prefers Cloudflare header over x-forwarded-for", () => {
    const request = makeRequest({
      "cf-connecting-ip": "1.1.1.1",
      "x-forwarded-for": "2.2.2.2, 3.3.3.3",
    });
    expect(getClientIp(request)).toBe("1.1.1.1");
  });

  it("prefers Netlify header over x-forwarded-for", () => {
    const request = makeRequest({
      "x-nf-client-connection-ip": "4.4.4.4",
      "x-forwarded-for": "5.5.5.5, 6.6.6.6",
    });
    expect(getClientIp(request)).toBe("4.4.4.4");
  });

  it("prefers Vercel header over x-forwarded-for", () => {
    const request = makeRequest({
      "x-vercel-forwarded-for": "7.7.7.7",
      "x-forwarded-for": "8.8.8.8, 9.9.9.9",
    });
    expect(getClientIp(request)).toBe("7.7.7.7");
  });

  it("prefers x-real-ip over x-forwarded-for", () => {
    const request = makeRequest({
      "x-real-ip": "10.10.10.10",
      "x-forwarded-for": "11.11.11.11, 12.12.12.12",
    });
    expect(getClientIp(request)).toBe("10.10.10.10");
  });

  it("follows the defined precedence order among platform headers", () => {
    const request = makeRequest({
      "x-real-ip": "10.10.10.10",
      "x-vercel-forwarded-for": "7.7.7.7",
      "x-nf-client-connection-ip": "4.4.4.4",
      "cf-connecting-ip": "1.1.1.1",
    });
    expect(getClientIp(request)).toBe("1.1.1.1");
  });

  it("takes the leftmost x-forwarded-for entry and trims whitespace", () => {
    const request = makeRequest({
      "x-forwarded-for": "  13.13.13.13  , 14.14.14.14 ",
    });
    expect(getClientIp(request)).toBe("13.13.13.13");
  });

  it("returns null when no relevant headers are present", () => {
    const request = makeRequest({});
    expect(getClientIp(request)).toBeNull();
  });
});
