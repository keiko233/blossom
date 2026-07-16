const DOCS_ORIGIN = "https://sing-box.sets.dev";
const DOCS_PATH_RE = /^\/[a-zA-Z0-9/_.-]*$/;
const DOCS_MAX_BYTES = 128 * 1024;
const DOCS_TIMEOUT_MS = 10_000;
const DOCS_MAX_PATH_LENGTH = 256;

export interface SingBoxDocEntry {
  path: string;
  title: string;
}

export const DOCS_CATALOG: SingBoxDocEntry[] = [
  { path: "/", title: "sing-box" },
  { path: "/configuration", title: "Configuration" },
  { path: "/configuration/log", title: "Log" },
  { path: "/configuration/dns", title: "DNS" },
  { path: "/configuration/dns/rule", title: "DNS Rule" },
  { path: "/configuration/ntp", title: "NTP" },
  { path: "/configuration/inbound", title: "Inbound" },
  { path: "/configuration/inbound/tun", title: "TUN" },
  { path: "/configuration/inbound/tproxy", title: "TProxy" },
  { path: "/configuration/inbound/redirect", title: "Redirect" },
  { path: "/configuration/inbound/direct", title: "Direct" },
  { path: "/configuration/inbound/socks", title: "SOCKS" },
  { path: "/configuration/inbound/http", title: "HTTP" },
  { path: "/configuration/inbound/mixed", title: "Mixed" },
  { path: "/configuration/inbound/shadowsocks", title: "Shadowsocks" },
  { path: "/configuration/inbound/vmess", title: "VMess" },
  { path: "/configuration/inbound/trojan", title: "Trojan" },
  { path: "/configuration/inbound/naive", title: "Naive" },
  { path: "/configuration/inbound/hysteria", title: "Hysteria" },
  { path: "/configuration/inbound/hysteria2", title: "Hysteria2" },
  { path: "/configuration/inbound/vless", title: "VLESS" },
  { path: "/configuration/inbound/tuic", title: "TUIC" },
  { path: "/configuration/inbound/anytls", title: "AnyTLS" },
  { path: "/configuration/inbound/shadowtls", title: "ShadowTLS" },
  { path: "/configuration/outbound", title: "Outbound" },
  { path: "/configuration/outbound/direct", title: "Direct Outbound" },
  { path: "/configuration/outbound/block", title: "Block Outbound" },
  { path: "/configuration/outbound/dns", title: "DNS Outbound" },
  { path: "/configuration/outbound/socks", title: "SOCKS Outbound" },
  { path: "/configuration/outbound/http", title: "HTTP Outbound" },
  {
    path: "/configuration/outbound/shadowsocks",
    title: "Shadowsocks Outbound",
  },
  { path: "/configuration/outbound/vmess", title: "VMess Outbound" },
  { path: "/configuration/outbound/trojan", title: "Trojan Outbound" },
  { path: "/configuration/outbound/wireguard", title: "WireGuard Outbound" },
  { path: "/configuration/outbound/hysteria", title: "Hysteria Outbound" },
  { path: "/configuration/outbound/hysteria2", title: "Hysteria2 Outbound" },
  { path: "/configuration/outbound/vless", title: "VLESS Outbound" },
  { path: "/configuration/outbound/tuic", title: "TUIC Outbound" },
  { path: "/configuration/outbound/tor", title: "Tor Outbound" },
  { path: "/configuration/outbound/ssh", title: "SSH Outbound" },
  { path: "/configuration/outbound/anytls", title: "AnyTLS Outbound" },
  { path: "/configuration/outbound/shadowtls", title: "ShadowTLS Outbound" },
  { path: "/configuration/route", title: "Route" },
  { path: "/configuration/route/rule", title: "Route Rule" },
  { path: "/configuration/route/rule_set", title: "Rule Set" },
  { path: "/configuration/experimental", title: "Experimental" },
  { path: "/configuration/experimental/cache-file", title: "Cache File" },
  { path: "/configuration/experimental/clash-api", title: "Clash API" },
  { path: "/configuration/experimental/v2ray-api", title: "V2Ray API" },
  { path: "/configuration/shared", title: "Shared" },
  { path: "/configuration/shared/dial-fields", title: "Dial Fields" },
  { path: "/configuration/shared/listen-fields", title: "Listen Fields" },
  { path: "/configuration/shared/tls", title: "TLS" },
  { path: "/configuration/shared/transport", title: "Transport" },
  { path: "/configuration/shared/multiplex", title: "Multiplex" },
  { path: "/configuration/shared/udp-over-tcp", title: "UDP over TCP" },
  { path: "/configuration/shared/rule-actions", title: "Rule Actions" },
];

export function validateDocPath(rawPath: string): string {
  if (rawPath.length > DOCS_MAX_PATH_LENGTH) {
    throw new Error("Path too long");
  }
  if (rawPath.includes("..")) {
    throw new Error("Path traversal not allowed");
  }
  if (rawPath.includes("//")) {
    throw new Error("Path traversal not allowed");
  }
  if (!DOCS_PATH_RE.test(rawPath)) {
    throw new Error("Invalid path: only alphanumeric, /, _, ., - allowed");
  }
  return rawPath;
}

export function searchCatalog(query: string): SingBoxDocEntry[] {
  const q = query.toLowerCase().trim();
  if (!q) return DOCS_CATALOG.slice(0, 20);

  const scored = DOCS_CATALOG.map((entry) => {
    const title = entry.title.toLowerCase();
    const exact = title === q ? 100 : 0;
    const starts = title.startsWith(q) ? 50 : 0;
    const contains = title.includes(q) ? 20 : 0;
    const pathContains = entry.path.toLowerCase().includes(q) ? 10 : 0;
    return { entry, score: exact + starts + contains + pathContains };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10)
    .map((s) => s.entry);
}

export async function fetchDocPage(
  path: string,
): Promise<{ path: string; content: string }> {
  const safePath = validateDocPath(path);
  const url = `${DOCS_ORIGIN}${safePath}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOCS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "text/html" },
    });

    if (!response.ok) {
      throw new Error(`Doc fetch failed: ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      throw new Error("Unexpected content type");
    }

    const text = await response.text();
    const bytes = new TextEncoder().encode(text);
    if (bytes.length > DOCS_MAX_BYTES) {
      throw new Error("Response too large");
    }

    const extracted = extractTextFromHtml(text);
    return { path: safePath, content: extracted };
  } finally {
    clearTimeout(timer);
  }
}

function extractTextFromHtml(html: string): string {
  const stripped = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return stripped.length > DOCS_MAX_BYTES
    ? stripped.slice(0, DOCS_MAX_BYTES) + "..."
    : stripped;
}
