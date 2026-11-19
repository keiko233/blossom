import { describe, expect, it } from "vitest";

import {
  currentIdentities,
  enrollmentCreateBlock,
  grantDisplayStatus,
  installationPhase,
  latestEnrollmentGrant,
  REDEMPTION_STALE_MS,
} from "./agent-connection";

const NOW = Date.parse("2026-11-19T12:00:00Z");

function grant(
  overrides: Partial<Parameters<typeof grantDisplayStatus>[0]> = {},
) {
  return {
    id: "grant-1",
    status: "issued",
    createdAt: new Date(NOW - 60_000),
    claimedAt: null,
    expiresAt: new Date(NOW + 5 * 60_000),
    ...overrides,
  };
}

describe("grantDisplayStatus", () => {
  it("reports an unclaimed grant as ready until its expiry", () => {
    expect(grantDisplayStatus(grant(), NOW)).toBe("issued");
  });

  it("reports an unclaimed grant past its expiry as expired", () => {
    expect(
      grantDisplayStatus(grant({ expiresAt: new Date(NOW - 1) }), NOW),
    ).toBe("expired");
  });

  it("preserves claim, redemption and revocation status", () => {
    expect(grantDisplayStatus(grant({ status: "redeeming" }), NOW)).toBe(
      "redeeming",
    );
    expect(grantDisplayStatus(grant({ status: "redeemed" }), NOW)).toBe(
      "redeemed",
    );
    expect(grantDisplayStatus(grant({ status: "revoked" }), NOW)).toBe(
      "revoked",
    );
  });
});

describe("latestEnrollmentGrant", () => {
  it("selects the newest grant regardless of input order", () => {
    const older = grant({ id: "older", createdAt: new Date(NOW - 60_000) });
    const newer = grant({ id: "newer", createdAt: new Date(NOW - 1_000) });
    expect(latestEnrollmentGrant([older, newer])?.id).toBe("newer");
  });
});

describe("installationPhase", () => {
  it("starts empty when there are no identities or grants", () => {
    expect(installationPhase({ identities: [], grants: [] }, NOW)).toBe(
      "not_started",
    );
  });

  it("reports a ready grant before it is redeemed", () => {
    expect(installationPhase({ identities: [], grants: [grant()] }, NOW)).toBe(
      "grant_ready",
    );
  });

  it("reports a fresh redemption claim as in progress", () => {
    expect(
      installationPhase(
        {
          identities: [],
          grants: [
            grant({
              status: "redeeming",
              claimedAt: new Date(NOW - 60_000),
            }),
          ],
        },
        NOW,
      ),
    ).toBe("redeeming");
  });

  it("turns a stale or orphaned claim into a failed state", () => {
    expect(
      installationPhase(
        {
          identities: [],
          grants: [
            grant({
              status: "redeeming",
              claimedAt: new Date(NOW - REDEMPTION_STALE_MS - 1),
            }),
          ],
        },
        NOW,
      ),
    ).toBe("failed");
    expect(
      installationPhase(
        {
          identities: [],
          grants: [grant({ status: "redeemed" })],
        },
        NOW,
      ),
    ).toBe("failed");
  });

  it("keeps pending credentials distinct from an active identity", () => {
    expect(
      installationPhase(
        { identities: [{ status: "pending" }], grants: [] },
        NOW,
      ),
    ).toBe("pending_activation");
    expect(
      installationPhase(
        {
          identities: [{ status: "active" }, { status: "pending" }],
          grants: [],
        },
        NOW,
      ),
    ).toBe("active");
  });

  it("reports expired and revoked attempts as retryable states", () => {
    expect(
      installationPhase(
        {
          identities: [],
          grants: [grant({ expiresAt: new Date(NOW - 1) })],
        },
        NOW,
      ),
    ).toBe("expired");
    expect(
      installationPhase(
        { identities: [], grants: [grant({ status: "revoked" })] },
        NOW,
      ),
    ).toBe("revoked");
  });
});

describe("enrollmentCreateBlock", () => {
  it("blocks disabled servers and pending identities", () => {
    expect(
      enrollmentCreateBlock({ serverEnabled: false, identities: [] }),
    ).toBe("server_disabled");
    expect(
      enrollmentCreateBlock({
        serverEnabled: true,
        identities: [{ status: "pending" }],
      }),
    ).toBe("pending_identity");
    expect(
      enrollmentCreateBlock({ serverEnabled: true, identities: [] }),
    ).toBeNull();
  });

  it("allows a replacement while an active identity exists", () => {
    expect(
      enrollmentCreateBlock({
        serverEnabled: true,
        identities: [{ status: "active" }],
      }),
    ).toBeNull();
  });
});

describe("currentIdentities", () => {
  it("reports active and pending generations independently", () => {
    const active = { id: "old", status: "active", generation: 1 };
    const pending = { id: "new", status: "pending", generation: 2 };

    expect(currentIdentities([active, pending])).toEqual({ active, pending });
    expect(currentIdentities([active])).toEqual({ active, pending: null });
    expect(currentIdentities([])).toEqual({ active: null, pending: null });
  });
});
