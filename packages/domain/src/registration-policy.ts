/**
 * Who may create an account on their own. Pure: the settings come in as
 * arguments, so the better-auth hook, the sign-up server function and the tests
 * all share one decision.
 */

export type RegistrationMode = "open" | "closed";

/** How an account is being created (better-auth's `source.method`, loosely). */
export type RegistrationMethod =
  | "admin"
  | "email-password"
  | "magic-link"
  | "oauth"
  | (string & {});

export type RegistrationDenyReason = "closed" | "domain_not_allowed";

export type RegistrationDecision =
  | { allowed: true }
  | { allowed: false; reason: RegistrationDenyReason };

/**
 * Error codes the registration gate rejects with. They surface to the browser
 * as `?error=<code>` on the redirect back from an email link or OAuth sign-in,
 * and as the `code` of the 403 for direct API calls.
 */
export const REGISTRATION_ERROR_CODES = {
  closed: "registration_closed",
  domain_not_allowed: "registration_domain_not_allowed",
} as const satisfies Record<RegistrationDenyReason, string>;

/** English fallback text for API callers; the UI shows localized copy. */
export const REGISTRATION_ERROR_DESCRIPTIONS = {
  closed: "Registration is closed",
  domain_not_allowed: "This email domain is not allowed to register",
} as const satisfies Record<RegistrationDenyReason, string>;

/** The deny reason behind a `?error=` code from the sign-in redirect, if any. */
export function registrationReasonFromErrorCode(
  code: string | null | undefined,
): RegistrationDenyReason | null {
  for (const [reason, value] of Object.entries(REGISTRATION_ERROR_CODES)) {
    if (value === code) return reason as RegistrationDenyReason;
  }
  return null;
}

export interface RegistrationPolicy {
  mode: RegistrationMode;
  allowedEmailDomains: readonly string[];
}

/** Only a DNS-style host name: labels of letters, digits and inner hyphens. */
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const DOMAIN_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})+$`);
/** A wildcard's base may be a single label, i.e. a whole TLD (`*.edu`). */
const WILDCARD_BASE_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

/**
 * Normalizes an allow-list entry, or returns null when it is not one.
 *
 * - `example.com` matches exactly that domain, not its subdomains.
 * - `*.example.com` matches any subdomain (`a.example.com`, `a.b.example.com`)
 *   but not `example.com` itself. List both to allow both. A wildcard may sit
 *   on a bare TLD: `*.edu` allows every `.edu` address.
 *
 * Entries are trimmed and lower-cased; a leading `@` (as in `@example.com`) is
 * accepted and dropped, as is a trailing dot.
 */
export function normalizeDomainPattern(input: string): string | null {
  let value = input.trim().toLowerCase();
  if (value.startsWith("@")) value = value.slice(1);
  if (value.endsWith(".")) value = value.slice(0, -1);
  const wildcard = value.startsWith("*.");
  const host = wildcard ? value.slice(2) : value;
  if (host.length > 253) return null;
  if (!(wildcard ? WILDCARD_BASE_RE : DOMAIN_RE).test(host)) return null;
  return wildcard ? `*.${host}` : host;
}

/** The lower-cased domain of an address, or null when it has no usable one. */
export function emailDomain(email: string): string | null {
  const value = email.trim().toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1) return null;
  let domain = value.slice(at + 1);
  if (domain.endsWith(".")) domain = domain.slice(0, -1);
  return DOMAIN_RE.test(domain) ? domain : null;
}

/**
 * Whether the address's domain is on the allow-list. An empty list allows
 * every domain. Patterns are expected normalized (`normalizeDomainPattern`),
 * but are re-normalized here so a hand-edited row cannot silently never match.
 */
export function isEmailDomainAllowed(
  email: string,
  allowedDomains: readonly string[],
): boolean {
  if (allowedDomains.length === 0) return true;
  const domain = emailDomain(email);
  if (!domain) return false;
  return allowedDomains.some((entry) => {
    const pattern = normalizeDomainPattern(entry);
    if (!pattern) return false;
    return pattern.startsWith("*.")
      ? domain.endsWith(pattern.slice(1))
      : domain === pattern;
  });
}

/**
 * Decides a self-service account creation. Admin-created accounts are never
 * restricted: an admin can always add anyone, in a closed registration and
 * regardless of the domain list.
 */
export function evaluateRegistration(
  policy: RegistrationPolicy,
  attempt: { email: string; method: RegistrationMethod },
): RegistrationDecision {
  if (attempt.method === "admin") return { allowed: true };
  if (policy.mode === "closed") return { allowed: false, reason: "closed" };
  if (!isEmailDomainAllowed(attempt.email, policy.allowedEmailDomains)) {
    return { allowed: false, reason: "domain_not_allowed" };
  }
  return { allowed: true };
}
