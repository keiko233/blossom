import { describe, expect, it } from "vitest";

import { detectRuntime } from "./runtime-info";

describe("detectRuntime", () => {
  it("recognizes Cloudflare Workers by their user agent", () => {
    expect(
      detectRuntime({ userAgent: "Cloudflare-Workers", env: { VERCEL: "1" } }),
    ).toBe("cloudflare");
  });

  it("recognizes Vercel and Netlify by marker variables", () => {
    expect(
      detectRuntime({ userAgent: "Node.js/24", env: { VERCEL: "1" } }),
    ).toBe("vercel");
    expect(detectRuntime({ env: { NETLIFY: "true" } })).toBe("netlify");
  });

  it("defaults to node, or unknown without a Node process", () => {
    expect(detectRuntime({ env: {} })).toBe("node");
    expect(detectRuntime({ hasNodeProcess: false })).toBe("unknown");
  });
});
