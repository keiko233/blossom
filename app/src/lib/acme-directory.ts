import type { AcmeProvider } from "@/db/proxy-schema";

export const LETS_ENCRYPT_PRODUCTION_DIRECTORY =
  "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING_DIRECTORY =
  "https://acme-staging-v02.api.letsencrypt.org/directory";
export const ZEROSSL_PRODUCTION_DIRECTORY = "https://acme.zerossl.com/v2/DV90";

export const ACME_PROVIDER_ENV_REQUIREMENTS = {
  letsencrypt: [],
  zerossl: ["ACME_EAB_KID", "ACME_EAB_HMAC_KEY"],
} as const satisfies Record<AcmeProvider, readonly string[]>;

export function letsEncryptDirectory(staging: boolean): string {
  return staging
    ? LETS_ENCRYPT_STAGING_DIRECTORY
    : LETS_ENCRYPT_PRODUCTION_DIRECTORY;
}

export function acmeDirectory(
  provider: AcmeProvider,
  staging: boolean,
): string {
  return provider === "zerossl"
    ? ZEROSSL_PRODUCTION_DIRECTORY
    : letsEncryptDirectory(staging);
}

export function isLetsEncryptDirectoryTlsFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Attempting to read ACME directory returned error 525") &&
    (message.includes(LETS_ENCRYPT_PRODUCTION_DIRECTORY) ||
      message.includes(LETS_ENCRYPT_STAGING_DIRECTORY))
  );
}
