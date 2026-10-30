// Turns the Clash proxies a subscription serves into a sing-box client config,
// so the harness can drive real traffic with the credentials the panel hands
// to a user rather than with credentials it invented.

import { createRequire } from "node:module";
import path from "node:path";

export function loadYaml(repoRoot) {
  // `yaml` is an app dependency; resolve it from there instead of adding one.
  const require = createRequire(path.join(repoRoot, "app", "package.json"));
  return require("yaml");
}

export function parseClashProxies(yaml, text) {
  const doc = yaml.parse(text);
  if (!doc || !Array.isArray(doc.proxies)) {
    throw new Error("subscription has no proxies list");
  }
  return doc.proxies;
}

const SUPPORTED = new Set(["vmess"]);

/** Maps one Clash proxy to a sing-box outbound; throws for unsupported types. */
export function clashProxyToOutbound(proxy, tag = "proxy") {
  if (!SUPPORTED.has(proxy.type)) {
    throw new Error(
      `harness client does not support the '${proxy.type}' proxy type`,
    );
  }
  if (proxy.tls || (proxy.network && proxy.network !== "tcp")) {
    // The harness node is plain TCP; fail loudly rather than test a different
    // transport than the subscription describes.
    throw new Error("harness client only supports plain TCP vmess");
  }
  return {
    type: "vmess",
    tag,
    server: proxy.server,
    server_port: Number(proxy.port),
    uuid: proxy.uuid,
    security: proxy.cipher ?? "auto",
    alter_id: Number(proxy.alterId ?? 0),
  };
}

/** A sing-box client exposing a loopback mixed (HTTP+SOCKS) inbound. */
export function buildClientConfig(outbound, listenPort, logPath) {
  return {
    log: { level: "warn", output: logPath, timestamp: true },
    inbounds: [
      {
        type: "mixed",
        tag: "local",
        listen: "127.0.0.1",
        listen_port: listenPort,
      },
    ],
    outbounds: [outbound],
    route: { final: outbound.tag },
  };
}
