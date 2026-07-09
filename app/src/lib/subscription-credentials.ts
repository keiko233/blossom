import { randomBytes, randomUUID } from "node:crypto";

/**
 * Per-subscription proxy credentials embedded into node configs as sing-box
 * inbound users. Both fields are always generated because a subscription can
 * span nodes of mixed protocols: `uuid` serves vless/vmess/tuic, `password`
 * serves trojan/shadowsocks/hysteria2/... (see `@/orpc/proxy/singbox-users`).
 *
 * Stored in plaintext — sing-box needs the raw secret on every config compile,
 * unlike agent tokens which are hash-matched once per request.
 */
export interface SubscriptionCredentials {
  uuid: string;
  /** base64 of 32 random bytes — doubles as an SS2022 256-bit key. */
  password: string;
}

export function generateSubscriptionCredentials(): SubscriptionCredentials {
  return {
    uuid: randomUUID(),
    password: randomBytes(32).toString("base64"),
  };
}

/** 32 hex chars (128-bit): URL-safe, matches the migration backfill format. */
export function generateSubscriptionToken(): string {
  return randomBytes(16).toString("hex");
}
