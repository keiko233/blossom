import { Inbound } from "@black-duty/sing-box-schema";
import type { z } from "zod";

/**
 * Single source of truth for protocol handling, derived from the sing-box schema.
 *
 * `@black-duty/sing-box-schema` exports `Inbound` as a discriminated union over
 * `type`; we index its members by that literal so a protocol's full Zod schema is
 * available for validation and form generation. The list of node protocols is
 * derived from the schema itself — no hand-maintained whitelist, no per-protocol
 * code anywhere else.
 */

// The union members are ZodObjects; introspection needs the internal `def`, which
// the public union type doesn't surface, so this small area is loosely typed.
type ZodObjectLike = z.ZodObject<Record<string, z.ZodTypeAny>>;

interface UnionDef {
  options: ZodObjectLike[];
}

function buildInboundByType(): Record<string, ZodObjectLike> {
  const options = (Inbound.def as unknown as UnionDef).options;
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
  buildInboundByType();

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

/** Certificate material is always selected from the certificate service. */
export const MANAGED_CERTIFICATE_MATERIAL_TLS_FIELDS = [
  "certificate",
  "certificate_path",
  "key",
  "key_path",
  "acme",
  "certificate_provider",
] as const;

/** TLS values owned by the certificate service once a node selects a certificate. */
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

/** Remove inline/path certificate settings so only the managed columns are authoritative. */
export function withoutManagedCertificateTlsFields(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = withoutCertificateMaterialTlsFields(settings);
  const tls = objectValue(sanitized.tls);
  if (tls) {
    delete tls.server_name;
  }
  return sanitized;
}

/** Remove every raw certificate/key source while retaining non-material TLS options. */
function withoutCertificateMaterialTlsFields(
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
