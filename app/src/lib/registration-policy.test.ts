import { describe, expect, it } from "vitest";

import {
  emailDomain,
  evaluateRegistration,
  isEmailDomainAllowed,
  normalizeDomainPattern,
  REGISTRATION_ERROR_CODES,
  registrationReasonFromErrorCode,
} from "./registration-policy";

describe("normalizeDomainPattern", () => {
  it("lower-cases, trims and drops a leading @ or trailing dot", () => {
    expect(normalizeDomainPattern("  Example.COM ")).toBe("example.com");
    expect(normalizeDomainPattern("@example.com")).toBe("example.com");
    expect(normalizeDomainPattern("example.com.")).toBe("example.com");
  });

  it("keeps a wildcard prefix, which may sit on a bare TLD", () => {
    expect(normalizeDomainPattern("*.Example.com")).toBe("*.example.com");
    expect(normalizeDomainPattern("*.edu")).toBe("*.edu");
  });

  it("rejects things that are not domains", () => {
    for (const bad of [
      "",
      "localhost",
      "edu",
      "exa mple.com",
      "-a.com",
      "a..com",
      "*.",
      "*example.com",
      "foo@bar.com",
      "https://example.com",
      "a.*.com",
    ]) {
      expect(normalizeDomainPattern(bad), bad).toBeNull();
    }
  });
});

describe("emailDomain", () => {
  it("returns the lower-cased domain after the last @", () => {
    expect(emailDomain("User@Example.COM")).toBe("example.com");
    expect(emailDomain('"a@b"@example.com')).toBe("example.com");
  });

  it("returns null without a usable domain", () => {
    expect(emailDomain("nobody")).toBeNull();
    expect(emailDomain("@example.com")).toBeNull();
    expect(emailDomain("user@")).toBeNull();
    expect(emailDomain("user@localhost")).toBeNull();
  });
});

describe("isEmailDomainAllowed", () => {
  it("allows everything for an empty list", () => {
    expect(isEmailDomainAllowed("a@anything.org", [])).toBe(true);
    expect(isEmailDomainAllowed("garbage", [])).toBe(true);
  });

  it("matches exactly, ignoring case", () => {
    const list = ["example.com"];
    expect(isEmailDomainAllowed("a@example.com", list)).toBe(true);
    expect(isEmailDomainAllowed("A@EXAMPLE.Com", list)).toBe(true);
    expect(isEmailDomainAllowed("a@other.com", list)).toBe(false);
  });

  it("does not let an exact entry match subdomains or look-alikes", () => {
    const list = ["example.com"];
    expect(isEmailDomainAllowed("a@mail.example.com", list)).toBe(false);
    expect(isEmailDomainAllowed("a@notexample.com", list)).toBe(false);
    expect(isEmailDomainAllowed("a@example.com.evil.io", list)).toBe(false);
  });

  it("matches subdomains, and only subdomains, for a wildcard entry", () => {
    const list = ["*.example.com"];
    expect(isEmailDomainAllowed("a@mail.example.com", list)).toBe(true);
    expect(isEmailDomainAllowed("a@x.y.example.com", list)).toBe(true);
    expect(isEmailDomainAllowed("a@example.com", list)).toBe(false);
    expect(isEmailDomainAllowed("a@badexample.com", list)).toBe(false);
  });

  it("supports mixed lists and re-normalizes sloppy entries", () => {
    const list = ["@Example.com", "*.Corp.IO"];
    expect(isEmailDomainAllowed("a@example.com", list)).toBe(true);
    expect(isEmailDomainAllowed("a@eu.corp.io", list)).toBe(true);
    expect(isEmailDomainAllowed("a@corp.io", list)).toBe(false);
  });

  it("rejects an address with no domain when a list is set", () => {
    expect(isEmailDomainAllowed("nobody", ["example.com"])).toBe(false);
  });

  it("ignores unusable entries instead of matching everything", () => {
    expect(isEmailDomainAllowed("a@example.com", ["not a domain"])).toBe(false);
  });
});

describe("registrationReasonFromErrorCode", () => {
  it("round-trips the codes the gate rejects with", () => {
    expect(
      registrationReasonFromErrorCode(REGISTRATION_ERROR_CODES.closed),
    ).toBe("closed");
    expect(
      registrationReasonFromErrorCode(
        REGISTRATION_ERROR_CODES.domain_not_allowed,
      ),
    ).toBe("domain_not_allowed");
  });

  it("ignores anything else", () => {
    expect(registrationReasonFromErrorCode("account_not_linked")).toBeNull();
    expect(registrationReasonFromErrorCode(null)).toBeNull();
    expect(registrationReasonFromErrorCode(undefined)).toBeNull();
  });
});

describe("evaluateRegistration", () => {
  const open = { mode: "open", allowedEmailDomains: [] } as const;

  it("allows everyone when open with no domain list", () => {
    for (const method of ["email-password", "magic-link", "oauth"]) {
      expect(evaluateRegistration(open, { email: "a@b.co", method })).toEqual({
        allowed: true,
      });
    }
  });

  it("denies every self-service method when closed", () => {
    const closed = { ...open, mode: "closed" } as const;
    for (const method of ["email-password", "magic-link", "oauth"]) {
      expect(evaluateRegistration(closed, { email: "a@b.co", method })).toEqual(
        { allowed: false, reason: "closed" },
      );
    }
  });

  it("applies the domain list to every self-service method", () => {
    const policy = { mode: "open", allowedEmailDomains: ["corp.io"] } as const;
    expect(
      evaluateRegistration(policy, { email: "a@corp.io", method: "oauth" }),
    ).toEqual({ allowed: true });
    expect(
      evaluateRegistration(policy, { email: "a@gmail.com", method: "oauth" }),
    ).toEqual({ allowed: false, reason: "domain_not_allowed" });
  });

  it("reports closed ahead of the domain", () => {
    expect(
      evaluateRegistration(
        { mode: "closed", allowedEmailDomains: ["corp.io"] },
        { email: "a@gmail.com", method: "magic-link" },
      ),
    ).toEqual({ allowed: false, reason: "closed" });
  });

  it("never restricts admin-created accounts", () => {
    expect(
      evaluateRegistration(
        { mode: "closed", allowedEmailDomains: ["corp.io"] },
        { email: "a@gmail.com", method: "admin" },
      ),
    ).toEqual({ allowed: true });
  });
});
