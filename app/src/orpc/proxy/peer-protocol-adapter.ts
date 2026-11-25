import { encodePeerLinkIdentity } from "@blossom/domain/link-identity";
import {
  isPeerProtocol,
  peerProtocolCapability,
  type PeerNetwork,
} from "@blossom/domain/managed-networking";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { isIP } from "node:net";

import {
  INBOUND_BY_TYPE,
  MANAGED_CERTIFICATE_MATERIAL_TLS_FIELDS,
  OUTBOUND_BY_TYPE,
} from "./sing-box-registry";

/**
 * Protocol adapter for inter-server peer links. Every shape is derived from
 * `@black-duty/sing-box-schema` through the registry; the adapter only adds the
 * managed tag/endpoint/credential fields and normalises protocol-specific
 * credential placement. The final document is still validated by
 * `Configuration.parse` in the managed compiler.
 */

type Json = Record<string, unknown>;

interface ZodSchemaLike {
  def: { shape: Record<string, unknown> };
  safeParse(
    value: unknown,
  ):
    | { success: true; data: unknown }
    | { success: false; error: { message: string } };
}

interface PeerInboundShape {
  protocol: string;
  runtimeTag: string;
  listenAddress: string;
  listenPort: number;
  network?: PeerNetwork;
  tlsServerName: string | null;
  certificateId: string | null;
  settings?: Record<string, unknown>;
}

interface PeerOutboundShape {
  runtimeTag: string;
  protocol: string;
  serverAddress: string;
  serverPort: number;
  tlsServerName: string | null;
  trustMode: "system" | "managed_certificate" | "none" | null;
  linkId: string | null;
  credentialGeneration: number | null;
  settings?: Record<string, unknown>;
}

const LINK_KEYED_PROTOCOLS = new Set(["socks", "naive"]);
const UUID_PASSWORD_PROTOCOLS = new Set(["tuic"]);
const AUTH_STR_PROTOCOLS = new Set(["hysteria"]);

function isObject(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Json | undefined {
  return isObject(value) ? value : undefined;
}

function cloneJson(value: Record<string, unknown>): Json {
  return structuredClone(value) as Json;
}

function inboundSchema(protocol: string): ZodSchemaLike | undefined {
  return INBOUND_BY_TYPE[protocol] as unknown as ZodSchemaLike | undefined;
}

function outboundSchema(protocol: string): ZodSchemaLike | undefined {
  return OUTBOUND_BY_TYPE[protocol] as unknown as ZodSchemaLike | undefined;
}

function schemaHasField(
  schema: ZodSchemaLike | undefined,
  field: string,
): boolean {
  return Boolean(schema && field in schema.def.shape);
}

/** Whether the protocol's inbound schema accepts a `network` listen field. */
export function peerInboundSupportsNetwork(protocol: string): boolean {
  return schemaHasField(inboundSchema(protocol), "network");
}

/** Whether the protocol's outbound schema accepts a `network` dial field. */
export function peerOutboundSupportsNetwork(protocol: string): boolean {
  return schemaHasField(outboundSchema(protocol), "network");
}

/** Whether the outbound schema accepts an explicit `domain_resolver` tag. */
export function outboundSupportsDomainResolver(protocol: string): boolean {
  return schemaHasField(outboundSchema(protocol), "domain_resolver");
}

function applyManagedNetwork(
  target: Json,
  network: PeerNetwork | undefined,
  supported: boolean,
): void {
  delete target.network;
  if (!supported || network === undefined || network === "both") {
    return;
  }
  target.network = network;
}

/**
 * Shadowsocks-2022 per-user keys must equal the cipher key length. The stored
 * peer credential is a base64 key (32 bytes for the generated peers), so the
 * 128-bit 2022 method needs the first 16 decoded bytes. Classic methods and
 * other password protocols accept the credential unchanged.
 */
export function peerPassword(method: unknown, credential: string): string {
  if (typeof method !== "string" || !method.startsWith("2022-")) {
    return credential;
  }
  if (method === "2022-blake3-aes-128-gcm") {
    return Buffer.from(credential, "base64").subarray(0, 16).toString("base64");
  }
  return credential;
}

function uuidFromCredential(credential: string): string {
  const hex = createHash("sha256").update(credential).digest("hex");
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-4${hex.slice(9, 12)}-8${hex.slice(13, 16)}-${hex.slice(16, 28)}`;
}

function peerUser(
  protocol: string,
  linkId: string,
  generation: number,
  credential: string,
  method: unknown,
): Json {
  const name = encodePeerLinkIdentity(linkId, generation);
  if (protocol === "vless" || protocol === "vmess") {
    return { name, uuid: credential };
  }
  if (UUID_PASSWORD_PROTOCOLS.has(protocol)) {
    return { name, uuid: uuidFromCredential(credential), password: credential };
  }
  if (LINK_KEYED_PROTOCOLS.has(protocol)) {
    return { username: name, password: credential };
  }
  if (AUTH_STR_PROTOCOLS.has(protocol)) {
    return { name, auth_str: credential };
  }
  return {
    name,
    password:
      protocol === "shadowsocks"
        ? peerPassword(method, credential)
        : credential,
  };
}

function realityBlock(
  tls: Json,
  direction: "inbound" | "outbound",
): Json | null {
  const reality = objectValue(tls.reality);
  if (!reality || reality.enabled !== true) {
    return null;
  }
  if (direction === "inbound") {
    return { ...reality, enabled: true };
  }
  const publicKey =
    typeof reality.public_key === "string"
      ? reality.public_key
      : typeof reality.private_key === "string"
        ? realityPublicKey(reality.private_key)
        : null;
  if (!publicKey) {
    return null;
  }
  const shortId =
    typeof reality.short_id === "string"
      ? reality.short_id
      : Array.isArray(reality.short_id) &&
          typeof reality.short_id[0] === "string"
        ? reality.short_id[0]
        : "";
  return {
    enabled: true,
    public_key: publicKey,
    ...(shortId.length > 0 ? { short_id: shortId } : {}),
  };
}

const PKCS8_X25519_PREFIX = Buffer.from(
  "302e020100300506032b656e04220420",
  "hex",
);

function realityPublicKey(privateKeyB64url: string): string | null {
  const raw = Buffer.from(privateKeyB64url, "base64url");
  if (raw.length !== 32) return null;
  try {
    const priv = createPrivateKey({
      key: Buffer.concat([PKCS8_X25519_PREFIX, raw]),
      format: "der",
      type: "pkcs8",
    });
    const spki = createPublicKey(priv).export({ type: "spki", format: "der" });
    return Buffer.from(spki.subarray(-32)).toString("base64url");
  } catch {
    return null;
  }
}

function sanitizedTls(tls: Json | undefined): Json {
  const value = tls ? { ...tls } : {};
  for (const field of MANAGED_CERTIFICATE_MATERIAL_TLS_FIELDS) {
    delete value[field];
  }
  delete value.server_name;
  delete value.reality;
  return value;
}

/**
 * Builds one peer receiver inbound (`peer-in-<id>`) from a frozen intent peer
 * and its admitted credentials. Returns the complete inbound; the caller owns
 * zero-admission pruning.
 */
export function buildPeerInbound(
  peer: PeerInboundShape,
  users: {
    linkId: string;
    generation: number;
    credential: string;
  }[],
): Json {
  const schema = inboundSchema(peer.protocol);
  const settings = cloneJson(peer.settings ?? {});
  const tlsSupported = schemaHasField(schema, "tls");
  const tls = objectValue(settings.tls);
  const reality = realityBlock(tls ?? {}, "inbound");
  const capability = isPeerProtocol(peer.protocol)
    ? peerProtocolCapability(peer.protocol)
    : null;
  const wantsTls =
    tlsSupported &&
    (peer.certificateId !== null ||
      peer.tlsServerName !== null ||
      reality !== null ||
      capability?.tlsMode === "required" ||
      tls?.enabled === true);

  if (wantsTls) {
    const nextTls = sanitizedTls(tls);
    nextTls.enabled = true;
    if (peer.tlsServerName !== null) {
      nextTls.server_name = peer.tlsServerName;
    }
    if (reality !== null) {
      nextTls.reality = reality;
    }
    settings.tls = nextTls;
  }

  const method = settings.method;
  const built: Json = {
    ...settings,
    type: peer.protocol,
    tag: peer.runtimeTag,
    listen: peer.listenAddress,
    listen_port: peer.listenPort,
    users: users.map((user) =>
      peerUser(
        peer.protocol,
        user.linkId,
        user.generation,
        user.credential,
        method,
      ),
    ),
  };
  applyManagedNetwork(
    built,
    peer.network,
    peerInboundSupportsNetwork(peer.protocol),
  );
  if (peer.protocol === "shadowsocks" && typeof method !== "string") {
    throw new Error(
      `peer inbound ${peer.runtimeTag} requires a shadowsocks method`,
    );
  }
  return built;
}

/**
 * Builds one sender outbound (`peer-out-<id>`). Protocol-specific settings from
 * the intent are merged first; managed endpoint, tag, TLS trust and credential
 * fields always win.
 */
export function buildPeerOutbound(
  outbound: PeerOutboundShape,
  credential: string,
): Json {
  const protocol = outbound.protocol;
  const schema = outboundSchema(protocol);
  if (!schema) {
    throw new Error(`unknown peer outbound protocol ${protocol}`);
  }
  const settings = cloneJson(outbound.settings ?? {});
  const tlsSupported = schemaHasField(schema, "tls");
  const tls = objectValue(settings.tls);
  const reality = realityBlock(tls ?? {}, "outbound");
  const capability = isPeerProtocol(protocol)
    ? peerProtocolCapability(protocol)
    : null;
  const trustMode = outbound.trustMode;
  const wantsTls =
    tlsSupported &&
    (reality !== null ||
      trustMode === "managed_certificate" ||
      trustMode === "system" ||
      outbound.tlsServerName !== null ||
      capability?.tlsMode === "required" ||
      protocol === "shadowtls" ||
      tls?.enabled === true);

  if (wantsTls) {
    const nextTls = sanitizedTls(tls);
    nextTls.enabled = true;
    if (outbound.tlsServerName !== null) {
      nextTls.server_name = outbound.tlsServerName;
    }
    if (reality !== null) {
      nextTls.reality = reality;
    }
    settings.tls = nextTls;
  }

  const method = settings.method;
  const base: Json = {
    ...settings,
    type: protocol,
    tag: outbound.runtimeTag,
    server: outbound.serverAddress,
    server_port: outbound.serverPort,
  };

  if (protocol === "vless" || protocol === "vmess") {
    base.uuid = credential;
  } else if (UUID_PASSWORD_PROTOCOLS.has(protocol)) {
    base.uuid = uuidFromCredential(credential);
    base.password = credential;
  } else if (LINK_KEYED_PROTOCOLS.has(protocol)) {
    if (outbound.linkId === null || outbound.credentialGeneration === null) {
      throw new Error(
        `peer outbound ${outbound.runtimeTag} is missing its link identity`,
      );
    }
    base.username = encodePeerLinkIdentity(
      outbound.linkId,
      outbound.credentialGeneration,
    );
    base.password = credential;
  } else if (AUTH_STR_PROTOCOLS.has(protocol)) {
    base.auth_str = credential;
  } else if (protocol === "shadowsocks") {
    if (typeof method !== "string") {
      throw new Error(
        `peer outbound ${outbound.runtimeTag} requires a shadowsocks method`,
      );
    }
    base.password = peerPassword(method, credential);
  } else {
    base.password = credential;
  }
  if (protocol === "socks" && typeof base.version !== "string") {
    base.version = "5";
  }

  // A peer hostname must resolve through direct egress, never through the link
  // being commissioned. IP literals need no resolver.
  if (
    !isIpAddress(outbound.serverAddress) &&
    schemaHasField(schema, "domain_resolver")
  ) {
    base.domain_resolver = "bootstrap";
  }

  const network = settings.network;
  applyManagedNetwork(
    base,
    typeof network === "string" ? (network as PeerNetwork) : undefined,
    peerOutboundSupportsNetwork(protocol),
  );
  return base;
}

function isIpAddress(value: string): boolean {
  return isIP(value) !== 0;
}

/** Validates a fully built outbound against its sing-box schema. */
export function assertValidManagedOutbound(
  outbound: Json,
  protocol: string,
): void {
  const schema = outboundSchema(protocol);
  if (!schema) {
    throw new Error(`unknown sing-box outbound protocol ${protocol}`);
  }
  const parsed = schema.safeParse(outbound);
  if (!parsed.success) {
    throw new Error(
      `outbound ${String(outbound.tag ?? "<untagged>")} is invalid: ${parsed.error.message}`,
    );
  }
}
