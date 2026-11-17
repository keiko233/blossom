import { INBOUND_BY_TYPE } from "@/orpc/proxy/sing-box-registry";

/**
 * Truthful capability model for per-user traffic accounting and device limits.
 * Pure and read-only: it describes what the current compiler and agent do, and
 * changes neither authorization nor quota semantics.
 *
 * Per-user accounting comes from the agent's sing-box connection stream
 * (`StartedService.SubscribeConnections`), whose `user` field is the inbound
 * user identifier. `buildInboundUser` gives name-keyed protocols a coded node +
 * subscription identifier and username-keyed protocols (naive/socks/http/mixed)
 * the bare subscription id. Both reach the subscription quota; username-keyed
 * traffic loses per-node attribution because the identifier carries no node.
 * The classification below reads the same registry shape instead of keeping a
 * protocol-name table, and `traffic-capabilities.test.ts` checks it against the
 * real compiler output.
 *
 * Three states, deliberately not collapsed:
 *  - `accounted`   per-user counters are produced for this configuration.
 *  - `unaccounted` known to produce no per-user counters; usage on this node
 *                  is not charged to the subscription quota.
 *  - `unknown`     the registry or the configuration does not let us say. Never
 *                  treat this as safe: warn exactly as for `unaccounted`.
 */

export type AccountingStatus = "accounted" | "unaccounted" | "unknown";

export type AccountingReason =
  /** The inbound user has a coded `name` (node + subscription). */
  | "name-keyed-user"
  /** The inbound user is keyed by `username`; quota works, per-node does not. */
  | "username-keyed-user"
  /** The protocol is not an inbound type of the sing-box schema we compile. */
  | "unregistered-protocol"
  /** The registry knows the protocol but it has no `users` model. */
  | "no-user-model"
  /**
   * The inbound only fronts another one (ShadowTLS hands the connection to its
   * `detour`), so which inbound's user the traffic is attributed to is not
   * something the registry can tell. Not verified against a sing-box binary.
   */
  | "front-end-protocol"
  /**
   * Shadowsocks in relay (`destinations`) or `managed` mode does not use the
   * embedded multi-user list the way the compiler assumes. Not verified
   * against a sing-box binary.
   */
  | "non-multi-user-mode";

export interface NodeAccountingInput {
  protocol: string;
  settings?: Record<string, unknown> | null;
}

export interface NodeAccounting {
  status: AccountingStatus;
  reason: AccountingReason;
}

const FRONT_END_PROTOCOLS: ReadonlySet<string> = new Set(["shadowtls"]);

// Zod internals are reached the same loosely-typed way as in `singbox-users`.
interface ZodDefLike {
  shape?: Record<string, unknown>;
  innerType?: ZodTypeLike;
  element?: ZodTypeLike;
}

interface ZodTypeLike {
  def: ZodDefLike;
}

/** Field names of the protocol's `users` element, or null if it has none. */
function usersElementFields(protocol: string): readonly string[] | null {
  // `hasOwn`: a protocol string such as "constructor" must not resolve to an
  // `Object.prototype` member.
  if (!Object.hasOwn(INBOUND_BY_TYPE, protocol)) {
    return null;
  }
  const inbound = INBOUND_BY_TYPE[protocol] as unknown as ZodTypeLike;
  let users = inbound.def.shape?.users as ZodTypeLike | undefined;
  while (users?.def.innerType) {
    users = users.def.innerType;
  }
  const shape = users?.def.element?.def.shape;
  return shape ? Object.keys(shape) : null;
}

function isShadowsocksNonMultiUser(
  settings: Record<string, unknown> | null | undefined,
): boolean {
  if (!settings) {
    return false;
  }
  const { destinations, managed } = settings;
  return (
    managed === true || (Array.isArray(destinations) && destinations.length > 0)
  );
}

/**
 * Classifies one node. The protocol alone decides the common cases; settings
 * can only move a node to `unknown`, never make it look better than the
 * registry shape allows.
 */
export function classifyNodeAccounting(
  node: NodeAccountingInput,
): NodeAccounting {
  if (!Object.hasOwn(INBOUND_BY_TYPE, node.protocol)) {
    return { status: "unknown", reason: "unregistered-protocol" };
  }
  const fields = usersElementFields(node.protocol);
  if (!fields) {
    return { status: "unknown", reason: "no-user-model" };
  }
  if (FRONT_END_PROTOCOLS.has(node.protocol)) {
    return { status: "unknown", reason: "front-end-protocol" };
  }
  if (
    node.protocol === "shadowsocks" &&
    isShadowsocksNonMultiUser(node.settings)
  ) {
    return { status: "unknown", reason: "non-multi-user-mode" };
  }
  // Same precedence as `buildInboundUser`: `name` wins over `username`.
  if (fields.includes("name")) {
    return { status: "accounted", reason: "name-keyed-user" };
  }
  if (fields.includes("username")) {
    return { status: "accounted", reason: "username-keyed-user" };
  }
  return { status: "unknown", reason: "no-user-model" };
}

export interface AccountingSummary<T extends NodeAccountingInput> {
  accounted: T[];
  unaccounted: T[];
  unknown: T[];
  /** Some selected node is known not to be accounted per user. */
  hasUnaccounted: boolean;
  /** Some selected node cannot be classified. */
  hasUnknown: boolean;
  /**
   * Drives the warning: true for unaccounted OR unknown nodes, because an
   * unknown node must not be presented as safe. False for an empty selection
   * (nothing to warn about) and when every node is accounted.
   */
  shouldWarnQuotaIncomplete: boolean;
  /**
   * True only for a non-empty selection that is fully accounted. This is the
   * sole case in which "usage is counted against the quota" may be said
   * without qualification. Even then enforcement is not immediate: agents
   * report deltas, and an exhausted subscription is only dropped from the
   * compiled config (`getNodeActiveSubscriptions`) on the agent's next pull.
   */
  isFullyAccounted: boolean;
}

/** Groups a node selection by accounting status and derives the warning flags. */
export function summarizeAccounting<T extends NodeAccountingInput>(
  nodes: readonly T[],
): AccountingSummary<T> {
  const accounted: T[] = [];
  const unaccounted: T[] = [];
  const unknown: T[] = [];
  for (const node of nodes) {
    const { status } = classifyNodeAccounting(node);
    (status === "accounted"
      ? accounted
      : status === "unaccounted"
        ? unaccounted
        : unknown
    ).push(node);
  }
  return {
    accounted,
    unaccounted,
    unknown,
    hasUnaccounted: unaccounted.length > 0,
    hasUnknown: unknown.length > 0,
    shouldWarnQuotaIncomplete: unaccounted.length + unknown.length > 0,
    isFullyAccounted:
      nodes.length > 0 && unaccounted.length + unknown.length === 0,
  };
}

/**
 * Device limits are stored (`plan.deviceLimit`, copied to the subscription) and
 * never read by any enforcement path: the compiler, agent API and Rust agent
 * have no device identity. Typed as the literal `false` so a later change that
 * adds enforcement has to update this model and its tests.
 */
export const DEVICE_LIMIT_ENFORCED = false as const;

export type DeviceLimitState =
  /** 0: no limit is stored, so nothing is promised. */
  | "unlimited"
  /** A positive integer is stored but is not enforced. */
  | "stored-not-enforced"
  /** Negative, fractional, non-finite or missing: do not read it as unlimited. */
  | "invalid";

export interface DeviceLimitCapability {
  state: DeviceLimitState;
  enforced: typeof DEVICE_LIMIT_ENFORCED;
  /** The stored value as given, or null when it is not a finite number. */
  storedLimit: number | null;
  /** Drives the "not enforced" notice wherever the limit is displayed. */
  shouldWarnNotEnforced: boolean;
}

/** Describes a stored device limit without altering or reinterpreting it. */
export function describeDeviceLimit(
  limit: number | null | undefined,
): DeviceLimitCapability {
  const storedLimit =
    typeof limit === "number" && Number.isFinite(limit) ? limit : null;
  const state: DeviceLimitState =
    storedLimit === null || storedLimit < 0 || !Number.isInteger(storedLimit)
      ? "invalid"
      : storedLimit === 0
        ? "unlimited"
        : "stored-not-enforced";
  return {
    state,
    enforced: DEVICE_LIMIT_ENFORCED,
    storedLimit,
    shouldWarnNotEnforced: state !== "unlimited",
  };
}
