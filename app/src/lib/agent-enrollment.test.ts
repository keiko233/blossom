import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  generateEnrollmentGrant,
  generateMachineCredential,
  hashEnrollmentGrantSecret,
  hashMachineClientSecret,
  redeemEnrollmentBodySchema,
} from "./agent-enrollment";

describe("enrollment grant secrets", () => {
  it("generates a prefixed 256-bit secret whose stored form is only its hash", () => {
    const grant = generateEnrollmentGrant();
    expect(grant.secret).toMatch(/^egr_[A-Za-z0-9_-]{43}$/);
    expect(grant.tokenHash).toBe(hashEnrollmentGrantSecret(grant.secret));
    expect(grant.tokenHash).not.toContain(grant.secret);
    expect(generateEnrollmentGrant().secret).not.toBe(grant.secret);
  });

  it("accepts only the generated shape in the redeem body", () => {
    const { secret } = generateEnrollmentGrant();
    expect(
      redeemEnrollmentBodySchema.safeParse({ enrollmentGrant: secret }).success,
    ).toBe(true);
    expect(
      redeemEnrollmentBodySchema.safeParse({ enrollmentGrant: "egr_short" })
        .success,
    ).toBe(false);
    expect(
      redeemEnrollmentBodySchema.safeParse({
        enrollmentGrant: secret,
        extra: 1,
      }).success,
    ).toBe(false);
    expect(
      redeemEnrollmentBodySchema.safeParse({ enrollmentGrant: 42 }).success,
    ).toBe(false);
  });
});

describe("machine client credentials", () => {
  it("stores the provider's base64url SHA-256 form of the secret", () => {
    const credential = generateMachineCredential();
    expect(credential.clientId).toMatch(/^agent_[A-Za-z0-9_-]+$/);
    expect(credential.clientSecret).toMatch(/^ags_[A-Za-z0-9_-]{43}$/);
    expect(credential.secretHash).toBe(
      createHash("sha256").update(credential.clientSecret).digest("base64url"),
    );
    expect(hashMachineClientSecret("fake-value")).not.toContain("fake-value");
  });
});
