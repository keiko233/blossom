import { describe, expect, it } from "vitest";

import {
  clampTerminalFontSize,
  formatTerminalIdentity,
  formatTerminalSize,
  readTerminalFontSize,
  TERMINAL_FONT_SIZE,
  TERMINAL_FONT_SIZE_STORAGE_KEY,
  terminalPhasePulse,
  terminalPhaseTone,
  terminalTransportLabel,
  writeTerminalFontSize,
  type TerminalFontStorage,
  type TerminalPhase,
} from "./terminal-view";

const ALL_PHASES: TerminalPhase[] = [
  "idle",
  "connecting",
  "connected",
  "closed",
  "error",
];

describe("terminalPhaseTone", () => {
  it.each([
    ["idle", "muted"],
    ["connecting", "info"],
    ["connected", "success"],
    ["closed", "muted"],
    ["error", "danger"],
  ] satisfies [TerminalPhase, string][])(
    "maps %s to the %s tone",
    (phase, tone) => {
      expect(terminalPhaseTone(phase)).toBe(tone);
    },
  );

  it("covers every phase", () => {
    for (const phase of ALL_PHASES) {
      expect(terminalPhaseTone(phase)).toBeTruthy();
    }
  });
});

describe("terminalPhasePulse", () => {
  it("pulses only while connecting", () => {
    for (const phase of ALL_PHASES) {
      expect(terminalPhasePulse(phase)).toBe(phase === "connecting");
    }
  });
});

describe("formatTerminalIdentity", () => {
  it("formats user, host and shell", () => {
    expect(formatTerminalIdentity("keiko", "/bin/bash", "10.0.0.4")).toBe(
      "keiko@10.0.0.4 — /bin/bash",
    );
  });

  it("falls back for empty values", () => {
    expect(formatTerminalIdentity("", "", "")).toBe(
      "unknown@unknown — unknown",
    );
    expect(formatTerminalIdentity("  ", "/bin/sh", " ")).toBe(
      "unknown@unknown — /bin/sh",
    );
  });
});

describe("formatTerminalSize", () => {
  it("formats columns and rows", () => {
    expect(formatTerminalSize(120, 32)).toBe("120×32");
  });

  it("shows a dash until both dimensions exist", () => {
    expect(formatTerminalSize(null, null)).toBe("—");
    expect(formatTerminalSize(120, null)).toBe("—");
    expect(formatTerminalSize(null, 32)).toBe("—");
  });
});

describe("terminalTransportLabel", () => {
  it("uses wss on https and ws otherwise", () => {
    expect(terminalTransportLabel("https:")).toBe("wss · pty");
    expect(terminalTransportLabel("http:")).toBe("ws · pty");
  });
});

describe("clampTerminalFontSize", () => {
  it("clamps to the supported range", () => {
    expect(clampTerminalFontSize(Number.NEGATIVE_INFINITY)).toBe(
      TERMINAL_FONT_SIZE.default,
    );
    expect(clampTerminalFontSize(9)).toBe(TERMINAL_FONT_SIZE.min);
    expect(clampTerminalFontSize(10)).toBe(TERMINAL_FONT_SIZE.min);
    expect(clampTerminalFontSize(24)).toBe(TERMINAL_FONT_SIZE.max);
    expect(clampTerminalFontSize(40)).toBe(TERMINAL_FONT_SIZE.max);
  });

  it("rounds fractional sizes and defaults non-numbers", () => {
    expect(clampTerminalFontSize(13.4)).toBe(13);
    expect(clampTerminalFontSize(13.6)).toBe(14);
    expect(clampTerminalFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE.default);
  });
});

describe("terminal font storage", () => {
  function memoryStorage(
    initial: Record<string, string> = {},
  ): TerminalFontStorage & { values: Record<string, string> } {
    const values = { ...initial };
    return {
      values,
      getItem: (key) => values[key] ?? null,
      setItem: (key, value) => {
        values[key] = value;
      },
    };
  }

  it("writes clamped values and reads them back", () => {
    const storage = memoryStorage();
    writeTerminalFontSize(storage, 18.4);
    expect(storage.values[TERMINAL_FONT_SIZE_STORAGE_KEY]).toBe("18");
    expect(readTerminalFontSize(storage)).toBe(18);
  });

  it("clamps stored values while reading", () => {
    expect(
      readTerminalFontSize(
        memoryStorage({ [TERMINAL_FONT_SIZE_STORAGE_KEY]: "40" }),
      ),
    ).toBe(TERMINAL_FONT_SIZE.max);
    expect(
      readTerminalFontSize(
        memoryStorage({ [TERMINAL_FONT_SIZE_STORAGE_KEY]: "2" }),
      ),
    ).toBe(TERMINAL_FONT_SIZE.min);
  });

  it("uses the default for missing and garbage values", () => {
    expect(readTerminalFontSize(memoryStorage())).toBe(
      TERMINAL_FONT_SIZE.default,
    );
    expect(
      readTerminalFontSize(
        memoryStorage({ [TERMINAL_FONT_SIZE_STORAGE_KEY]: "13px" }),
      ),
    ).toBe(TERMINAL_FONT_SIZE.default);
    expect(
      readTerminalFontSize(
        memoryStorage({ [TERMINAL_FONT_SIZE_STORAGE_KEY]: "   " }),
      ),
    ).toBe(TERMINAL_FONT_SIZE.default);
  });

  it("survives storage that throws", () => {
    const throwing: TerminalFontStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readTerminalFontSize(throwing)).toBe(TERMINAL_FONT_SIZE.default);
    expect(() => writeTerminalFontSize(throwing, 15)).not.toThrow();
  });

  it("uses the default without storage", () => {
    expect(readTerminalFontSize(null)).toBe(TERMINAL_FONT_SIZE.default);
    expect(() => writeTerminalFontSize(null, 15)).not.toThrow();
  });
});
