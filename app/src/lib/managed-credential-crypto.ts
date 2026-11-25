import {
  certificateMasterKey,
  decryptCertificateSecret,
  encryptCertificateSecret,
} from "./certificate-crypto";

/**
 * Dedicated AES-GCM envelope context for managed peer-link credentials. A
 * ciphertext is bound to the exact link and credential generation, so copying
 * a row to another link or generation, or replaying it after rotation, cannot
 * decrypt. The key itself is the deployment's certificate master key; the
 * purpose lives in the AAD.
 */
export function managedPeerCredentialAad(
  linkId: string,
  generation: number,
): string {
  if (linkId.length === 0) {
    throw new Error("Peer link id must not be empty");
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error("Peer credential generation must be a positive integer");
  }
  return `managed-peer-credential:${linkId}:${generation}`;
}

export function encryptManagedPeerCredential(
  linkId: string,
  generation: number,
  plaintext: string,
  key = certificateMasterKey(),
): string {
  return encryptCertificateSecret(
    plaintext,
    managedPeerCredentialAad(linkId, generation),
    key,
  );
}

export function decryptManagedPeerCredential(
  ciphertext: string,
  linkId: string,
  generation: number,
  key = certificateMasterKey(),
): string {
  return decryptCertificateSecret(
    ciphertext,
    managedPeerCredentialAad(linkId, generation),
    key,
  );
}

/**
 * Dedicated AES-GCM envelope context for a `custom_proxy` outbound's secret
 * field map. The ciphertext is bound to the row id, so copying it to another
 * outbound cannot decrypt. Secrets are a JSON object rather than a single
 * credential string because sing-box outbounds carry different secret fields
 * (`password`, `uuid`, `auth_str`, `private_key`, ...).
 */
export function managedCustomProxySecretAad(outboundId: string): string {
  if (outboundId.length === 0) {
    throw new Error("Custom proxy outbound id must not be empty");
  }
  return `managed-custom-proxy-secret:${outboundId}`;
}

export function encryptManagedCustomProxySecret(
  outboundId: string,
  secrets: Record<string, unknown>,
  key = certificateMasterKey(),
): string {
  return encryptCertificateSecret(
    JSON.stringify(secrets),
    managedCustomProxySecretAad(outboundId),
    key,
  );
}

export function decryptManagedCustomProxySecret(
  ciphertext: string,
  outboundId: string,
  key = certificateMasterKey(),
): Record<string, unknown> {
  const value: unknown = JSON.parse(
    decryptCertificateSecret(
      ciphertext,
      managedCustomProxySecretAad(outboundId),
      key,
    ),
  );
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Custom proxy secret payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}
