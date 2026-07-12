/**
 * Codec for the inbound user identifier the Rust agent reports back via the
 * `v2ray_api` stats counter `user>>>{name}>>>traffic>>>uplink|downlink`.
 *
 * Sing-box user names need to map back to a subscription (and, under the
 * multi-inbound server model, also to a node) for traffic reporting to be
 * precise. With multi-inbound servers a name that only carries the
 * subscription id is no longer enough: the same subscription appears in every
 * inbound (node) on a server, and sing-box reports one counter per `name`
 * across the whole stats namespace. We therefore encode both the producing
 * node and the subscription into the inbound user `name`.
 *
 * The format is versioned and length-prefixed so it can carry nodeId /
 * subscriptionId strings without relying on a delimiter that might appear
 * inside either id. The legacy format — a bare subscription id — is still
 * accepted on ingest for backward compatibility (agents running an older
 * control plane still produced single-inbound configs with the bare id).
 *
 * The codec itself is pure and side-effect free; it has no knowledge of the
 * database or the sing-box schema, making it trivially unit-testable.
 *
 * Wire format (ASCII):
 *   `blz.1.{l1}.{l2}.{payload}`
 *     `blz.1.`       — version tag v1; chosen so it cannot collide with the
 *                       bare UUIDs used for subscription ids in the legacy
 *                       format
 *     `{l1}`         — decimal length, in JS UTF-16 code units, of the node id
 *     `.`            — separator between length fields (digits only on both
 *                       sides, so this `.` is unambiguous within the length
 *                       header)
 *     `{l2}`         — decimal length, in JS UTF-16 code units, of the
 *                       subscription id
 *     `.`            — separator before the payload
 *     `{payload}`    — node id concatenated with subscription id, taken
 *                       verbatim; the lengths above define the split
 *
 * The lengths are measured in JS UTF-16 code units (i.e. `String.prototype
 * .length`), not bytes. That is the unit the round-trip uses consistently, and
 * all ids in this system are arbitrary ASCII-ish strings (UUIDs, random-url
 * base64), so code-unit and byte length coincide in practice; but the codec
 * does not depend on that equivalence. A substring that legitimately contains
 * the `.` separator (or even the version tag `blz.1.`) inside an id is still
 * safe because the length header tells the decoder where to split — not the
 * separator.
 *
 * Examples:
 *   encode("n1", "sub1") -> "blz.1.2.4.n1sub1"
 *   encode("", "sub1")   -> "blz.1.0.4.sub1"
 */

export const CODEC_VERSION_TAG = "blz.1.";

export interface DecodedUserIdentifier {
  nodeId: string;
  subscriptionId: string;
}

/**
 * Encodes a (nodeId, subscriptionId) pair into the wire format described
 * above. Both inputs may be empty strings. The output is suitable as a
 * sing-box inbound user `name`.
 */
export function encodeTrafficUser(
  nodeId: string,
  subscriptionId: string,
): string {
  return `${CODEC_VERSION_TAG}${nodeId.length}.${subscriptionId.length}.${nodeId}${subscriptionId}`;
}

/**
 * Decodes a stats counter `name`. Returns `null` when the input does not match
 * the versioned format, in which case callers should treat the input as a
 * legacy bare subscription id. Otherwise returns the split ids; the lengths
 * are validated against the actual payload length so a malformed input is
 * rejected rather than misparsed.
 */
export function decodeTrafficUser(raw: string): DecodedUserIdentifier | null {
  if (!raw.startsWith(CODEC_VERSION_TAG)) {
    return null;
  }
  const rest = raw.slice(CODEC_VERSION_TAG.length);

  // l1 digits terminated by the first '.'
  const firstDot = rest.indexOf(".");
  if (firstDot <= 0) {
    return null;
  }
  const l1 = readDecimal(rest.slice(0, firstDot));
  if (l1 === null) {
    return null;
  }

  // l2 digits terminated by the next '.'
  const afterFirst = rest.slice(firstDot + 1);
  const secondDot = afterFirst.indexOf(".");
  if (secondDot <= 0) {
    return null;
  }
  const l2 = readDecimal(afterFirst.slice(0, secondDot));
  if (l2 === null) {
    return null;
  }

  const payload = afterFirst.slice(secondDot + 1);
  if (payload.length !== l1 + l2) {
    return null;
  }
  const nodeId = payload.slice(0, l1);
  const subscriptionId = payload.slice(l1, l1 + l2);
  return { nodeId, subscriptionId };
}

/**
 * Resolved attribution for a traffic entry reported by an agent, accounting
 * for both the versioned coded format and the legacy bare subscription id
 * format. `nodeId` is filled only when the producing node can be unambiguously
 * identified and verified; `null` otherwise. `subscriptionId` is the real
 * subscription id (after decoding) — it is what quota accounting keys on.
 */
export interface ResolvedReportedUser {
  subscriptionId: string;
  /** Verified node id or null when attribution is impossible / unsafe. */
  nodeId: string | null;
}

/**
 * Resolves a raw reported `subscriptionId` field (which is actually the inbound
 * user identifier — coded or legacy) into a (subscriptionId, nodeId) pair
 * suitable for `traffic_record` insertion.
 *
 *  - Coded format: `subscriptionId` is the decoded subscription id. `nodeId`
 *    is the decoded node id when it still belongs to this server (i.e. is in
 *    `serverNodeIds`); otherwise `null` (the node was moved or deleted, its
 *    stats linger on the agent — drop attribution but keep the subscription
 *    accounting).
 *  - Legacy bare subscription id: `subscriptionId` is the raw input.
 *    `nodeId` is the only id in `serverNodeIds` when that set has exactly one
 *    member (unambiguous attribution); when the server has zero or several
 *    nodes, attribution is impossible and `nodeId` is `null` while the
 *    subscription is still credited.
 *
 * `serverNodeIds` should be the set of node ids currently owned by the
 * reporting server — caller resolves it once per request.
 */
export function resolveReportedTrafficUser(
  raw: string,
  serverNodeIds: Set<string>,
): ResolvedReportedUser {
  const decoded = decodeTrafficUser(raw);
  if (decoded) {
    return {
      subscriptionId: decoded.subscriptionId,
      nodeId:
        decoded.nodeId.length > 0 && serverNodeIds.has(decoded.nodeId)
          ? decoded.nodeId
          : null,
    };
  }
  if (serverNodeIds.size === 1) {
    return {
      subscriptionId: raw,
      nodeId: [...serverNodeIds][0]!,
    };
  }
  return { subscriptionId: raw, nodeId: null };
}

/** Read a non-negative decimal integer of any digit length; reject non-digits. */
function readDecimal(s: string): number | null {
  if (
    s.length === 0 ||
    // bigger than JS safe-int is irrelevant here; ids are short. Still bail so
    // a hostile input cannot overflow the Number cast.
    s.length > 9
  ) {
    return null;
  }
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 48 || code > 57) {
      return null;
    }
  }
  return Number.parseInt(s, 10);
}
