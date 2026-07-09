import type { Subscription } from "@/db/plan-schema";
import type { Node } from "@/db/proxy-schema";

import { INBOUND_BY_TYPE } from "./sing-box-registry";
import type { SingboxUser } from "./singbox";

/**
 * Maps a subscription onto a sing-box inbound user for a given node. Which
 * credential fields the user object carries is introspected from the protocol's
 * schema (same philosophy as the registry: no hand-maintained per-protocol
 * table). The user's identifier is the subscription id, so v2ray_api traffic
 * stats map 1:1 back to a subscription.
 */

// Zod internals are reached the same loosely-typed way as in the registry.
interface ZodDefLike {
  shape?: Record<string, unknown>;
  innerType?: ZodTypeLike;
  element?: ZodTypeLike;
}

interface ZodTypeLike {
  def: ZodDefLike;
}

/** Shape of one element of the protocol's `users` array, or null if none. */
function usersElementShape(protocol: string): Record<string, unknown> | null {
  const inbound = INBOUND_BY_TYPE[protocol] as unknown as
    | ZodTypeLike
    | undefined;
  let users = inbound?.def.shape?.users as ZodTypeLike | undefined;
  if (!users) {
    return null;
  }
  // Unwrap optional/default wrappers around the array.
  while (users.def.innerType) {
    users = users.def.innerType;
  }
  const element = users.def.element;
  return element?.def.shape ?? null;
}

/** Byte length of the base64-decoded stored password (44-char base64 = 32). */
function decodedKey(password: string): Buffer {
  return Buffer.from(password, "base64");
}

/**
 * Shadowsocks-2022 methods require the per-user key to be exactly the cipher's
 * key length. The stored credential is 32 random bytes in base64, which fits
 * the 256-bit methods as-is; the 128-bit method takes the first 16 bytes.
 * Classic methods (and every other password protocol) accept any string.
 */
export function passwordFor(node: Node, password: string): string {
  if (node.protocol !== "shadowsocks") {
    return password;
  }
  const method = node.settings.method;
  if (typeof method !== "string" || !method.startsWith("2022-")) {
    return password;
  }
  if (method === "2022-blake3-aes-128-gcm") {
    return decodedKey(password).subarray(0, 16).toString("base64");
  }
  return password;
}

/**
 * Builds the inbound user entry for a subscription on a node, or null when the
 * protocol has no users array (tun/redirect/... — not node protocols anyway).
 *
 * Field selection by shape:
 *  - `name` → subscription id (`username` for naive/socks/http, which have no
 *    `name`; those protocols also escape v2ray_api stats — known limitation)
 *  - `uuid` → credentialUuid (vless/vmess/tuic)
 *  - `password` → credentialPassword, SS2022 key-length adjusted (trojan/ss/
 *    hysteria2/anytls/shadowtls/tuic/naive/socks/http)
 *  - `auth_str` → credentialPassword (hysteria v1; base64 `auth` is skipped)
 *  - `flow` (vless) is deliberately not set — needs a node-level convention.
 */
export function buildInboundUser(
  node: Node,
  sub: Subscription,
): SingboxUser | null {
  const shape = usersElementShape(node.protocol);
  if (!shape) {
    return null;
  }

  const user: SingboxUser = {};
  if ("name" in shape) {
    user.name = sub.id;
  } else if ("username" in shape) {
    user.username = sub.id;
  }
  if ("uuid" in shape) {
    user.uuid = sub.credentialUuid;
  }
  if ("password" in shape) {
    user.password = passwordFor(node, sub.credentialPassword);
  }
  if ("auth_str" in shape) {
    user.auth_str = sub.credentialPassword;
  }
  return user;
}
