/**
 * Desired/applied revision codec.
 *
 * The agent treats `desiredRevision` as an opaque string: it only compares for
 * equality and byte-compares the config content. The control plane exploits
 * that to smuggle a per-server monotonic sequence in front of the content
 * hash: `"<seq>:sha256:<hex>"`. The sequence drives the subscription publish
 * gate (`@/lib/publish-gate`); the hash keeps content-addressed debugging and
 * guards against a missed `desiredRevisionSeq` bump.
 *
 * Legacy revisions ("sha256:<hex>" without a numeric prefix) parse to `null`
 * so heartbeats from agents that applied a pre-versioning revision never move
 * `server.appliedRevisionSeq` backwards or crash the parser.
 */

export function formatDesiredRevision(
  seq: number,
  contentHash: string,
): string {
  return `${seq}:${contentHash}`;
}

/** Extracts the leading sequence, or null for legacy/unparseable revisions. */
export function parseRevisionSeq(
  revision: string | null | undefined,
): number | null {
  if (!revision) {
    return null;
  }
  const match = /^(\d+):/.exec(revision);
  if (!match) {
    return null;
  }
  const seq = Number.parseInt(match[1]!, 10);
  return Number.isSafeInteger(seq) ? seq : null;
}
