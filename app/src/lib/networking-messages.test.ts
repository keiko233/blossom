import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..", "..");
const catalog = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(appRoot, "messages", locale), "utf8"));
const en = catalog("en.json");
const zh = catalog("zh-cn.json");

const adminRoutes = join(appRoot, "src", "routes", "(admin)", "admin");
const networking = join(adminRoutes, "networking");
const roots = [
  join(networking, "_modules"),
  join(networking, "topology.tsx"),
  join(networking, "links.tsx"),
  join(networking, "routing.tsx"),
  join(networking, "rule-sets.tsx"),
  join(adminRoutes, "servers", "_modules", "outbound-editor-dialog.tsx"),
  join(adminRoutes, "servers", "$serverId", "outbounds.tsx"),
];

function sourceFiles(path: string): string[] {
  if (statSync(path).isFile()) return /\.tsx?$/.test(path) ? [path] : [];
  return readdirSync(path).flatMap((entry) => sourceFiles(join(path, entry)));
}

const usedKeys = new Set<string>();
for (const file of roots.flatMap(sourceFiles)) {
  for (const match of readFileSync(file, "utf8").matchAll(
    /\bm\.([a-z0-9_]+)\(/g,
  )) {
    usedKeys.add(match[1]!);
  }
}
for (const preset of [
  "geoip_cn",
  "geosite_cn",
  "geoip_private",
  "geosite_private",
]) {
  usedKeys.add(`admin_networking_preset_${preset}`);
  usedKeys.add(`admin_networking_preset_${preset}_description`);
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

describe("networking workspace messages", () => {
  it("keeps both locale catalogues on the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("defines every message the networking pages use in both locales", () => {
    expect(usedKeys.size).toBeGreaterThan(100);
    const missing = [...usedKeys].filter((key) => !(key in en) || !(key in zh));
    expect(missing).toEqual([]);
  });

  it("uses the same interpolation parameters in both locales", () => {
    const mismatched = [...usedKeys].filter(
      (key) => placeholders(en[key]!).join() !== placeholders(zh[key]!).join(),
    );
    expect(mismatched).toEqual([]);
  });

  it("does not leave the new networking strings untranslated", () => {
    const untranslated = [...usedKeys].filter(
      (key) =>
        !key.startsWith("admin_networking_routing_network_") &&
        !key.startsWith("admin_networking_routing_match_") &&
        !key.endsWith("_ip_ipv4") &&
        !key.endsWith("_ip_ipv6") &&
        key !== "admin_networking_topology_probe_value" &&
        zh[key] === en[key],
    );
    expect(untranslated).toEqual([]);
  });
});
