import { describe, expect, it } from "vitest";

import {
  ACME_PROVIDER_ENV_REQUIREMENTS,
  LETS_ENCRYPT_PRODUCTION_DIRECTORY,
  LETS_ENCRYPT_STAGING_DIRECTORY,
  ZEROSSL_PRODUCTION_DIRECTORY,
  acmeDirectory,
  isLetsEncryptDirectoryTlsFailure,
  letsEncryptDirectory,
} from "./acme-directory";

describe("letsEncryptDirectory", () => {
  it("selects the requested Let's Encrypt environment", () => {
    expect(letsEncryptDirectory(false)).toBe(LETS_ENCRYPT_PRODUCTION_DIRECTORY);
    expect(letsEncryptDirectory(true)).toBe(LETS_ENCRYPT_STAGING_DIRECTORY);
  });
});

describe("acmeDirectory", () => {
  it("selects Let's Encrypt production and staging directories", () => {
    expect(acmeDirectory("letsencrypt", false)).toBe(
      LETS_ENCRYPT_PRODUCTION_DIRECTORY,
    );
    expect(acmeDirectory("letsencrypt", true)).toBe(
      LETS_ENCRYPT_STAGING_DIRECTORY,
    );
  });

  it("selects ZeroSSL and exposes its deployment requirements", () => {
    expect(acmeDirectory("zerossl", false)).toBe(ZEROSSL_PRODUCTION_DIRECTORY);
    expect(ACME_PROVIDER_ENV_REQUIREMENTS.zerossl).toEqual([
      "ACME_EAB_KID",
      "ACME_EAB_HMAC_KEY",
    ]);
  });
});

describe("isLetsEncryptDirectoryTlsFailure", () => {
  it("recognizes the production directory 525 returned in Workers", () => {
    expect(
      isLetsEncryptDirectoryTlsFailure(
        new Error(
          `Attempting to read ACME directory returned error 525: ${LETS_ENCRYPT_PRODUCTION_DIRECTORY}`,
        ),
      ),
    ).toBe(true);
  });

  it("recognizes the same failure against the staging directory", () => {
    expect(
      isLetsEncryptDirectoryTlsFailure(
        `Error: Attempting to read ACME directory returned error 525: ${LETS_ENCRYPT_STAGING_DIRECTORY}`,
      ),
    ).toBe(true);
  });

  it("does not hide unrelated failures", () => {
    expect(
      isLetsEncryptDirectoryTlsFailure(
        new Error(
          `Attempting to read ACME directory returned error 500: ${LETS_ENCRYPT_PRODUCTION_DIRECTORY}`,
        ),
      ),
    ).toBe(false);
    expect(
      isLetsEncryptDirectoryTlsFailure(
        "Attempting to read ACME directory returned error 525: https://example.com/directory",
      ),
    ).toBe(false);
  });
});
