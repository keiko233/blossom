import { parseClientUserAgent } from "@/lib/user-agent";

const MAX_RAW_LENGTH = 80;

/** Browsers, most specific first: Edge/Opera UAs also say Chrome and Safari. */
const BROWSER_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "Edge", regex: /Edg(?:e|A|iOS)?\/([\d.]+)/ },
  { name: "Opera", regex: /OPR\/([\d.]+)/ },
  { name: "Firefox", regex: /(?:Firefox|FxiOS)\/([\d.]+)/ },
  { name: "Chrome", regex: /(?:Chrome|CriOS)\/([\d.]+)/ },
  { name: "Safari", regex: /Version\/([\d.]+).*Safari\// },
];

/** Operating systems; Android and iOS before the desktop systems they mimic. */
const OS_PATTERNS: { name: string; regex: RegExp }[] = [
  { name: "Android", regex: /Android/ },
  { name: "iOS", regex: /iPhone|iPad|iPod/ },
  { name: "Windows", regex: /Windows/ },
  { name: "macOS", regex: /Mac OS X|Macintosh/ },
  { name: "Linux", regex: /Linux|X11/ },
];

/**
 * Short label for a session's User-Agent, e.g. "Chrome 126 · Windows". Falls
 * back to a proxy-client name (`parseClientUserAgent`), then to the truncated
 * raw string; null when there is no User-Agent at all.
 */
export function describeSessionUserAgent(
  userAgent: string | null | undefined,
): string | null {
  const raw = userAgent?.trim();
  if (!raw) return null;

  for (const { name, regex } of BROWSER_PATTERNS) {
    const version = regex.exec(raw)?.[1];
    if (version === undefined) continue;
    const label = `${name} ${version.split(".")[0]}`;
    const os = OS_PATTERNS.find((pattern) => pattern.regex.test(raw));
    return os ? `${label} · ${os.name}` : label;
  }

  const client = parseClientUserAgent(raw);
  if (client.clientName) {
    return client.clientVersion
      ? `${client.clientName} ${client.clientVersion}`
      : client.clientName;
  }

  return raw.length > MAX_RAW_LENGTH ? `${raw.slice(0, MAX_RAW_LENGTH)}…` : raw;
}
