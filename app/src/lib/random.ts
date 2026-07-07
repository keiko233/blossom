/**
 * Browser-side random generators (Web Crypto). Server-side token hashing lives in
 * `@/lib/agent-token`. Safe to call from client components.
 */

export function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomPassword(bytes = 24): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return btoa(String.fromCharCode(...arr));
}

export function randomUuid(): string {
  return crypto.randomUUID();
}
