export function isValidCertificateDomain(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (
    !/^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(
      normalized,
    )
  ) {
    return false;
  }

  const topLevelDomain = normalized.slice(normalized.lastIndexOf(".") + 1);
  return /[a-z]/.test(topLevelDomain);
}

export function certificateCoversDomain(
  patterns: string[],
  hostname: string,
): boolean {
  const name = hostname.toLowerCase().replace(/\.$/, "");
  return patterns.some((pattern) => {
    const value = pattern.toLowerCase();
    if (!value.startsWith("*.")) return value === name;
    const suffix = value.slice(2);
    const prefix = name.slice(0, -(suffix.length + 1));
    return (
      name.endsWith(`.${suffix}`) && prefix.length > 0 && !prefix.includes(".")
    );
  });
}

export function isCertificateCurrentlyUsable(
  certificate: {
    activeMaterialVersion: number | null;
    notBefore: Date | null;
    notAfter: Date | null;
  },
  materialPresent: boolean,
  now = new Date(),
): boolean {
  return (
    materialPresent &&
    certificate.activeMaterialVersion !== null &&
    certificate.notBefore !== null &&
    certificate.notBefore <= now &&
    certificate.notAfter !== null &&
    certificate.notAfter > now
  );
}
