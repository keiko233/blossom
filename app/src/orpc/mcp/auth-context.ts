export interface AuthInfo {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
  extra?: Record<string, unknown>;
}

interface AuthInfoExtra {
  authInfo?: AuthInfo;
}

export function getActorFromExtra(extra: unknown): {
  actorUserId: string;
  scopes: string[];
} {
  const authInfo = (extra as AuthInfoExtra).authInfo;
  if (!authInfo) throw new Error("missing auth");
  const actorUserId = (authInfo.extra?.sub as string) ?? "";
  if (!actorUserId) throw new Error("missing sub claim");
  const scopes = authInfo.scopes ?? [];
  if (!scopes.includes("blossom:mcp:read"))
    throw new Error("missing read scope");
  return { actorUserId, scopes };
}

const DOMAIN_MESSAGE_RE = new RegExp(
  [
    "^Not found",
    "^Forbidden",
    "^Cannot ban yourself",
    "^Cannot demote yourself",
    "^confirmation|confirm.*required",
    "^Server still has nodes",
    "^Path too long",
    "^Path traversal",
    "^Invalid path",
    "^Doc fetch failed",
    "^Unexpected content type",
    "^Response too large",
    "^Invalid key",
    "^Invalid payload",
    "^Invalid IV",
    "^Unsupported payload",
    "^missing ",
  ].join("|"),
  "i",
);

const MAX_SANITIZED_LENGTH = 512;

const SECRETS_RE =
  /([\w"]*(?:token|password|secret|authorization|api[_-]?key|credential)[\w"]*\s*[:=]\s*)[^\s,}"]+/gi;

export function sanitizeError(error: unknown): string {
  if (!(error instanceof Error)) return "Tool failed";
  let message = error.message.replace(SECRETS_RE, "$1<redacted>");
  message = message.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (message.length > MAX_SANITIZED_LENGTH) {
    message = message.slice(0, MAX_SANITIZED_LENGTH) + "...";
  }
  if (DOMAIN_MESSAGE_RE.test(message)) return message;
  return "Tool failed";
}
