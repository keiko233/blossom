import {
  agentWsTelemetrySamplePayloadSchema,
  agentWsTelemetrySnapshotPayloadSchema,
  createAgentWsFrame,
  encodeAgentWsFrame,
  parseAgentWsFrame,
} from "@blossom/contracts/agent-ws";

export type TelemetryKind = "sample" | "snapshot";
export type TelemetryResult =
  | {
      kind: "sample";
      data: ReturnType<typeof agentWsTelemetrySamplePayloadSchema.parse>;
    }
  | {
      kind: "snapshot";
      data: ReturnType<typeof agentWsTelemetrySnapshotPayloadSchema.parse>;
    };

export const MAX_TELEMETRY_FRAME = 48 * 1024;

export function telemetryReply(text: string): TelemetryResult | null {
  if (text.length > MAX_TELEMETRY_FRAME) return null;
  const parsed = parseAgentWsFrame(text);
  if (!parsed.ok) return null;
  if (parsed.frame.type === "telemetry.sample") {
    const result = agentWsTelemetrySamplePayloadSchema.safeParse(
      parsed.frame.payload,
    );
    if (result.success) return { kind: "sample", data: result.data };
  }
  if (parsed.frame.type === "telemetry.snapshot") {
    const result = agentWsTelemetrySnapshotPayloadSchema.safeParse(
      parsed.frame.payload,
    );
    if (result.success) return { kind: "snapshot", data: result.data };
  }
  return null;
}

interface Pending {
  id: string;
  result: Promise<TelemetryResult | null>;
  finish: (reply: TelemetryResult | null) => void;
}

export class TelemetryRequests {
  private readonly pending = new Map<string, Pending>();

  async request(
    serverId: string,
    kind: TelemetryKind,
    send: (frame: string) => void,
  ): Promise<TelemetryResult | null> {
    const key = JSON.stringify([serverId, kind]);
    const existing = this.pending.get(key);
    if (existing) return existing.result;
    if (this.pending.size >= 128) return null;
    const id = crypto.randomUUID();
    let finish!: Pending["finish"];
    const result = new Promise<TelemetryResult | null>((resolve) => {
      finish = resolve;
    });
    this.pending.set(key, { id, result, finish });
    const timer = setTimeout(() => finish(null), 2_500);
    try {
      send(
        encodeAgentWsFrame(
          createAgentWsFrame(
            kind === "sample" ? "telemetry.subscribe" : "telemetry.inspect",
            { requestId: id, enabled: true },
          ),
        ),
      );
      return await result;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      this.pending.delete(key);
      finish(null);
    }
  }

  accept(serverId: string, reply: TelemetryResult): void {
    const pending = this.pending.get(JSON.stringify([serverId, reply.kind]));
    if (pending?.id === reply.data.requestId) {
      pending.finish(reply);
    }
  }
}
