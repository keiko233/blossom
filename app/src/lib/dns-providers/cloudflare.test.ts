import { describe, expect, it, vi } from "vitest";

import { CloudflareDnsProvider } from "./cloudflare";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("CloudflareDnsProvider", () => {
  it("creates and deletes a TXT record with the configured zone", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: { id: "record-1" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: {} }));
    const provider = new CloudflareDnsProvider(
      "test-token",
      "test-zone",
      fetchMock,
    );

    await expect(
      provider.createTxt({
        fqdn: "_acme-challenge.example.com",
        value: "txt-digest",
      }),
    ).resolves.toBe("record-1");
    const [createUrl, createInit] = fetchMock.mock.calls[0]!;
    expect(String(createUrl)).toContain("/zones/test-zone/dns_records");
    expect(createInit?.method).toBe("POST");
    expect(JSON.parse(String(createInit?.body))).toEqual({
      type: "TXT",
      name: "_acme-challenge.example.com",
      content: "txt-digest",
      ttl: 60,
    });

    await provider.deleteTxt("record-1");
    const [deleteUrl, deleteInit] = fetchMock.mock.calls[1]!;
    expect(String(deleteUrl)).toContain("/dns_records/record-1");
    expect(deleteInit?.method).toBe("DELETE");
  });

  it("rejects unsafe record ids and API failures without exposing the token", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(
          { success: false, errors: [{ message: "zone denied" }] },
          403,
        ),
      );
    const provider = new CloudflareDnsProvider(
      "test-token",
      "test-zone",
      fetchMock,
    );

    await expect(provider.deleteTxt("../record")).rejects.toThrow(
      "Invalid Cloudflare DNS record id",
    );
    await expect(
      provider.createTxt({
        fqdn: "_acme-challenge.example.com",
        value: "txt-digest",
      }),
    ).rejects.toThrow("Cloudflare TXT creation failed (403)");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
