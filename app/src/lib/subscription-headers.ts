/**
 * Response headers of the Clash subscription endpoint that depend on the
 * subscription-output settings. The defaults reproduce the headers the
 * endpoint always sent (`blossom.yaml`, 24 hours).
 */

export const DEFAULT_PROFILE_TITLE = "blossom";
export const DEFAULT_PROFILE_UPDATE_INTERVAL_HOURS = 24;

/** Printable ASCII other than the characters a quoted filename must escape. */
const PLAIN_FILENAME_RE = /^[\x20-\x7e]+$/;

/** RFC 5987 `attr-char` encoding: stricter than `encodeURIComponent`. */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * `Content-Disposition` for the downloaded profile. Clash clients use the file
 * name as the profile's name. A plain ASCII title yields the single
 * `filename="<title>.yaml"` form; anything else adds an ASCII fallback plus an
 * RFC 6266 `filename*` carrying the real name. Quotes, backslashes and control
 * characters never reach the header (they are rejected by the settings schema,
 * and replaced here regardless).
 */
export function buildContentDisposition(title: string): string {
  const cleaned = Array.from(title, (char) => {
    const point = char.codePointAt(0)!;
    return point < 0x20 || point === 0x7f || '"\\/'.includes(char) ? " " : char;
  })
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  const stem = cleaned || DEFAULT_PROFILE_TITLE;
  const filename = `${stem}.yaml`;

  if (PLAIN_FILENAME_RE.test(filename)) {
    return `attachment; filename="${filename}"`;
  }

  const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
  const fallback = /[a-z0-9]/i.test(ascii.replace(/\.yaml$/, ""))
    ? ascii
    : `${DEFAULT_PROFILE_TITLE}.yaml`;
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRfc5987(filename)}`;
}

/** `Profile-Update-Interval` value: whole hours, at least 1. */
export function buildProfileUpdateInterval(hours: number): string {
  return String(
    Number.isFinite(hours) && hours >= 1
      ? Math.floor(hours)
      : DEFAULT_PROFILE_UPDATE_INTERVAL_HOURS,
  );
}
