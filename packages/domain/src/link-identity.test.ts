import { describe, expect, it } from "vitest";

import {
  decodePeerLinkIdentity,
  encodePeerLinkIdentity,
  isPeerLinkIdentity,
} from "./link-identity";

describe("peer link identity", () => {
  it("round-trips link id and generation without colliding with the subscriber codec", () => {
    const identity = encodePeerLinkIdentity("link-a-to-b", 3);
    expect(identity).toBe("blz.peer.1.11.1.link-a-to-b3");
    expect(isPeerLinkIdentity(identity)).toBe(true);
    expect(decodePeerLinkIdentity(identity)).toEqual({
      linkId: "link-a-to-b",
      generation: 3,
    });
    // The subscriber codec only accepts `blz.1.`; a peer name cannot decode.
    expect(identity.startsWith("blz.1.")).toBe(false);
  });

  it("rejects malformed or empty identities", () => {
    expect(() => encodePeerLinkIdentity("", 1)).toThrow();
    expect(() => encodePeerLinkIdentity("link", 0)).toThrow();
    expect(isPeerLinkIdentity("blz.1.1.1.link1")).toBe(false);
    expect(decodePeerLinkIdentity("blz.peer.1.4.1.link1")).toEqual({
      linkId: "link",
      generation: 1,
    });
    expect(decodePeerLinkIdentity("blz.peer.1.4.2.link")).toBeNull();
    expect(decodePeerLinkIdentity("blz.peer.1.4.2.linkax")).toBeNull();
  });
});
