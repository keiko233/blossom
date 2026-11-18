import { describe, expect, it } from "vitest";

import {
  clampPtyDimensions,
  encodePtyFrame,
  isValidPtySessionId,
  parsePtyAgentFrame,
  parsePtyBrowserFrame,
  ptyCloseFrame,
  ptyExitFrame,
  ptyOpenFrame,
  PTY_MAX_COLS,
  PTY_MAX_ROWS,
  PTY_MIN_COLS,
  PTY_MIN_ROWS,
} from "./pty-protocol";

describe("PTY protocol helpers", () => {
  it("clamps terminal dimensions and rejects unsafe ids", () => {
    expect(clampPtyDimensions(1, 1)).toEqual({
      cols: PTY_MIN_COLS,
      rows: PTY_MIN_ROWS,
    });
    expect(clampPtyDimensions(9999, 9999)).toEqual({
      cols: PTY_MAX_COLS,
      rows: PTY_MAX_ROWS,
    });
    expect(clampPtyDimensions(Number.NaN, "x")).toEqual({
      cols: 80,
      rows: 24,
    });

    expect(isValidPtySessionId("pty-1234")).toBe(true);
    expect(isValidPtySessionId("../escape")).toBe(false);
    expect(isValidPtySessionId("-starts-with-dash")).toBe(false);
    expect(isValidPtySessionId("")).toBe(false);
  });

  it("accepts only input frames for the bound session", () => {
    const data = JSON.stringify({
      v: 1,
      type: "pty.data",
      payload: { sessionId: "pty-1", data: "ls\r" },
    });
    const parsed = parsePtyBrowserFrame(data, "pty-1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message).toEqual({
        type: "pty.data",
        payload: { sessionId: "pty-1", data: "ls\r" },
      });
    }

    expect(
      parsePtyBrowserFrame(
        JSON.stringify({
          v: 1,
          type: "pty.resize",
          payload: { sessionId: "pty-2", cols: 80, rows: 24 },
        }),
        "pty-1",
      ),
    ).toEqual({ ok: false, code: "wrong-session" });

    expect(
      parsePtyBrowserFrame(
        JSON.stringify({
          v: 1,
          type: "ping",
          payload: {},
        }),
        "pty-1",
      ),
    ).toEqual({ ok: false, code: "wrong-type" });
  });

  it("does not let the browser open or exit sessions", () => {
    expect(
      parsePtyBrowserFrame(
        JSON.stringify({
          v: 1,
          type: "pty.open",
          payload: { sessionId: "pty-1", cols: 80, rows: 24 },
        }),
        "pty-1",
      ),
    ).toEqual({ ok: false, code: "wrong-type" });
    expect(
      parsePtyBrowserFrame(
        JSON.stringify({
          v: 1,
          type: "pty.exit",
          payload: { sessionId: "pty-1", reason: "closed" },
        }),
        "pty-1",
      ),
    ).toEqual({ ok: false, code: "wrong-type" });
  });

  it("accepts only agent output frames for the bound session", () => {
    const frame = ptyExitFrame("pty-1", "idle_timeout");
    const parsed = parsePtyAgentFrame(frame, "pty-1");
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message).toEqual({
        type: "pty.exit",
        payload: { sessionId: "pty-1", reason: "idle_timeout" },
      });
    }
    expect(
      parsePtyAgentFrame(
        ptyOpenFrame("pty-1", { cols: 80, rows: 24 }),
        "pty-1",
      ),
    ).toEqual({ ok: false, code: "wrong-type" });
    expect(parsePtyAgentFrame(frame, "pty-2")).toEqual({
      ok: false,
      code: "wrong-session",
    });
  });

  it("encodes open/close frames deterministically", () => {
    expect(
      JSON.parse(
        encodePtyFrame(ptyOpenFrame("pty-1", { cols: 100, rows: 30 })),
      ),
    ).toMatchObject({
      type: "pty.open",
      payload: { sessionId: "pty-1", cols: 100, rows: 30 },
    });
    expect(JSON.parse(encodePtyFrame(ptyCloseFrame("pty-1")))).toMatchObject({
      type: "pty.close",
      payload: { sessionId: "pty-1" },
    });
  });
});
