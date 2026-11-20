import { describe, expect, it } from "vitest";

import { highlightLogLine } from "./log-highlighter";

function joined(tokens: Awaited<ReturnType<typeof highlightLogLine>>): string {
  return (tokens ?? []).map((token) => token.content).join("");
}

describe("highlightLogLine", () => {
  it("loads the fine-grained bundle and preserves JSON text", async () => {
    const line = '{"level":"info","message":"started"}';
    const tokens = await highlightLogLine(line, "github-dark");

    expect(tokens).not.toBeNull();
    expect(joined(tokens)).toBe(line);
    expect(tokens?.some((token) => token.color)).toBe(true);
  });

  it("falls back and keeps plain log text intact", async () => {
    const line = "agent: connected to control plane";
    const tokens = await highlightLogLine(line, "github-light");

    expect(joined(tokens)).toBe(line);
  });

  it("removes control characters before tokenizing", async () => {
    const tokens = await highlightLogLine("safe\u0000text", "github-dark");
    expect(joined(tokens)).toBe("safe\uFFFDtext");
  });
});
