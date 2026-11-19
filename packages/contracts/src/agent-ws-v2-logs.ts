import { z } from "zod";

/**
 * Remote log tail, retained search and context lookup for agent WebSocket
 * protocol v2. The messages are added to the v2 envelope (`agent-ws-v2.ts`)
 * and use the same `{ v, id?, type, ts, payload }` frame.
 *
 * Two wire surfaces share the message names below:
 *
 * - **Agent wire.** The control plane sends the `logs.subscribe`,
 *   `logs.unsubscribe`, `logs.search`, `logs.search.cancel` and `logs.context`
 *   requests to the agent. The agent answers with `logs.batch`, `logs.gap`,
 *   `logs.search.result`, `logs.context.result` and `logs.error`. Each
 *   `subscriptionId` and `requestId` on this wire is a control-plane-generated
 *   id, unique per relay, so responses cannot be confused across browsers.
 * - **Browser wire.** The admin log WebSocket carries the requests in
 *   `AdminLogsClientFrame` and the relayed results in `AdminLogsServerFrame`.
 *   The control plane rewrites the ids back to the browser's own ids and never
 *   forwards an agent id to the browser.
 *
 * Cursor and range semantics follow the retained-buffer model in the agent
 * (`server-agent/src/logs/`): a record is identified by `(generation, seq)`,
 * sequence numbers start at 1 within a generation, and eviction reports a gap
 * instead of skipping records silently. A `generation` is a random 64-bit
 * value, so it travels as a decimal string: JavaScript numbers cannot carry it
 * exactly.
 *
 * Capabilities gate every message. An agent that does not advertise a
 * capability is never sent its messages, and the control plane refuses the
 * relay before the upgrade.
 */

/** Live tail: `logs.subscribe`, `logs.unsubscribe`, `logs.batch`, `logs.gap`. */
export const AGENT_WS_V2_LOGS_TAIL_CAPABILITY = "logs-tail-v1" as const;
/** Retained search and context: `logs.search*`, `logs.context*`. */
export const AGENT_WS_V2_LOGS_SEARCH_CAPABILITY = "logs-search-v1" as const;

/**
 * Bounds enforced on both sides. The record text limit matches the agent's
 * per-record cap (4096 bytes), and a JavaScript string never holds more UTF-16
 * units than that cap has UTF-8 bytes, so the character limit is a safe bound.
 */
export const AGENT_WS_V2_LOGS_LIMITS = {
  /**
   * Records in one `logs.batch` and the largest tail `limit`. A worst-case
   * record serializes to about 8.5 KiB (4096 text bytes, each escaped), so 200
   * records stay well under the 4 MiB frame limit, which 500 would not.
   */
  batchMaxRecords: 200,
  subscribeDefaultRecords: 200,
  recordMaxTextChars: 4096,
  searchQueryMaxChars: 256,
  searchPageMax: 100,
  contextMaxLines: 50,
  /** Searches in flight per browser relay. */
  searchConcurrentPerRelay: 2,
  /** Context lookups in flight per browser relay. */
  contextConcurrentPerRelay: 4,
  /** Largest browser frame the control plane accepts. */
  browserFrameMaxBytes: 64 * 1024,
} as const;

export const AGENT_WS_V2_LOGS_SOURCES = ["agent", "sing-box"] as const;
export const AGENT_WS_V2_LOGS_LEVELS = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
] as const;

/** Agent-side gap reasons, as the retained buffer reports them. */
export const AGENT_WS_V2_LOG_GAP_REASONS = [
  "restarted",
  "overwritten",
] as const;
/** Browser-side gaps also cover records the control plane dropped for a slow browser. */
export const AGENT_WS_V2_LOG_BROWSER_GAP_REASONS = [
  ...AGENT_WS_V2_LOG_GAP_REASONS,
  "dropped",
] as const;

/** Errors an agent reports. `restarted`/`overwritten` mirror the context lookup. */
export const AGENT_WS_V2_LOG_AGENT_ERROR_CODES = [
  "invalid_request",
  "unsupported",
  "busy",
  "restarted",
  "overwritten",
  "not_found",
  "unavailable",
] as const;

/** Errors a browser can receive. The control plane adds its own relay states. */
export const AGENT_WS_V2_LOG_BROWSER_ERROR_CODES = [
  ...AGENT_WS_V2_LOG_AGENT_ERROR_CODES,
  "offline",
  "timeout",
  "forbidden",
  "server_disabled",
  "session_replaced",
] as const;

export type AgentWsV2LogSource = (typeof AGENT_WS_V2_LOGS_SOURCES)[number];
export type AgentWsV2LogLevel = (typeof AGENT_WS_V2_LOGS_LEVELS)[number];
export type AgentWsV2LogBrowserErrorCode =
  (typeof AGENT_WS_V2_LOG_BROWSER_ERROR_CODES)[number];

export const AGENT_WS_V2_LOGS_AGENT_MESSAGE_TYPES = [
  "logs.batch",
  "logs.gap",
  "logs.search.result",
  "logs.context.result",
  "logs.error",
] as const;

export const AGENT_WS_V2_LOGS_CONTROL_MESSAGE_TYPES = [
  "logs.subscribe",
  "logs.unsubscribe",
  "logs.search",
  "logs.search.cancel",
  "logs.context",
] as const;

export const AGENT_WS_V2_LOGS_BROWSER_CLIENT_TYPES = [
  "logs.subscribe",
  "logs.unsubscribe",
  "logs.search",
  "logs.search.cancel",
  "logs.context",
] as const;

export const AGENT_WS_V2_LOGS_BROWSER_SERVER_TYPES = [
  "logs.batch",
  "logs.gap",
  "logs.search.result",
  "logs.context.result",
  "logs.error",
] as const;

export type AgentWsV2LogsBrowserClientType =
  (typeof AGENT_WS_V2_LOGS_BROWSER_CLIENT_TYPES)[number];
export type AgentWsV2LogsBrowserServerType =
  (typeof AGENT_WS_V2_LOGS_BROWSER_SERVER_TYPES)[number];

const MAX_SAFE_SEQ = Number.MAX_SAFE_INTEGER;
const MAX_U64 = (1n << 64n) - 1n;

/** Client ids (subscription and request) and control-plane ids share one charset. */
export const agentWsV2LogIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._:-]+$/);

/** A decimal u64 string. JavaScript numbers cannot carry the full range. */
export const agentWsV2LogGenerationSchema = z
  .string()
  .regex(/^[0-9]{1,20}$/)
  .refine((value) => BigInt(value) <= MAX_U64, {
    message: "generation exceeds 64 bits",
  });

const seqSchema = z.number().int().min(0).max(MAX_SAFE_SEQ);
const timestampSchema = z.iso.datetime();

export const agentWsV2LogSourceSchema = z.enum(AGENT_WS_V2_LOGS_SOURCES);
export const agentWsV2LogLevelSchema = z.enum(AGENT_WS_V2_LOGS_LEVELS);

/** A tail position: the last sequence delivered from one buffer generation. */
export const agentWsV2LogCursorSchema = z.object({
  generation: agentWsV2LogGenerationSchema,
  seq: seqSchema,
});

export type AgentWsV2LogCursor = z.infer<typeof agentWsV2LogCursorSchema>;

/**
 * A search continuation. `before` is exclusive and walks newest to oldest.
 * `pinnedSeq` and `floor` are fixed when the search starts, so eviction past
 * `floor` below `before` shows up as a gap instead of as silent loss.
 */
export const agentWsV2LogSearchCursorSchema = z.object({
  generation: agentWsV2LogGenerationSchema,
  pinnedSeq: seqSchema,
  before: seqSchema,
  floor: seqSchema,
});

export type AgentWsV2LogSearchCursor = z.infer<
  typeof agentWsV2LogSearchCursorSchema
>;

export const agentWsV2LogRecordSchema = z.object({
  seq: seqSchema.refine((seq) => seq >= 1, {
    message: "record sequence numbers start at 1",
  }),
  time: timestampSchema,
  source: agentWsV2LogSourceSchema,
  level: agentWsV2LogLevelSchema,
  processGeneration: z.number().int().min(0).max(MAX_SAFE_SEQ),
  text: z.string().max(AGENT_WS_V2_LOGS_LIMITS.recordMaxTextChars),
  truncated: z.boolean(),
});

export type AgentWsV2LogRecord = z.infer<typeof agentWsV2LogRecordSchema>;

export const agentWsV2LogFilterSchema = z.object({
  source: agentWsV2LogSourceSchema.optional(),
  /** Minimum severity, inclusive. */
  minLevel: agentWsV2LogLevelSchema.optional(),
});

/**
 * A search request. `text` is case-insensitive ASCII literal matching, not a
 * pattern. `since` is inclusive and `until` exclusive, matching the agent.
 */
export const agentWsV2LogQuerySchema = z
  .object({
    text: z
      .string()
      .min(1)
      .refine(
        (text) =>
          [...text].length <= AGENT_WS_V2_LOGS_LIMITS.searchQueryMaxChars,
        {
          message: `search text exceeds ${AGENT_WS_V2_LOGS_LIMITS.searchQueryMaxChars} characters`,
        },
      )
      .optional(),
    source: agentWsV2LogSourceSchema.optional(),
    minLevel: agentWsV2LogLevelSchema.optional(),
    since: timestampSchema.optional(),
    until: timestampSchema.optional(),
  })
  .refine(
    (query) =>
      query.since === undefined ||
      query.until === undefined ||
      Date.parse(query.since) < Date.parse(query.until),
    { message: "since must precede until" },
  );

export type AgentWsV2LogQuery = z.infer<typeof agentWsV2LogQuerySchema>;

const searchLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(AGENT_WS_V2_LOGS_LIMITS.searchPageMax);
const tailLimitSchema = z
  .number()
  .int()
  .min(1)
  .max(AGENT_WS_V2_LOGS_LIMITS.batchMaxRecords);
const contextLinesSchema = z
  .number()
  .int()
  .min(0)
  .max(AGENT_WS_V2_LOGS_LIMITS.contextMaxLines);

/** A reported gap. A restart has no sequence range, so both bounds are zero. */
export const agentWsV2LogGapSchema = z
  .object({
    reason: z.enum(AGENT_WS_V2_LOG_GAP_REASONS),
    fromSeq: seqSchema,
    toSeq: seqSchema,
  })
  .superRefine((gap, context) => {
    if (gap.reason === "restarted") {
      if (gap.fromSeq !== 0 || gap.toSeq !== 0) {
        context.addIssue({
          code: "custom",
          message: "a restart gap carries no sequence range",
        });
      }
      return;
    }
    if (gap.fromSeq < 1 || gap.toSeq < gap.fromSeq) {
      context.addIssue({
        code: "custom",
        message: "a gap range runs from at least 1 to its end",
      });
    }
  });

export type AgentWsV2LogGap = z.infer<typeof agentWsV2LogGapSchema>;

export const agentWsV2LogCoverageSchema = z.object({
  gap: z.enum(AGENT_WS_V2_LOG_GAP_REASONS).nullable(),
  searchableFrom: timestampSchema.nullable(),
  searchableTo: timestampSchema.nullable(),
});

export type AgentWsV2LogCoverage = z.infer<typeof agentWsV2LogCoverageSchema>;

const tailBatchShape = {
  subscriptionId: agentWsV2LogIdSchema,
  next: agentWsV2LogCursorSchema,
  hasMore: z.boolean(),
  records: z
    .array(agentWsV2LogRecordSchema)
    .max(AGENT_WS_V2_LOGS_LIMITS.batchMaxRecords),
};

const searchResultShape = {
  requestId: agentWsV2LogIdSchema,
  generation: agentWsV2LogGenerationSchema,
  pinnedSeq: seqSchema,
  matches: z
    .array(agentWsV2LogRecordSchema)
    .max(AGENT_WS_V2_LOGS_LIMITS.searchPageMax),
  next: agentWsV2LogSearchCursorSchema.nullable(),
  coverage: agentWsV2LogCoverageSchema,
};

const contextResultShape = {
  requestId: agentWsV2LogIdSchema,
  generation: agentWsV2LogGenerationSchema,
  target: agentWsV2LogRecordSchema,
  before: z
    .array(agentWsV2LogRecordSchema)
    .max(AGENT_WS_V2_LOGS_LIMITS.contextMaxLines),
  after: z
    .array(agentWsV2LogRecordSchema)
    .max(AGENT_WS_V2_LOGS_LIMITS.contextMaxLines),
};

/** Shared by agent and browser errors: one id names the request it answers. */
function errorShape<Code extends readonly [string, ...string[]]>(codes: Code) {
  return z
    .object({
      code: z.enum(codes),
      subscriptionId: agentWsV2LogIdSchema.optional(),
      requestId: agentWsV2LogIdSchema.optional(),
      message: z.string().min(1).max(1024),
    })
    .refine(
      (error) =>
        (error.subscriptionId === undefined) !==
        (error.requestId === undefined),
      { message: "an error names exactly one subscriptionId or requestId" },
    );
}

// ---------------------------------------------------------------------------
// Agent wire: control plane -> agent requests.
// ---------------------------------------------------------------------------

/** `logs.subscribe`. `resume: null` starts from the newest `limit` records. */
export const agentWsV2LogsSubscribePayloadSchema = z.object({
  subscriptionId: agentWsV2LogIdSchema,
  filter: agentWsV2LogFilterSchema,
  resume: agentWsV2LogCursorSchema.nullable(),
  limit: tailLimitSchema,
});

export const agentWsV2LogsUnsubscribePayloadSchema = z.object({
  subscriptionId: agentWsV2LogIdSchema,
});

/** `logs.search`. `cursor: null` starts a new search pinned at the newest record. */
export const agentWsV2LogsSearchPayloadSchema = z.object({
  requestId: agentWsV2LogIdSchema,
  query: agentWsV2LogQuerySchema,
  cursor: agentWsV2LogSearchCursorSchema.nullable(),
  limit: searchLimitSchema,
});

export const agentWsV2LogsSearchCancelPayloadSchema = z.object({
  requestId: agentWsV2LogIdSchema,
});

export const agentWsV2LogsContextPayloadSchema = z.object({
  requestId: agentWsV2LogIdSchema,
  generation: agentWsV2LogGenerationSchema,
  seq: seqSchema.refine((seq) => seq >= 1, {
    message: "record sequence numbers start at 1",
  }),
  before: contextLinesSchema,
  after: contextLinesSchema,
});

// ---------------------------------------------------------------------------
// Agent wire: agent -> control plane results.
// ---------------------------------------------------------------------------

/** `logs.batch`. `next` is the position after the last record the agent scanned. */
export const agentWsV2LogsBatchPayloadSchema = z.object(tailBatchShape);

/** `logs.gap` names a range the subscription can no longer read. */
export const agentWsV2LogsGapPayloadSchema = z.object({
  subscriptionId: agentWsV2LogIdSchema,
  generation: agentWsV2LogGenerationSchema,
  gap: agentWsV2LogGapSchema,
});

export const agentWsV2LogsSearchResultPayloadSchema =
  z.object(searchResultShape);

export const agentWsV2LogsContextResultPayloadSchema =
  z.object(contextResultShape);

export const agentWsV2LogsErrorPayloadSchema = errorShape(
  AGENT_WS_V2_LOG_AGENT_ERROR_CODES,
);

// ---------------------------------------------------------------------------
// Browser wire (admin log WebSocket).
// ---------------------------------------------------------------------------

const browserErrorCodes = AGENT_WS_V2_LOG_BROWSER_ERROR_CODES;

/** Browser -> control plane. Browser ids are client-chosen and scoped to one socket. */
export const adminLogsClientPayloadSchemas = {
  "logs.subscribe": agentWsV2LogsSubscribePayloadSchema,
  "logs.unsubscribe": agentWsV2LogsUnsubscribePayloadSchema,
  "logs.search": agentWsV2LogsSearchPayloadSchema,
  "logs.search.cancel": agentWsV2LogsSearchCancelPayloadSchema,
  "logs.context": agentWsV2LogsContextPayloadSchema,
} as const satisfies Record<AgentWsV2LogsBrowserClientType, z.ZodType>;

/** Control plane -> browser. Ids are the browser's own, never agent ids. */
export const adminLogsServerPayloadSchemas = {
  "logs.batch": z.object(tailBatchShape),
  "logs.gap": z.object({
    subscriptionId: agentWsV2LogIdSchema,
    generation: agentWsV2LogGenerationSchema,
    gap: agentWsV2LogGapSchema.or(
      z
        .object({
          reason: z.literal("dropped"),
          fromSeq: seqSchema.refine((seq) => seq >= 1, {
            message: "a dropped range starts at 1",
          }),
          toSeq: seqSchema,
        })
        .refine((gap) => gap.toSeq >= gap.fromSeq, {
          message: "a gap range runs from at least 1 to its end",
        }),
    ),
  }),
  "logs.search.result": z.object(searchResultShape),
  "logs.context.result": z.object(contextResultShape),
  "logs.error": errorShape(browserErrorCodes),
} as const satisfies Record<AgentWsV2LogsBrowserServerType, z.ZodType>;

export type AdminLogsClientType = keyof typeof adminLogsClientPayloadSchemas;
export type AdminLogsServerType = keyof typeof adminLogsServerPayloadSchemas;

/** The payloads that every surface shares, for typed fixtures and tests. */
export const agentWsV2LogsPayloadSchemas = {
  "logs.subscribe": agentWsV2LogsSubscribePayloadSchema,
  "logs.unsubscribe": agentWsV2LogsUnsubscribePayloadSchema,
  "logs.search": agentWsV2LogsSearchPayloadSchema,
  "logs.search.cancel": agentWsV2LogsSearchCancelPayloadSchema,
  "logs.context": agentWsV2LogsContextPayloadSchema,
  "logs.batch": agentWsV2LogsBatchPayloadSchema,
  "logs.gap": agentWsV2LogsGapPayloadSchema,
  "logs.search.result": agentWsV2LogsSearchResultPayloadSchema,
  "logs.context.result": agentWsV2LogsContextResultPayloadSchema,
  "logs.error": agentWsV2LogsErrorPayloadSchema,
} as const;

export type AgentWsV2LogsPayloadOf<
  T extends keyof typeof agentWsV2LogsPayloadSchemas,
> = z.infer<(typeof agentWsV2LogsPayloadSchemas)[T]>;

export const adminLogsFrameEnvelopeSchema = z.object({
  v: z.literal(2),
  id: agentWsV2LogIdSchema.optional(),
  type: z.string().min(1).max(128),
  ts: timestampSchema,
  payload: z.unknown(),
});

export type AdminLogsClientFrame = {
  [K in AdminLogsClientType]: {
    type: K;
    payload: z.infer<(typeof adminLogsClientPayloadSchemas)[K]>;
  };
}[AdminLogsClientType];

export type AdminLogsParseErrorCode =
  | "frame-too-large"
  | "invalid-json"
  | "invalid-envelope"
  | "unsupported-version"
  | "unknown-type"
  | "invalid-payload";

export type AdminLogsParseResult =
  | { ok: true; frame: AdminLogsClientFrame }
  | { ok: false; code: AdminLogsParseErrorCode; type?: string };

/**
 * Decodes one browser text frame. The browser may send only the request types
 * in `adminLogsClientPayloadSchemas`; any other known or unknown type is
 * rejected, because the browser has no reason to send a result.
 */
export function parseAdminLogsClientFrame(
  text: string,
  options: { maxFrameBytes?: number } = {},
): AdminLogsParseResult {
  const maxFrameBytes =
    options.maxFrameBytes ?? AGENT_WS_V2_LOGS_LIMITS.browserFrameMaxBytes;
  if (new TextEncoder().encode(text).byteLength > maxFrameBytes) {
    return { ok: false, code: "frame-too-large" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-json" };
  }
  const envelope = adminLogsFrameEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const version =
      typeof raw === "object" && raw !== null && "v" in raw
        ? (raw as { v?: unknown }).v
        : undefined;
    return version !== undefined && version !== 2
      ? { ok: false, code: "unsupported-version" }
      : { ok: false, code: "invalid-envelope" };
  }
  const type = envelope.data.type;
  if (!isClientType(type)) {
    return { ok: false, code: "unknown-type", type };
  }
  const payload = adminLogsClientPayloadSchemas[type].safeParse(
    envelope.data.payload,
  );
  if (!payload.success) {
    return { ok: false, code: "invalid-payload", type };
  }
  return {
    ok: true,
    frame: { type, payload: payload.data } as AdminLogsClientFrame,
  };
}

export type AdminLogsServerFrame = {
  [K in AdminLogsServerType]: {
    type: K;
    payload: z.infer<(typeof adminLogsServerPayloadSchemas)[K]>;
  };
}[AdminLogsServerType];

export type AdminLogsServerParseResult =
  | { ok: true; frame: AdminLogsServerFrame }
  | { ok: false; code: AdminLogsParseErrorCode; type?: string };

/**
 * Decodes one control-plane text frame for the browser. Only the result types
 * in `adminLogsServerPayloadSchemas` are valid; a request type is rejected.
 */
export function parseAdminLogsServerFrame(
  text: string,
  options: { maxFrameBytes?: number } = {},
): AdminLogsServerParseResult {
  const maxFrameBytes =
    options.maxFrameBytes ?? AGENT_WS_V2_LOGS_LIMITS.browserFrameMaxBytes;
  if (new TextEncoder().encode(text).byteLength > maxFrameBytes) {
    return { ok: false, code: "frame-too-large" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid-json" };
  }
  const envelope = adminLogsFrameEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    const version =
      typeof raw === "object" && raw !== null && "v" in raw
        ? (raw as { v?: unknown }).v
        : undefined;
    return version !== undefined && version !== 2
      ? { ok: false, code: "unsupported-version" }
      : { ok: false, code: "invalid-envelope" };
  }
  const type = envelope.data.type;
  if (!isServerType(type)) {
    return { ok: false, code: "unknown-type", type };
  }
  const payload = adminLogsServerPayloadSchemas[type].safeParse(
    envelope.data.payload,
  );
  if (!payload.success) {
    return { ok: false, code: "invalid-payload", type };
  }
  return {
    ok: true,
    frame: { type, payload: payload.data } as AdminLogsServerFrame,
  };
}

function isClientType(type: string): type is AdminLogsClientType {
  return (AGENT_WS_V2_LOGS_BROWSER_CLIENT_TYPES as readonly string[]).includes(
    type,
  );
}

function isServerType(type: string): type is AdminLogsServerType {
  return (AGENT_WS_V2_LOGS_BROWSER_SERVER_TYPES as readonly string[]).includes(
    type,
  );
}
