import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..", "..");
const catalog = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(appRoot, "messages", locale), "utf8"));
const en = catalog("en.json");
const zh = catalog("zh-cn.json");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") ? [path] : [];
  });
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

const proxyPages = join(
  appRoot,
  "src",
  "routes",
  "(admin)",
  "admin",
  "proxies",
);

describe("server, node and certificate messages", () => {
  it("keeps both locale catalogs on the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("defines every message the proxy admin pages use in both locales", () => {
    const used = new Set<string>();
    for (const dir of ["servers", "nodes", "certificates"]) {
      for (const file of sourceFiles(join(proxyPages, dir))) {
        for (const match of readFileSync(file, "utf8").matchAll(
          /\bm\.([a-z0-9_]+)\(/g,
        )) {
          used.add(match[1]!);
        }
      }
    }
    expect(used.size).toBeGreaterThan(0);
    const missing = [...used].filter((key) => !(key in en) || !(key in zh));
    expect(missing).toEqual([]);
  });

  it("uses the same interpolation parameters in both locales", () => {
    const mismatched = Object.keys(en).filter(
      (key) =>
        key in zh &&
        placeholders(en[key]!).join() !== placeholders(zh[key]!).join(),
    );
    expect(mismatched).toEqual([]);
  });

  it("translates the new context messages rather than copying English", () => {
    const keys = Object.keys(en).filter(
      (key) =>
        /^admin_proxies_(servers_(nodes_|pending_|status_note|action_(view|add)_node)|nodes_(cert_|filter_|tls_(protocol|disabled|none)_help|form_server))/.test(
          key,
        ) ||
        /^admin_certificates_(usage_|deployment_help|deploy_agent_stale)/.test(
          key,
        ),
    );
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(zh[key], key).toBeTruthy();
      expect(zh[key], key).not.toBe(en[key]);
    }
  });
});
