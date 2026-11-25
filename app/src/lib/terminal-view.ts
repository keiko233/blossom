export type TerminalPhase =
  | "idle"
  | "connecting"
  | "connected"
  | "closed"
  | "error";

export type TerminalPhaseTone = "success" | "info" | "danger" | "muted";

export const TERMINAL_FONT_SIZE = {
  min: 10,
  max: 24,
  default: 13,
} as const;

export const TERMINAL_FONT_SIZE_STORAGE_KEY = "blossom.terminal.font-size.v1";

export interface TerminalFontStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function terminalPhaseTone(phase: TerminalPhase): TerminalPhaseTone {
  switch (phase) {
    case "connected":
      return "success";
    case "connecting":
      return "info";
    case "error":
      return "danger";
    default:
      return "muted";
  }
}

export function terminalPhasePulse(phase: TerminalPhase): boolean {
  return phase === "connecting";
}

/** Compact session identity: `user@host — shell`, with explicit fallbacks. */
export function formatTerminalIdentity(
  user: string,
  shell: string,
  host: string,
): string {
  const userName = user.trim() || "unknown";
  const shellName = shell.trim() || "unknown";
  const hostName = host.trim() || "unknown";
  return `${userName}@${hostName} — ${shellName}`;
}

export function formatTerminalSize(
  cols: number | null,
  rows: number | null,
): string {
  if (cols === null || rows === null) {
    return "—";
  }
  return `${cols}×${rows}`;
}

export function terminalTransportLabel(protocol: string): string {
  return protocol === "https:" ? "wss · pty" : "ws · pty";
}

export function clampTerminalFontSize(value: number): number {
  if (!Number.isFinite(value)) {
    return TERMINAL_FONT_SIZE.default;
  }
  return Math.min(
    TERMINAL_FONT_SIZE.max,
    Math.max(TERMINAL_FONT_SIZE.min, Math.round(value)),
  );
}

export function readTerminalFontSize(
  storage: Pick<TerminalFontStorage, "getItem"> | null | undefined,
): number {
  if (!storage) {
    return TERMINAL_FONT_SIZE.default;
  }
  try {
    const raw = storage.getItem(TERMINAL_FONT_SIZE_STORAGE_KEY);
    if (raw === null || raw.trim() === "") {
      return TERMINAL_FONT_SIZE.default;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed)
      ? clampTerminalFontSize(parsed)
      : TERMINAL_FONT_SIZE.default;
  } catch {
    return TERMINAL_FONT_SIZE.default;
  }
}

export function writeTerminalFontSize(
  storage: Pick<TerminalFontStorage, "setItem"> | null | undefined,
  value: number,
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(
      TERMINAL_FONT_SIZE_STORAGE_KEY,
      String(clampTerminalFontSize(value)),
    );
  } catch {
    // Private windows and blocked storage still allow a working terminal.
  }
}
