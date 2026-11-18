import {
  AGENT_WS_PTY_CAPABILITY,
  AGENT_WS_PTY_MAX_DATA_BYTES,
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
  parseAgentWsPtyMessage,
  type AgentWsFrame,
  type AgentWsPtyClosePayload,
  type AgentWsPtyDataPayload,
  type AgentWsPtyExitPayload,
  type AgentWsPtyExitReason,
  type AgentWsPtyResizePayload,
} from "@blossom/contracts/agent-ws";

export const PTY_CAPABILITY = AGENT_WS_PTY_CAPABILITY;
export const PTY_MAX_SESSIONS_PER_SERVER = 2;
export const PTY_MIN_COLS = 20;
export const PTY_MAX_COLS = 400;
export const PTY_MIN_ROWS = 5;
export const PTY_MAX_ROWS = 200;
/** One terminal data payload plus a small envelope allowance. */
export const PTY_MAX_BROWSER_FRAME_BYTES = AGENT_WS_PTY_MAX_DATA_BYTES + 4096;

export interface PtyDimensions {
  cols: number;
  rows: number;
}

export function clampPtyDimensions(
  cols: unknown,
  rows: unknown,
): PtyDimensions {
  const parsedCols =
    typeof cols === "number" && Number.isFinite(cols) ? cols : 80;
  const parsedRows =
    typeof rows === "number" && Number.isFinite(rows) ? rows : 24;
  return {
    cols: Math.min(
      PTY_MAX_COLS,
      Math.max(PTY_MIN_COLS, Math.trunc(parsedCols)),
    ),
    rows: Math.min(
      PTY_MAX_ROWS,
      Math.max(PTY_MIN_ROWS, Math.trunc(parsedRows)),
    ),
  };
}

export function isValidPtySessionId(sessionId: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId);
}

export type PtyBrowserMessage =
  | { type: "pty.data"; payload: AgentWsPtyDataPayload }
  | { type: "pty.resize"; payload: AgentWsPtyResizePayload }
  | { type: "pty.close"; payload: AgentWsPtyClosePayload };

export type PtyAgentMessage =
  | { type: "pty.data"; payload: AgentWsPtyDataPayload }
  | { type: "pty.exit"; payload: AgentWsPtyExitPayload };

export type PtyParseFailure =
  | "too-large"
  | "invalid-json"
  | "invalid-payload"
  | "wrong-type"
  | "wrong-session";

export type PtyBrowserParseResult =
  | { ok: true; frame: AgentWsFrame; message: PtyBrowserMessage }
  | { ok: false; code: PtyParseFailure };

export type PtyAgentParseResult =
  | { ok: true; frame: AgentWsFrame; message: PtyAgentMessage }
  | { ok: false; code: PtyParseFailure };

function encodedBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Accepts only terminal input from the browser. The session id is bound at
 * upgrade time and cannot be changed by a frame.
 */
export function parsePtyBrowserFrame(
  text: string,
  sessionId: string,
): PtyBrowserParseResult {
  if (text.length > PTY_MAX_BROWSER_FRAME_BYTES) {
    return { ok: false, code: "too-large" };
  }
  const parsed = parseAgentWsFrame(text);
  if (!parsed.ok) {
    return {
      ok: false,
      code: parsed.code === "invalid-json" ? "invalid-json" : "invalid-payload",
    };
  }
  const pty = parseAgentWsPtyMessage(parsed.frame.type, parsed.frame.payload);
  if (!pty) {
    return { ok: false, code: "wrong-type" };
  }
  if (!pty.ok) {
    return { ok: false, code: "invalid-payload" };
  }
  if (pty.message.type === "pty.open" || pty.message.type === "pty.exit") {
    return { ok: false, code: "wrong-type" };
  }
  if (pty.message.payload.sessionId !== sessionId) {
    return { ok: false, code: "wrong-session" };
  }
  if (
    pty.message.type === "pty.data" &&
    encodedBytes(pty.message.payload.data) > AGENT_WS_PTY_MAX_DATA_BYTES
  ) {
    return { ok: false, code: "too-large" };
  }
  return {
    ok: true,
    frame: createAgentWsFrame(pty.message.type, pty.message.payload),
    message: pty.message,
  };
}

/** Accepts only output from the agent. */
export function parsePtyAgentFrame(
  frame: AgentWsFrame,
  sessionId: string,
): PtyAgentParseResult {
  const pty = parseAgentWsPtyMessage(frame.type, frame.payload);
  if (!pty) {
    return { ok: false, code: "wrong-type" };
  }
  if (!pty.ok) {
    return { ok: false, code: "invalid-payload" };
  }
  if (pty.message.type !== "pty.data" && pty.message.type !== "pty.exit") {
    return { ok: false, code: "wrong-type" };
  }
  if (pty.message.payload.sessionId !== sessionId) {
    return { ok: false, code: "wrong-session" };
  }
  if (
    pty.message.type === "pty.data" &&
    encodedBytes(pty.message.payload.data) > AGENT_WS_PTY_MAX_DATA_BYTES
  ) {
    return { ok: false, code: "too-large" };
  }
  return {
    ok: true,
    frame: createAgentWsFrame(pty.message.type, pty.message.payload),
    message: pty.message,
  };
}

export function ptyOpenFrame(
  sessionId: string,
  dimensions: PtyDimensions,
): AgentWsFrame {
  return createAgentWsFrame("pty.open", {
    sessionId,
    cols: dimensions.cols,
    rows: dimensions.rows,
  });
}

export function ptyCloseFrame(sessionId: string): AgentWsFrame {
  return createAgentWsFrame("pty.close", { sessionId });
}

export function ptyExitFrame(
  sessionId: string,
  reason: AgentWsPtyExitReason,
  code?: number,
  signal?: string,
): AgentWsFrame {
  return createAgentWsFrame("pty.exit", {
    sessionId,
    reason,
    ...(code === undefined ? {} : { code }),
    ...(signal === undefined ? {} : { signal }),
  });
}

export function encodePtyFrame(frame: AgentWsFrame): string {
  return encodeAgentWsFrame(frame);
}
