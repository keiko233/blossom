import { revalidateLogRelay, type LogAuthorityStore } from "./logs-authority";
import {
  createLogRelayState,
  LOG_RELAY_CLOSE,
  LOG_RELAY_LIMITS,
  reduceLogRelay,
  type LogRelayAuditRecord,
  type LogRelayEffect,
  type LogRelayEvent,
  type LogRelayState,
} from "./logs-relay";
import type { AdminLogsAcceptContext } from "./logs-relay-types";

/**
 * The browser and agent sides of one Nitro/Vercel admin log relay. The hub
 * supplies the transport; the reducer supplies every policy decision.
 */
export interface AdminLogRelayPort {
  sendToBrowser(frame: string): void;
  /**
   * Hands one already-encoded control frame to the agent session named at
   * admission. False means this instance has neither a local session nor a
   * backplane, so the relay must report the agent as offline.
   */
  sendToAgent(frame: string): boolean;
  close(code: number, reason: string): void;
}

export interface AdminLogRelayOptions {
  context: AdminLogsAcceptContext;
  port: AdminLogRelayPort;
  authority: LogAuthorityStore;
  audit(record: LogRelayAuditRecord): Promise<void>;
  now?(): number;
  newId?(): string;
  tickIntervalMs?: number;
  revalidateIntervalMs?: number;
}

/** Request deadlines and authority checks need a prompt, cheap timer. */
export const LOG_RELAY_TICK_MS = 1_000;
/** A re-check that does not answer within this window counts as failure. */
export const LOG_RELAY_REVALIDATE_TIMEOUT_MS = 10_000;

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("log relay re-check timed out")),
      ms,
    );
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  (timer as { unref?: () => void }).unref?.();
}

/**
 * Owns the persisted relay state and the runtime timers. A closed relay
 * unregisters from the hub, clears both timers and performs every remaining
 * reducer effect exactly once.
 */
export class NitroAdminLogRelay {
  readonly state: LogRelayState;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly tickIntervalMs: number;
  private readonly revalidateIntervalMs: number;
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  private revalidateTimer: ReturnType<typeof setInterval> | undefined;
  private revalidating = false;
  private closed = false;
  private agentFailed = false;

  constructor(private readonly options: AdminLogRelayOptions) {
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => crypto.randomUUID());
    this.tickIntervalMs = options.tickIntervalMs ?? LOG_RELAY_TICK_MS;
    this.revalidateIntervalMs =
      options.revalidateIntervalMs ?? LOG_RELAY_LIMITS.revalidateIntervalMs;
    this.state = createLogRelayState({
      relayId: options.context.relayId,
      serverId: options.context.serverId,
      sessionId: options.context.agentSessionId,
      nowMs: this.now(),
    });
  }

  get done(): boolean {
    return this.closed;
  }

  start(): void {
    if (this.closed) {
      return;
    }
    this.tickTimer = setInterval(() => {
      this.dispatch({ type: "tick", nowMs: this.now() });
    }, this.tickIntervalMs);
    unrefTimer(this.tickTimer);
    this.revalidateTimer = setInterval(() => {
      void this.revalidate();
    }, this.revalidateIntervalMs);
    unrefTimer(this.revalidateTimer);
  }

  handleBrowser(text: string): void {
    this.dispatch({ type: "browser", text, nowMs: this.now() });
  }

  handleBrowserClosed(): void {
    this.dispatch({ type: "browserClosed", nowMs: this.now() });
  }

  handleAgentFrame(frame: string): void {
    this.dispatch({
      type: "agent",
      serverId: this.options.context.serverId,
      sessionId: this.options.context.agentSessionId,
      text: frame,
      nowMs: this.now(),
    });
  }

  handleAgentGone(reason: "agent_disconnected" | "session_replaced"): void {
    this.dispatch({ type: "agentGone", reason, nowMs: this.now() });
  }

  stop(): void {
    this.closed = true;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
    if (this.revalidateTimer) {
      clearInterval(this.revalidateTimer);
      this.revalidateTimer = undefined;
    }
  }

  private dispatch(event: LogRelayEvent): void {
    if (this.closed) {
      return;
    }
    const effects = reduceLogRelay(this.state, event, {
      newId: this.newId,
    });
    this.agentFailed = false;
    for (const effect of effects) {
      this.perform(effect);
    }
    if (this.agentFailed && !this.closed) {
      this.dispatch({
        type: "agentGone",
        reason: "agent_disconnected",
        nowMs: this.now(),
      });
    }
  }

  private perform(effect: LogRelayEffect): void {
    if (this.closed) {
      return;
    }
    switch (effect.type) {
      case "send":
        try {
          this.options.port.sendToBrowser(effect.frame);
        } catch {
          this.handleBrowserClosed();
        }
        return;
      case "toAgent":
        if (!this.options.port.sendToAgent(effect.frame)) {
          this.agentFailed = true;
        }
        return;
      case "audit":
        void this.options.audit(effect.record).catch((error: unknown) => {
          const message =
            error instanceof Error ? error.message : String(error);
          console.warn(`admin log relay audit failed: ${message}`);
        });
        return;
      case "close":
        try {
          this.options.port.close(effect.code, effect.reason);
        } catch {
          // The browser side is already gone.
        }
        this.stop();
        return;
    }
  }

  private async revalidate(): Promise<void> {
    if (this.closed || this.revalidating) {
      return;
    }
    this.revalidating = true;
    const context = this.options.context;
    try {
      const reason = await withDeadline(
        revalidateLogRelay(this.options.authority, {
          serverId: context.serverId,
          sessionId: context.agentSessionId,
          authSessionId: context.authSessionId,
          now: new Date(this.now()),
        }),
        LOG_RELAY_REVALIDATE_TIMEOUT_MS,
      );
      if (reason) {
        this.dispatch({ type: "revoked", reason, nowMs: this.now() });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`admin log relay re-check failed: ${message}`);
      this.dispatch({
        type: "revoked",
        reason: "forbidden",
        nowMs: this.now(),
      });
    } finally {
      this.revalidating = false;
    }
  }
}

/** Close code exported for route tests that assert the relay's own lifecycle. */
export const ADMIN_LOG_RELAY_CLOSE = LOG_RELAY_CLOSE;
