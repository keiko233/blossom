import type { AcmeProvider } from "@/db/proxy-schema";

export const ACME_PROVIDER_ENV_REQUIREMENTS = {
  letsencrypt: [],
  zerossl: ["ACME_EAB_KID", "ACME_EAB_HMAC_KEY"],
} as const satisfies Record<AcmeProvider, readonly string[]>;
