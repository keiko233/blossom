import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notifyAgentAcmeDnsAck: vi.fn(
    async (_serverId: string, _payload: unknown) => undefined,
  ),
}));

vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/lib/agent-notifications", () => ({
  notifyAgentAcmeDnsAck: mocks.notifyAgentAcmeDnsAck,
  notifyAgentAcmeIssue: vi.fn(),
  notifyAgentConfigChanged: vi.fn(),
}));
vi.mock("@/lib/dns-providers/cloudflare", () => ({
  getCloudflareDnsProvider: () => null,
}));
vi.mock("@/query/agent", () => ({
  invalidateDesiredConfigRevisionsAfterCommit: vi.fn(),
}));

import { handleAcmeDnsPresent } from "./certificate-issuance";

const FQDN = "_acme-challenge.example.com";
const TXT = "token-value";

function job(providerRecordId: string | null) {
  return {
    id: "job-1",
    certificateId: "cert-1",
    issuerServerId: "srv-1",
    generation: 3,
    state: "awaiting_dns",
    domains: ["example.com"],
    challengeExpiresAt: new Date(Date.now() + 60_000),
    dnsRecords: [{ fqdn: FQDN, value: TXT, providerRecordId }],
  };
}

/** Answers the job read, then the policy read, in order. */
function databaseReading(
  jobRow: ReturnType<typeof job>,
  policy: Record<string, unknown>,
) {
  const results = [[jobRow], [policy]];
  const update = vi.fn();
  return {
    update,
    select: () => ({
      from: () => ({ where: async () => results.shift() ?? [] }),
    }),
  };
}

beforeEach(() => {
  mocks.notifyAgentAcmeDnsAck.mockClear();
});

describe("manual DNS-01 present retry", () => {
  it("re-acknowledges a retried record once the operator approved it", async () => {
    const database = databaseReading(job(null), {
      id: "cert-1",
      desiredGeneration: 3,
      challengeApprovedAt: new Date(),
    });

    await handleAcmeDnsPresent(
      "srv-1",
      { jobId: "job-1", fqdn: FQDN, txtValue: TXT },
      database as never,
    );

    expect(mocks.notifyAgentAcmeDnsAck).toHaveBeenCalledWith(
      "srv-1",
      expect.objectContaining({ accepted: true }),
    );
    expect(database.update).not.toHaveBeenCalled();
  });

  it("stays silent for a manual record the operator has not approved", async () => {
    const database = databaseReading(job(null), {
      id: "cert-1",
      desiredGeneration: 3,
      challengeApprovedAt: null,
    });

    await handleAcmeDnsPresent(
      "srv-1",
      { jobId: "job-1", fqdn: FQDN, txtValue: TXT },
      database as never,
    );

    expect(mocks.notifyAgentAcmeDnsAck).not.toHaveBeenCalled();
  });

  it("re-acknowledges a record the DNS provider already created", async () => {
    const database = databaseReading(job("provider-record-1"), {
      id: "cert-1",
      desiredGeneration: 3,
      challengeApprovedAt: null,
    });

    await handleAcmeDnsPresent(
      "srv-1",
      { jobId: "job-1", fqdn: FQDN, txtValue: TXT },
      database as never,
    );

    expect(mocks.notifyAgentAcmeDnsAck).toHaveBeenCalledWith(
      "srv-1",
      expect.objectContaining({ accepted: true }),
    );
  });
});
