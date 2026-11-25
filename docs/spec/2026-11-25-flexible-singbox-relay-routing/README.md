# Flexible sing-box Relay, Multi-Protocol Peering, Port Forwarding & Routing

Design specification and phased execution contract for expanding Blossom's managed sing-box networking beyond TCP-only `trojan`/`vless` peering and `direct` egress.

## 1. Goals

1. **Flexible relay topologies**: Straighten suboptimal user→exit paths via a transit server using either protocol-aware tunnels (full-traffic or split-routed) or L4 port forwarding.
2. **Full-traffic transit without forced splitting**: Allow a transit server's subscriber inbound (e.g. VLESS) to forward all traffic (TCP + UDP when supported) straight to an exit server (`route.final` or catch-all rule).
3. **Multi-protocol peer links & arbitrary sing-box outbounds**:
   - Uncensored/fast links: `shadowsocks` (including AEAD-2022), `socks` (SOCKS5), `vmess`.
   - Censorship-resistant TCP/TLS links: `vless` (TLS, Reality, WS/gRPC/HTTPUpgrade), `trojan`, `anytls`.
   - Loss-tolerant UDP/QUIC links: `hysteria2`, `tuic`.
   - Any sing-box protocol supported by `@black-duty/sing-box-schema` without hand-writing protocol schemas.
   - Custom external proxy outbounds (`custom_proxy`) and outbound groups (`selector`, `urltest`).
4. **Automatic peer bridging & existing-node reuse**:
   - If the exit server has no matching peer inbound, automatically allocate a free port (via `listener_claim`), provision credentials / keys / certificate binding, and create both ends + optional full-forward rule in one atomic draft/rollout.
   - If the exit server already has a `peer_inbound` or subscriber `node`, reuse its protocol/config automatically. Default for an existing subscriber `node` is creating an isolated `peer_inbound` matching its protocol profile (to keep subscriber metering isolated); explicit shared-node reuse is also supported with a metering notice.
5. **L4 Port Forwarding (no tunnel overhead)**:
   - Native sing-box `direct` inbound (`override_address` + `override_port`, TCP/UDP/both) on the transit server.
   - When targeting a managed exit `node` and exposed in a `proxy_group`, subscription export emits the transit server's address & port with the exit node's protocol, TLS/Reality, and subscriber credentials. Traffic is authenticated and metered once at the exit node; the transit `relay-in-<id>` inbound is classified as non-billable infrastructure.
6. **Rich server-side routing & curated rule-sets**:
   - Curated rule-set catalog (e.g. speedtest, AI, streaming, regional GeoIP/Geosite) imported into `managed_rule_set_asset` (keeping agent-side offline `.srs` verification).
   - Route rule extensions: `portRanges`, `protocols`, `invert`, and routing to any outbound (direct profile, peer link, custom proxy, or `urltest`/`selector` group).

## 2. Schema-First Principle (No Hand-Rolled sing-box Schemas)

All sing-box inbound and outbound protocol shapes MUST be derived from `@black-duty/sing-box-schema` (which is generated from sing-box's JSON schema to Zod v4).

- `app/src/orpc/proxy/sing-box-registry.ts` is the single introspection point for both `INBOUND_BY_TYPE` and `OUTBOUND_BY_TYPE`.
- Protocol capabilities (`supportsUdp`, `tlsMode`, `credentialKind`) are derived by introspecting the Zod shapes (with small metadata overrides only where JSON schema does not encode runtime semantics, such as UDP support or Reality compatibility).
- Admin UI forms reuse `SchemaForm` over the derived Zod schemas minus managed/control-plane fields.

## 3. Data Model & Contracts (Phase 0 / PR 1)

### 3.1 Runtime Tag Namespaces (`packages/domain/src/managed-networking.ts`)

| Kind                    | Prefix / Tag              | Billable     | Notes                                  |
| ----------------------- | ------------------------- | ------------ | -------------------------------------- |
| Built-in direct         | `direct`                  | N/A          | Legacy default outbound                |
| Subscriber inbound      | `node-<id>`               | Yes          | Existing subscriber entrance           |
| Peer inbound            | `peer-in-<id>`            | No (`Peer`)  | Receives inter-server links            |
| Port forward inbound    | `relay-in-<id>`           | No (`Relay`) | sing-box `direct` inbound L4 forwarder |
| Peer link outbound      | `peer-out-<id>`           | N/A          | Generated outbound for a `peer_link`   |
| Direct profile outbound | `direct-<id>`             | N/A          | Named direct dial profile              |
| Custom proxy outbound   | `custom-out-<id>`         | N/A          | External/third-party sing-box outbound |
| Outbound group          | `group-out-<id>`          | N/A          | `selector` or `urltest` outbound       |
| Rule-set                | `rule-set-<id>`           | N/A          | Local `.srs` asset                     |
| Agent-owned             | `blossom-agent-<purpose>` | No (`Probe`) | Loopback probe/stats                   |

### 3.2 Database Schema Changes (`app/src/db/managed-network-schema.ts`)

1. `listener_claim`:
   - `owner_kind` check constraint expanded to `('subscriber_inbound', 'peer_inbound', 'port_forward')`.
2. `peer_inbound`:
   - `protocol`: expanded from `trojan | vless` to any schema-derived peer-capable protocol (`vless`, `trojan`, `shadowsocks`, `socks`, `vmess`, `hysteria2`, `tuic`, `anytls`, `naive`, `hysteria`, `shadowtls`).
   - `tls_server_name`: nullable (`text("tls_server_name")`).
   - `certificate_id`: nullable (`text("certificate_id").references(() => managedCertificate.id, { onDelete: "restrict" })`).
   - `network`: `text("network").default("both").notNull()` (`"tcp" | "udp" | "both"`).
   - `settings`: `jsonb("settings").default({}).notNull()` (validated sing-box inbound fragment minus managed/TLS-material fields).
   - `source_node_id`: nullable `text("source_node_id").references(() => node.id, { onDelete: "set null" })` (optional link when auto-bridged from an existing exit node).
3. `managed_outbound`:
   - `kind`: expanded to `'direct_profile' | 'peer_link' | 'custom_proxy' | 'outbound_group'`.
   - `protocol`: nullable `text("protocol")` (set for `custom_proxy` and `outbound_group` (`selector` / `urltest`)).
   - `settings`: `jsonb("settings").default({}).notNull()` (non-secret sing-box outbound fragment / group options).
   - `secret_ciphertext`: nullable `text("secret_ciphertext")` (AES-256-GCM encrypted JSON map of secret outbound fields such as `password`, `uuid`, `private_key`, `auth_str` for `custom_proxy`).
   - `member_outbound_tags`: `jsonb("member_outbound_tags").$type<string[]>().default([]).notNull()` (for `outbound_group`).
4. `port_forward` (new table):
   - `id`, `server_id` (source transit server), `name`, `runtime_tag` (`relay-in-<id>`, unique), `enabled`.
   - `listen_address`, `listen_port` (reserved in `listener_claim`), `network` (`tcp` | `udp` | `both`).
   - `target_node_id` (nullable FK to `node.id` on delete restrict), `target_address` (nullable), `target_port` (nullable). Check constraint: either `target_node_id IS NOT NULL` or (`target_address IS NOT NULL AND target_port IS NOT NULL`).
   - `outbound_tag`: nullable `text("outbound_tag")` (optional `direct-<id>` or `direct` egress for the forwarded leg).
   - `revision`, `created_at`, `updated_at`.
5. `port_forward_group` (or extending subscription export in Phase 2):
   - Managed in PR 5 so Phase 0 stays minimal and clean.

### 3.3 V3 Stage Intent Contract (`packages/contracts/src/agent-config-v3.ts`)

- `managedIntentPeerInboundSchema`:
  - `protocol`: `z.string().min(1).max(64)` (validated against peer protocol allowlist/schema).
  - `tlsServerName`, `certificateId`, `certificateGeneration`, `certificateFingerprintSha256`: nullable (only required when TLS with managed certificate is enabled).
  - `network`: `z.enum(["tcp", "udp", "both"]).default("both")`.
  - `settings`: `z.record(z.string(), z.unknown()).default({})`.
- `managedIntentOutboundSchema`:
  - `kind`: `z.enum(["direct_profile", "peer_link", "custom_proxy", "outbound_group"])`.
  - `supportsUdp`: `z.boolean().default(true)` (explicitly carried in intent so compiler & routing validator do not guess).
  - `settings`: `z.record(z.string(), z.unknown()).default({})`.
  - `memberOutboundTags`: `z.array(z.string().min(1).max(128)).max(128).default([])`.
  - For `peer_link`, `tlsServerName` and `trustMode` become nullable (for non-TLS protocols like Shadowsocks/SOCKS5 or Reality).
- `managedIntentPortForwardSchema`:
  - `forwardId`, `runtimeTag` (`relay-in-<id>`), `listenAddress`, `listenPort`, `network`, `overrideAddress`, `overridePort`, `outboundTag` (nullable).
- `managedIntentRouteRuleSchema`:
  - Add optional `portRanges: z.array(z.string().min(1)).max(256).default([])`, `protocols: z.array(z.string().min(1)).max(64).default([])`, `invert: z.boolean().default(false)`.
- `managedStageIntentSchema`:
  - Add `portForwards: z.array(managedIntentPortForwardSchema).max(1_000).default([])`.

## 4. Phased PR Execution Plan

| Phase   | PR   | Scope                                                                                                                                               | Parallelizable               |
| ------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Phase 0 | PR 1 | Spec + Schema Registry (`Outbound` + protocol capabilities) + DB migration + `@blossom/domain` + `@blossom/contracts`                               | Sequential foundation        |
| Phase 1 | PR 2 | Multi-protocol Peer compiler + `custom_proxy` + `outbound_group` + UDP-aware routing & `finalOutboundTag`                                           | Parallel (pi deepseek-flash) |
| Phase 1 | PR 3 | Rust `server-agent`: non-TLS peers, `relay-in-*`/`custom-out-*`/`group-out-*` tags, multi-protocol probe credentials, `InboundKind::Relay` metering | Parallel (pi deepseek-flash) |
| Phase 1 | PR 4 | Auto-Bridge service (create missing exit `peer_inbound` or reuse existing `peer_inbound`/`node`) + full-forward shortcut                            | Parallel (pi deepseek-flash) |
| Phase 2 | PR 5 | L4 Port Forwarding (`port_forward` CRUD, `direct` inbound compile, subscription export override, Publish Gate)                                      | Parallel (pi deepseek-flash) |
| Phase 3 | PR 6 | Curated Rule-Set Catalog + routing rule enhancements (`portRanges`, `protocols`, `invert`, templates)                                               | After Phase 1                |
| Phase 3 | PR 7 | Admin UI (Outbounds, Auto-Bridge wizard, Port Forwarding, Routing/Rule-Set catalog, `en.json` + `zh-cn.json`)                                       | After PR 4/5/6               |

## 5. Non-Negotiable Invariants

- **Admin vs Agent boundary**: All mutations live in `app/src/query/` with `ensureAdmin()` and `adminAudit(...)`.
- **Secrets**: `custom_proxy` secrets encrypted with AES-256-GCM; peer credentials stay in `peer_link_credential`; never returned in DTOs, previews, or logs.
- **Database drivers**: Every atomic writer must work on both `node-postgres` and `neon-http` (single-statement CTEs with `managed_topology` generation CAS).
- **Metering fail-closed**: `server-agent` only bills `node-*` with valid `blz.1.*` user codec; `peer-in-*`, `relay-in-*`, and `blossom-agent-*` are never billed.
- **Generated files**: Never hand-edit `route-tree.gen.ts`, `paraglide/`, `snapshot.json`, or `openapi/spec*.json`; always regenerate with the documented commands.
