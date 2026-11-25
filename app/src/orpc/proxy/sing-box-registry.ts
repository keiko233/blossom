import { Inbound, Outbound } from "@black-duty/sing-box-schema";
import type { z } from "zod";

/**
 * Single source of truth for protocol handling, derived from the sing-box schema.
 *
 * `@black-duty/sing-box-schema` exports `Inbound` and `Outbound` as discriminated
 * unions over `type`; we index their members by that literal so every protocol's
 * full Zod schema is available for validation and form generation. No hand-written
 * sing-box protocol schemas are maintained anywhere else.
 */

// The union members are ZodObjects; introspection needs the internal `def`, which
// the public union type doesn't surface, so this small area is loosely typed.
type ZodObjectLike = z.ZodObject<Record<string, z.ZodTypeAny>>;

interface UnionDef {
  options: ZodObjectLike[];
}

function buildByType(union: unknown): Record<string, ZodObjectLike> {
  const options = (union as { def: UnionDef }).def.options;
  const byType: Record<string, ZodObjectLike> = {};

  for (const member of options) {
    const typeField = member.def.shape.type as unknown as {
      def: { values?: unknown[]; value?: unknown };
    };
    const literal = typeField.def.values?.[0] ?? typeField.def.value;
    if (typeof literal === "string") {
      byType[literal] = member;
    }
  }

  return byType;
}

export const INBOUND_BY_TYPE: Record<string, ZodObjectLike> =
  buildByType(Inbound);

export const OUTBOUND_BY_TYPE: Record<string, ZodObjectLike> =
  buildByType(Outbound);

/** Fields injected by the compiler on every outbound. */
export const MANAGED_OUTBOUND_FIELDS = ["type", "tag"] as const;

/** Outbound fields that carry sensitive credentials and must be encrypted at rest. */
export const OUTBOUND_SECRET_FIELD_NAMES = [
  "password",
  "uuid",
  "private_key",
  "auth_str",
  "auth",
  "pre_shared_key",
] as const;

const NON_CUSTOM_PROXY_OUTBOUNDS = new Set([
  "direct",
  "block",
  "selector",
  "urltest",
]);

/** Every sing-box outbound type derived from the schema. */
export const OUTBOUND_PROTOCOLS: readonly string[] =
  Object.keys(OUTBOUND_BY_TYPE).sort();

/**
 * Editable Zod schema for an outbound protocol, derived from `@black-duty/sing-box-schema`
 * minus compiler-injected `type` and `tag`.
 */
export function outboundSettingsSchemaFor(protocol: string): ZodObjectLike {
  const schema = OUTBOUND_BY_TYPE[protocol];
  if (!schema) {
    throw new Error(`Unknown sing-box outbound protocol: ${protocol}`);
  }
  const shape = schema.def.shape;
  const mask: Record<string, true> = {};
  for (const key of MANAGED_OUTBOUND_FIELDS) {
    if (key in shape) {
      mask[key] = true;
    }
  }
  return schema.omit(mask) as ZodObjectLike;
}

/**
 * Splits a validated custom outbound settings object into non-secret settings and
 * secret credential fields (for encrypted storage), based on `OUTBOUND_SECRET_FIELD_NAMES`.
 */
export function splitOutboundSecrets(settings: Record<string, unknown>): {
  publicSettings: Record<string, unknown>;
  secrets: Record<string, unknown>;
} {
  const publicSettings: Record<string, unknown> = {};
  const secrets: Record<string, unknown> = {};
  const secretSet = new Set<string>(OUTBOUND_SECRET_FIELD_NAMES);
  for (const [key, value] of Object.entries(settings)) {
    if (
      secretSet.has(key) &&
      value !== undefined &&
      value !== null &&
      value !== ""
    ) {
      secrets[key] = value;
    } else {
      publicSettings[key] = value;
    }
  }
  return { publicSettings, secrets };
}

/** Whether an outbound protocol exposes a sing-box `tls` block. */
export function outboundProtocolSupportsTls(protocol: string): boolean {
  const schema = OUTBOUND_BY_TYPE[protocol];
  return Boolean(schema && "tls" in schema.def.shape);
}

/**
 * Fields the compiler injects on every inbound; never shown in the form or stored
 * in the `settings` fragment. `listen`/`listen_port` come from node columns, `tag`
 * from the node id, `type` from the selected protocol, and `users` from the future
 * subscribers module.
 */
export const MANAGED_FIELDS = [
  "type",
  "tag",
  "listen",
  "listen_port",
  "users",
] as const;

/**
 * Raw X.509 material fields sing-box's inbound TLS block can carry. Manual
 * node X.509 ownership is removed: these values are never user-editable, never
 * stored, and always stripped from the stored `settings` fragment and the
 * compiled config. The certificate service is the only source of this material.
 */
export const MANAGED_CERTIFICATE_MATERIAL_TLS_FIELDS = [
  "certificate",
  "certificate_path",
  "key",
  "key_path",
  "acme",
  "certificate_provider",
] as const;

/**
 * TLS values owned by the control plane rather than the raw schema: the X.509
 * material above plus `server_name`, which is an explicit managed SNI field
 * (`node.tlsServerName`) rather than a schema field. All of these are hidden
 * from the generated form and stripped from settings on every write.
 */
export const MANAGED_CERTIFICATE_TLS_FIELDS = [
  "server_name",
  ...MANAGED_CERTIFICATE_MATERIAL_TLS_FIELDS,
] as const;

/**
 * A protocol is a "node" if it is a real user-facing proxy server: it listens on a
 * port (`listen_port`) and accepts per-user credentials (`users`). This excludes
 * sing-box's local/transparent inbounds (`tun`, `redirect`, `tproxy`, `direct`),
 * which aren't distributable proxy nodes. Every remaining inbound is supported.
 */
function isNodeInbound(member: ZodObjectLike): boolean {
  const shape = member.def.shape;
  return "listen_port" in shape && "users" in shape;
}

/** Common protocols first, then the rest in schema order. */
const PREFERRED_ORDER = [
  "vless",
  "vmess",
  "trojan",
  "shadowsocks",
  "hysteria2",
  "hysteria",
  "tuic",
  "anytls",
] as const;

function orderProtocols(types: string[]): string[] {
  const rank = (t: string) => {
    const i = PREFERRED_ORDER.indexOf(t as (typeof PREFERRED_ORDER)[number]);
    return i === -1 ? PREFERRED_ORDER.length : i;
  };
  return [...types].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** Every supported node protocol, derived from the sing-box inbound union. */
export const NODE_PROTOCOLS: readonly string[] = orderProtocols(
  Object.entries(INBOUND_BY_TYPE)
    .filter(([, member]) => isNodeInbound(member))
    .map(([type]) => type),
);

/** External proxy outbound protocols (all sing-box outbounds except direct/block/groups). */
export const CUSTOM_PROXY_OUTBOUND_PROTOCOLS: readonly string[] =
  orderProtocols(
    OUTBOUND_PROTOCOLS.filter((type) => !NON_CUSTOM_PROXY_OUTBOUNDS.has(type)),
  );

export function isCustomProxyOutboundProtocol(value: string): boolean {
  return CUSTOM_PROXY_OUTBOUND_PROTOCOLS.includes(value);
}

/** Protocol identifiers are dynamic (derived from the schema), hence a plain string. */
export type NodeProtocol = string;

export function isNodeProtocol(value: string): value is NodeProtocol {
  return NODE_PROTOCOLS.includes(value);
}

/**
 * The Zod schema for a protocol's editable settings: the full inbound schema minus
 * the managed fields. Used to validate the stored fragment and to generate the form.
 */
export function settingsSchemaFor(protocol: string): ZodObjectLike {
  const schema = INBOUND_BY_TYPE[protocol];
  if (!schema) {
    throw new Error(`Unknown sing-box protocol: ${protocol}`);
  }

  const shape = schema.def.shape;
  const mask: Record<string, true> = {};
  for (const key of MANAGED_FIELDS) {
    if (key in shape) {
      mask[key] = true;
    }
  }
  return schema.omit(mask) as ZodObjectLike;
}

/** Whether this inbound protocol exposes sing-box's server-side TLS block. */
export function protocolSupportsTls(protocol: string): boolean {
  const schema = INBOUND_BY_TYPE[protocol];
  return Boolean(schema && "tls" in schema.def.shape);
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Managed certificate material is meaningful only for explicitly enabled TLS. */
export function isNodeTlsEnabled(settings: Record<string, unknown>): boolean {
  return objectValue(settings.tls)?.enabled === true;
}

/** Reality owns its own key exchange and is mutually exclusive with X.509 material. */
export function isNodeRealityEnabled(
  settings: Record<string, unknown>,
): boolean {
  const tls = objectValue(settings.tls);
  return objectValue(tls?.reality)?.enabled === true;
}

/**
 * Remove every raw certificate/key source (inline PEM, path, acme) while
 * retaining non-material TLS options.
 */
export function withoutCertificateMaterialTlsFields(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = structuredClone(settings);
  const tls = objectValue(sanitized.tls);
  if (tls) {
    for (const key of MANAGED_CERTIFICATE_MATERIAL_TLS_FIELDS) {
      delete tls[key];
    }
  }
  return sanitized;
}

/**
 * The node-level TLS settings never carry X.509 material or a raw `server_name`:
 * the certificate service and the explicit SNI field own those values. Always
 * strips them, whether or not a managed certificate is selected, so
 * historical/manual material cannot survive a node write or the compiler.
 */
export function withoutNodeTlsMaterial(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = withoutCertificateMaterialTlsFields(settings);
  const tls = objectValue(sanitized.tls);
  if (tls) {
    delete tls.server_name;
  }
  return sanitized;
}
