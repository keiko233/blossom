import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createEnrollmentGrantInputSchema,
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
      redeemEnrollmentBodySchema.safeParse({
        enrollmentGrant: secret,
        hostInfo: {
          hostname: "edge-1.example.test",
          ips: ["203.0.113.9"],
          os: "linux",
          arch: "x86_64",
          agentVersion: "1.5.0",
          installMode: "docker",
        },
      }).success,
    ).toBe(true);
    expect(
      redeemEnrollmentBodySchema.safeParse({
        enrollmentGrant: secret,
        hostInfo: { installMode: "podman" },
      }).success,
    ).toBe(false);
    expect(
      redeemEnrollmentBodySchema.safeParse({
        enrollmentGrant: secret,
        hostInfo: { privateKey: "not-a-field" },
      }).success,
    ).toBe(false);
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

describe("admin grant input", () => {
  it("requires explicit confirmation to replace the active identity", () => {
    const base = { serverId: "srv-a", mode: "replace" };
    expect(createEnrollmentGrantInputSchema.safeParse(base).success).toBe(
      false,
    );
    expect(
      createEnrollmentGrantInputSchema.safeParse({
        ...base,
        confirmReplace: false,
      }).success,
    ).toBe(false);
    expect(
      createEnrollmentGrantInputSchema.safeParse({
        ...base,
        confirmReplace: true,
      }).data,
    ).toMatchObject({ mode: "replace", capabilities: [], release: null });
  });

  it("does not need confirmation for a first enrollment", () => {
    expect(
      createEnrollmentGrantInputSchema.safeParse({
        serverId: "srv-a",
        mode: "enroll",
      }).success,
    ).toBe(true);
  });

  it("defaults to protected-stdin delivery and accepts only two modes", () => {
    const parsed = createEnrollmentGrantInputSchema.parse({
      serverId: "srv-a",
      mode: "enroll",
    });
    expect(parsed.delivery).toBe("stdin");
    expect(
      createEnrollmentGrantInputSchema.safeParse({
        serverId: "srv-a",
        mode: "enroll",
        delivery: "inline",
      }).success,
    ).toBe(true);
    expect(
      createEnrollmentGrantInputSchema.safeParse({
        serverId: "srv-a",
        mode: "enroll",
        delivery: "url",
      }).success,
    ).toBe(false);
  });

  it("keeps capability names and release labels to a safe shape", () => {
    const parse = (input: object) =>
      createEnrollmentGrantInputSchema.safeParse({
        serverId: "srv-a",
        mode: "enroll",
        ...input,
      }).success;
    expect(parse({ capabilities: ["ws", "log.tail"] })).toBe(true);
    expect(parse({ capabilities: ["Bad Name"] })).toBe(false);
    expect(parse({ release: "v1.2.3" })).toBe(true);
    expect(parse({ release: "x".repeat(65) })).toBe(false);
  });
});
