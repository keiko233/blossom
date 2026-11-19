import {
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsPtyMessage,
  type AgentWsFrame,
} from "@blossom/contracts/agent-ws";
import {
  createAgentWsV2Frame,
  encodeAgentWsV2Frame,
} from "@blossom/contracts/agent-ws-v2";

/**
 * The browser terminal keeps speaking the frozen v1 `pty.*` envelopes. These
 * two adapters are the only place that rewrites them for a v2 agent socket, so
 * neither the UI nor the relay needs a protocol-specific copy of the payload
 * validation.
 */
export function encodePtyFrameForAgentV2(frame: AgentWsFrame): string | null {
  const pty = parseAgentWsPtyMessage(frame.type, frame.payload);
  if (!pty?.ok || pty.message.type === "pty.exit") {
    return null;
  }
  return encodeAgentWsV2Frame(
    createAgentWsV2Frame(pty.message.type, pty.message.payload),
  );
}

/** Builds the v1 browser frame an agent v2 `pty.*` message becomes. */
export function v2PtyFrameForBrowser(
  type: "pty.started" | "pty.data" | "pty.exit",
  payload: unknown,
): string | null {
  const pty = parseAgentWsPtyMessage(type, payload);
  return pty?.ok
    ? encodeAgentWsFrame(
        createAgentWsFrame(pty.message.type, pty.message.payload),
      )
    : null;
}
