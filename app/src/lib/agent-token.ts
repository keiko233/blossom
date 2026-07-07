import { createHash, randomBytes } from "node:crypto";

/**
 * Per-node agent credentials. A node's token is the only thing an agent presents,
 * and it resolves to exactly one node — so a node can only ever read its own config
 * and heartbeat itself (least privilege). Only the hash is persisted; the plaintext
 * is shown once at create/reset time.
 */

const TOKEN_PREFIX = "agt_";

export interface GeneratedAgentToken {
  /** Plaintext token — return to the admin once, never stored. */
  token: string;
  /** SHA-256 hex digest stored in the DB and matched on each agent request. */
  hash: string;
  /** Short, non-secret identifier kept for display (e.g. "agt_1a2b3c4d"). */
  prefix: string;
}

export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateAgentToken(): GeneratedAgentToken {
  const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
  return {
    token,
    hash: hashAgentToken(token),
    prefix: token.slice(0, TOKEN_PREFIX.length + 8),
  };
}

/** Extracts the bearer token from an Authorization header value, if present. */
export function parseBearerToken(
  authorization: string | null | undefined,
): string | undefined {
  if (!authorization) {
    return undefined;
  }
  return authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : authorization.trim();
}
