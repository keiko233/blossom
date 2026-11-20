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
