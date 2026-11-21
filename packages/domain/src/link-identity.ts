/**
 * Namespace for peer-link identities on sing-box peer inbounds.
 *
 * Peer traffic must never be attributed to a subscriber. The subscriber codec
 * uses the `blz.1.` prefix, while a link identity deliberately starts with
 * `blz.peer.1.` and therefore never decodes as one. The generation is part of
 * the name so the old and new receiver admissions remain distinct while a
 * credential rotates.
 *
 * Wire format (ASCII):
 *   `blz.peer.1.{l1}.{l2}.{linkId}{generation}`
 * where `l1`/`l2` are decimal lengths of the link id and the generation text.
 */
export const PEER_LINK_IDENTITY_PREFIX = "blz.peer.1." as const;

export function encodePeerLinkIdentity(
  linkId: string,
  generation: number,
): string {
  if (linkId.length === 0) {
    throw new Error("Peer link id must not be empty");
  }
  if (!Number.isInteger(generation) || generation < 1) {
    throw new Error(
      "Peer link credential generation must be a positive integer",
    );
  }
  const generationText = String(generation);
  return `${PEER_LINK_IDENTITY_PREFIX}${linkId.length}.${generationText.length}.${linkId}${generationText}`;
}

/** True for an inbound user name owned by a peer link, not a subscriber. */
export function isPeerLinkIdentity(value: string): boolean {
  return value.startsWith(PEER_LINK_IDENTITY_PREFIX);
}

/** Decoded link identity; `generation` is 0 when the tail is malformed. */
export interface DecodedPeerLinkIdentity {
  linkId: string;
  generation: number;
}

export function decodePeerLinkIdentity(
  value: string,
): DecodedPeerLinkIdentity | null {
  if (!isPeerLinkIdentity(value)) {
    return null;
  }
  const rest = value.slice(PEER_LINK_IDENTITY_PREFIX.length);
  const firstDot = rest.indexOf(".");
  const secondDot = rest.indexOf(".", firstDot + 1);
  if (firstDot <= 0 || secondDot <= firstDot + 1) {
    return null;
  }
  const linkLength = Number.parseInt(rest.slice(0, firstDot), 10);
  const generationLength = Number.parseInt(
    rest.slice(firstDot + 1, secondDot),
    10,
  );
  if (
    !Number.isInteger(linkLength) ||
    linkLength <= 0 ||
    !Number.isInteger(generationLength) ||
    generationLength <= 0
  ) {
    return null;
  }
  const payload = rest.slice(secondDot + 1);
  if (payload.length !== linkLength + generationLength) {
    return null;
  }
  const linkId = payload.slice(0, linkLength);
  const generationText = payload.slice(linkLength);
  if (!/^\d+$/.test(generationText)) {
    return null;
  }
  const generation = Number.parseInt(generationText, 10);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    return null;
  }
  return { linkId, generation };
}
