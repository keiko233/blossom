import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "..", "..");
const catalog = (locale: string): Record<string, string> =>
  JSON.parse(readFileSync(join(appRoot, "messages", locale), "utf8"));
const en = catalog("en.json");
const zh = catalog("zh-cn.json");

const adminRoutes = join(appRoot, "src", "routes", "(admin)", "admin");
const queryDirs = [
  join(adminRoutes, "proxies", "groups"),
  join(adminRoutes, "plans"),
  join(adminRoutes, "subscriptions"),
];
const extraFiles = [
  join(adminRoutes, "users", "_modules", "assign-plan-dialog.tsx"),
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry) && !entry.endsWith(".test.ts") ? [path] : [];
  });
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort();

const usedKeys = new Set<string>();
for (const file of [...queryDirs.flatMap(sourceFiles), ...extraFiles]) {
  for (const match of readFileSync(file, "utf8").matchAll(
    /\bm\.([a-z0-9_]+)\(/g,
  )) {
    usedKeys.add(match[1]!);
  }
}

describe("group, plan and subscription impact messages", () => {
  it("keeps both locale catalogs on the same keys", () => {
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
  });

  it("defines every message these admin pages use in both locales", () => {
    expect(usedKeys.size).toBeGreaterThan(50);
    const missing = [...usedKeys].filter((key) => !(key in en) || !(key in zh));
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

  it("translates the access messages rather than copying English", () => {
    const keys = Object.keys(en).filter((key) =>
      key.startsWith("admin_access_"),
    );
    expect(keys.length).toBeGreaterThan(40);
    for (const key of keys) {
      expect(zh[key], key).toBeTruthy();
      expect(zh[key], key).not.toBe(en[key]);
    }
  });

  it("never claims client connectivity or that devices are enforced", () => {
    const preview = en["admin_access_preview_note"]!;
    expect(preview).toMatch(/not client connectivity/i);
    expect(en["admin_access_device_not_enforced"]).toMatch(/not currently/i);
    const claims = Object.entries(en).filter(
      ([key, text]) =>
        key.startsWith("admin_access_") &&
        /\b(reachable|connected)\b/i.test(text),
    );
    expect(claims).toEqual([]);
  });
});
