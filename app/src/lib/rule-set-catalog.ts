/**
 * Curated rule-set catalog.
 *
 * Only entries listed here may be fetched by the control plane. The catalog is
 * deliberately small, version-pinned and pointed at the official SagerNet
 * `rule-set` branches so a request can never turn into an arbitrary URL or
 * filesystem fetch. Imported bytes are still hashed and stored as opaque `.srs`
 * assets; the agent verifies them offline before use.
 */

export const CURATED_RULE_SET_CATEGORIES = [
  "speedtest",
  "ai",
  "streaming",
  "region",
  "private",
] as const;

export type CuratedRuleSetCategory =
  (typeof CURATED_RULE_SET_CATEGORIES)[number];

export interface CuratedRuleSetEntry {
  id: string;
  category: CuratedRuleSetCategory;
  /** Provenance recorded on the imported asset, without a URL or scheme. */
  source: string;
  /** The only URL the importer is allowed to request for this entry. */
  url: string;
  defaultVersion: string;
}

const RULE_SET_VERSION = "2026.11.25";

const SING_GEOSITE_PREFIX =
  "https://raw.githubusercontent.com/SagerNet/sing-geosite/rule-set/";
const SING_GEOIP_PREFIX =
  "https://raw.githubusercontent.com/SagerNet/sing-geoip/rule-set/";

function geositeEntry(
  id: string,
  category: CuratedRuleSetCategory,
): CuratedRuleSetEntry {
  const file = `${id}.srs`;
  return {
    id,
    category,
    source: `SagerNet/sing-geosite@rule-set/${file}`,
    url: `${SING_GEOSITE_PREFIX}${file}`,
    defaultVersion: RULE_SET_VERSION,
  };
}

function geoipEntry(
  id: string,
  category: CuratedRuleSetCategory,
): CuratedRuleSetEntry {
  const file = `${id}.srs`;
  return {
    id,
    category,
    source: `SagerNet/sing-geoip@rule-set/${file}`,
    url: `${SING_GEOIP_PREFIX}${file}`,
    defaultVersion: RULE_SET_VERSION,
  };
}

/**
 * Transit/exit splitting presets. Categories group the entries in the admin UI;
 * `region` also carries broad service sets that are not a vertical (Google).
 */
export const CURATED_RULE_SET_CATALOG: readonly CuratedRuleSetEntry[] = [
  geositeEntry("geosite-category-speedtest", "speedtest"),
  geositeEntry("geosite-openai", "ai"),
  geositeEntry("geosite-anthropic", "ai"),
  geositeEntry("geosite-netflix", "streaming"),
  geositeEntry("geosite-disney", "streaming"),
  geositeEntry("geosite-google", "region"),
  geoipEntry("geoip-cn", "region"),
  geositeEntry("geosite-cn", "region"),
  geoipEntry("geoip-private", "private"),
  geositeEntry("geosite-private", "private"),
];

/** Pure catalog lookup; unknown ids are rejected by callers, never derived. */
export function findCuratedRuleSetEntry(
  id: string,
): CuratedRuleSetEntry | undefined {
  return CURATED_RULE_SET_CATALOG.find((entry) => entry.id === id);
}

/** True only for an official SagerNet `rule-set` `.srs` URL. */
export function isCuratedRuleSetUrl(url: string): boolean {
  return (
    (url.startsWith(SING_GEOSITE_PREFIX) ||
      url.startsWith(SING_GEOIP_PREFIX)) &&
    url.endsWith(".srs") &&
    !url.includes("..") &&
    !/[\s?#]/.test(url)
  );
}
