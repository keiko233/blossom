/**
 * Lightweight parser for proxy-client User-Agent strings. No external libraries:
 * the list is small and changes infrequently, so a few regexes are enough.
 */

interface ClientPattern {
  name: string;
  regex: RegExp;
}

// Order matters: more specific names first, generic fallbacks last.
const CLIENT_PATTERNS: ClientPattern[] = [
  { name: "mihomo", regex: /mihomo[\s/]v?([\d.]+)?/i },
  { name: "Clash Meta", regex: /clash\.meta[\s/]v?([\d.]+)?/i },
  {
    name: "Clash Meta for Android",
    regex: /ClashMetaForAndroid[\s/]v?([\d.]+)?/i,
  },
  { name: "Clash Verge", regex: /clash[-\s]?verge[\s/]v?([\d.]+)?/i },
  { name: "Clash Nyanpasu", regex: /clash[-\s]?nyanpasu[\s/]v?([\d.]+)?/i },
  { name: "ClashX Pro", regex: /ClashX\sPro[\s/]v?([\d.]+)?/i },
  { name: "ClashX", regex: /ClashX[\s/]v?([\d.]+)?/i },
  { name: "Stash", regex: /Stash[\s/]v?([\d.]+)?/i },
  { name: "Shadowrocket", regex: /Shadowrocket[\s/]v?([\d.]+)?/i },
  { name: "sing-box", regex: /sing-box[\s/]v?([\d.]+)?/i },
  { name: "SFA", regex: /SFA[\s/]v?([\d.]+)?/i },
  { name: "SFI", regex: /SFI[\s/]v?([\d.]+)?/i },
  { name: "SFM", regex: /SFM[\s/]v?([\d.]+)?/i },
  { name: "Surge", regex: /Surge[\s/]v?([\d.]+)?/i },
  { name: "Quantumult X", regex: /Quantumult%20X[\s/]v?([\d.]+)?/i },
  { name: "Quantumult", regex: /Quantumult[\s/]v?([\d.]+)?/i },
  { name: "Loon", regex: /Loon[\s/]v?([\d.]+)?/i },
  { name: "v2rayNG", regex: /v2rayNG[\s/]v?([\d.]+)?/i },
  { name: "v2rayN", regex: /v2rayN[\s/]v?([\d.]+)?/i },
  { name: "NekoBox", regex: /NekoBox[\s/]v?([\d.]+)?/i },
  { name: "Hiddify", regex: /Hiddify[\s/]v?([\d.]+)?/i },
  { name: "Karing", regex: /Karing[\s/]v?([\d.]+)?/i },
  { name: "FlClash", regex: /FlClash[\s/]v?([\d.]+)?/i },
  { name: "Clash", regex: /Clash(?:For\w*)?[\s/]v?([\d.]+)?/i },
  { name: "curl", regex: /curl[\s/]v?([\d.]+)?/i },
  { name: "wget", regex: /wget[\s/]v?([\d.]+)?/i },
];

export interface ParsedUserAgent {
  clientName: string | null;
  clientVersion: string | null;
}

/**
 * Extracts a friendly client name and version from a User-Agent (or Accept)
 * header. Returns nulls when the string is empty or unrecognized.
 */
export function parseClientUserAgent(
  userAgent: string | null | undefined,
): ParsedUserAgent {
  if (!userAgent || userAgent.trim().length === 0) {
    return { clientName: null, clientVersion: null };
  }

  for (const { name, regex } of CLIENT_PATTERNS) {
    const match = regex.exec(userAgent);
    if (match) {
      const version = match[1]?.trim() || null;
      return { clientName: name, clientVersion: version };
    }
  }

  return { clientName: null, clientVersion: null };
}
