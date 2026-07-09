// Platform-specific headers are only trustworthy on their own platform, and the
// leftmost x-forwarded-for hop is client-controlled — acceptable here since the
// result is used for access logging only, never authorization.
const IP_HEADERS = [
  "cf-connecting-ip", // Cloudflare
  "x-nf-client-connection-ip", // Netlify
  "x-vercel-forwarded-for", // Vercel
  "x-real-ip", // nginx / common reverse proxies (Railway edge)
] as const;

export function getClientIp(request: Request): string | null {
  for (const header of IP_HEADERS) {
    const value = request.headers.get(header);
    if (value) return value.trim();
  }
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || null;
}
