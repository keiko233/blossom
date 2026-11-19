import {
  parseAgentWsFrame,
  type AgentWsPtyExitReason,
} from "@blossom/contracts/agent-ws";

import { recordPtySessionClose } from "@/query/pty-audit";

import {
  encodePtyFrame,
  parsePtyAgentFrame,
  parsePtyBrowserFrame,
  PTY_MAX_SESSIONS_PER_SERVER,
  ptyCloseFrame,
  ptyExitFrame,
  ptyOpenFrame,
} from "./pty-protocol";
import type { AdminPtyAcceptContext } from "./pty-relay-types";
import {
  attachCrosswsHooks,
  getRealtimeHub,
  type PtyRelayEvent,
} from "./realtime-hub";
import type { AgentPtyTarget } from "./realtime-hub-types";

interface PtyPeer {
  id: string;
  send(data: string): unknown;
  close(code?: number, reason?: string): void;
}

interface PtyMessage {
  text(): string;
}

/**
 * Re-checks the admin session and agent connection while a shell is open.
 * Revocation is enforced here and at the agent's own idle and hard limits.
 */
const PTY_REVALIDATE_INTERVAL_MS = 30 * 1000;
/**
 * Backstop for a silent socket only. The agent enforces the operator's idle
 * limit (up to one hour) and closes the shell itself, so this must not be
 * shorter than that limit.
 */
const PTY_RELAY_IDLE_BACKSTOP_MS = 60 * 60 * 1000;

function ptyTarget(context: AdminPtyAcceptContext): AgentPtyTarget {
  return {
    protocol: context.agentProtocol,
    connectedAt: context.connectedAt,
    agentSessionId: context.agentSessionId,
  };
}

class PtyRelay {
  private readonly hub = getRealtimeHub();
  private unregister: (() => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private revalidateTimer: ReturnType<typeof setInterval> | undefined;
  private finished = false;

  constructor(
    private readonly peer: PtyPeer,
    private readonly context: AdminPtyAcceptContext,
  ) {}

  async start(): Promise<void> {
    const target = ptyTarget(this.context);
    this.unregister = this.hub.registerPtyRelay(
      this.context.serverId,
      target,
      this.context.sessionId,
      (event) => {
        void this.onAgentEvent(event);
      },
    );
    const sent = await this.hub.sendPtyFrame(
      this.context.serverId,
      target,
      this.context.sessionId,
      encodePtyFrame(
        ptyOpenFrame(this.context.sessionId, {
          cols: this.context.cols,
          rows: this.context.rows,
        }),
      ),
    );
    if (!sent) {
      await this.finish({
        reason: "agent_disconnected",
        closeCode: 1011,
        notifyAgent: false,
        sendExit: true,
      });
      return;
    }
    this.touch();
    this.revalidateTimer = setInterval(() => {
      void this.revalidate();
    }, PTY_REVALIDATE_INTERVAL_MS);
    (this.revalidateTimer as { unref?: () => void }).unref?.();
  }

  async handleMessage(message: PtyMessage): Promise<void> {
    const parsed = parsePtyBrowserFrame(message.text(), this.context.sessionId);
    if (!parsed.ok) {
      await this.finish({
        reason: parsed.code === "too-large" ? "frame_too_large" : "closed",
        closeCode: 1008,
        notifyAgent: true,
        sendExit: true,
      });
      return;
    }
    this.touch();
    const sent = await this.hub.sendPtyFrame(
      this.context.serverId,
      ptyTarget(this.context),
      this.context.sessionId,
      encodePtyFrame(parsed.frame),
    );
    if (!sent) {
      await this.finish({
        reason: "agent_disconnected",
        closeCode: 1011,
        notifyAgent: false,
        sendExit: true,
      });
      return;
    }
    if (parsed.message.type === "pty.close") {
      await this.finish({
        reason: "closed",
        closeCode: 1000,
        notifyAgent: false,
        sendExit: false,
      });
    }
  }

  async handleBrowserClose(): Promise<void> {
    await this.finish({
      reason: "browser_closed",
      closeCode: 1000,
      notifyAgent: true,
      sendExit: false,
    });
  }

  private async onAgentEvent(event: PtyRelayEvent): Promise<void> {
    if (event.type === "agent_disconnected") {
      await this.finish({
        reason: "agent_disconnected",
        closeCode: 1011,
        notifyAgent: false,
        sendExit: true,
      });
      return;
    }

    const parsedFrame = parseAgentWsFrame(event.frame);
    if (!parsedFrame.ok) {
      return;
    }
    const parsed = parsePtyAgentFrame(
      parsedFrame.frame,
      this.context.sessionId,
    );
    if (!parsed.ok) {
      return;
    }
    this.send(encodePtyFrame(parsed.frame));
    this.touch();
    if (parsed.message.type === "pty.exit") {
      await this.finish({
        reason: parsed.message.payload.reason ?? "closed",
        code: parsed.message.payload.code,
        signal: parsed.message.payload.signal,
        closeCode: 1000,
        notifyAgent: false,
        sendExit: false,
      });
    }
  }

  private touch(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    if (this.finished) {
      return;
    }
    this.timer = setTimeout(() => {
      void this.finish({
        reason: "idle_timeout",
        closeCode: 1000,
        notifyAgent: true,
        sendExit: true,
      });
    }, PTY_RELAY_IDLE_BACKSTOP_MS);
    (this.timer as { unref?: () => void }).unref?.();
  }

  /** Fails closed: an error while re-checking is treated as revocation. */
  private async revalidate(): Promise<void> {
    if (this.finished) {
      return;
    }
    const authorized = await this.context.isAuthorized().catch(() => false);
    if (!authorized) {
      await this.finish({
        reason: "authorization_revoked",
        closeCode: 1008,
        notifyAgent: true,
        sendExit: true,
      });
    }
  }

  private send(frame: string): void {
    try {
      this.peer.send(frame);
    } catch {
      // The close hook finishes the session.
    }
  }

  private async finish(options: {
    reason: AgentWsPtyExitReason | "browser_closed";
    code?: number;
    signal?: string;
    closeCode: number;
    notifyAgent: boolean;
    sendExit: boolean;
    closePeer?: boolean;
  }): Promise<void> {
    if (this.finished) {
      return;
    }
    this.finished = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.revalidateTimer) {
      clearInterval(this.revalidateTimer);
      this.revalidateTimer = undefined;
    }
    this.unregister?.();
    this.unregister = undefined;

    if (options.notifyAgent) {
      void this.hub.sendPtyFrame(
        this.context.serverId,
        ptyTarget(this.context),
        this.context.sessionId,
        encodePtyFrame(ptyCloseFrame(this.context.sessionId)),
      );
    }
    if (options.sendExit) {
      const reason =
        options.reason === "browser_closed" ? "closed" : options.reason;
      this.send(
        encodePtyFrame(
          ptyExitFrame(
            this.context.sessionId,
            reason,
            options.code,
            options.signal,
          ),
        ),
      );
    }

    await recordPtySessionClose({
      session: this.context.session,
      reason: options.reason,
      ...(options.code === undefined ? {} : { code: options.code }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }).catch((error: unknown) => {
      console.warn("PTY close audit failed", error);
    });

    if (options.closePeer ?? true) {
      try {
        this.peer.close(options.closeCode, options.reason);
      } catch {
        // Already closed by the peer.
      }
    }
  }
}

export async function acceptAdminPty(
  request: Request,
  context: AdminPtyAcceptContext,
): Promise<Response> {
  const hub = getRealtimeHub();
  if (hub.hasPtyRelay(context.serverId, context.sessionId)) {
    return Response.json(
      { error: "duplicate_session" },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  if (hub.countPtyRelays(context.serverId) >= PTY_MAX_SESSIONS_PER_SERVER) {
    return Response.json(
      { error: "session_limit" },
      { status: 429, headers: { "cache-control": "no-store" } },
    );
  }
  if (!(await hub.hasAgentConnection(context.serverId, ptyTarget(context)))) {
    return Response.json(
      { error: "agent_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const response = new Response(null, {
    status: 426,
    headers: { Connection: "Upgrade", Upgrade: "websocket" },
  });
  let relay: PtyRelay | undefined;
  return attachCrosswsHooks(response, request, {
    open: async (peer) => {
      relay = new PtyRelay(peer, context);
      await relay.start();
    },
    message: async (_peer, message) => {
      await relay?.handleMessage(message);
    },
    close: async () => {
      const current = relay;
      relay = undefined;
      await current?.handleBrowserClose();
    },
    error: (peer, error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`PTY websocket error (${peer.id}): ${message}`);
    },
  });
}
