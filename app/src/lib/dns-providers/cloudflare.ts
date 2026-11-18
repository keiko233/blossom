import { getServerEnv } from "@/lib/env";

import type { DnsProvider, DnsTxtRecord } from "./types";

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const REQUEST_TIMEOUT_MS = 10_000;

type FetchImplementation = typeof fetch;

interface CloudflareResponse {
  success?: boolean;
  result?: { id?: unknown };
  errors?: Array<{ message?: unknown }>;
}

export class CloudflareDnsProvider implements DnsProvider {
  constructor(
    private readonly token: string,
    private readonly zoneId: string,
    private readonly fetchImplementation: FetchImplementation = fetch,
  ) {}

  async createTxt(record: DnsTxtRecord): Promise<string> {
    const response = await this.fetchImplementation(
      `${CLOUDFLARE_API}/zones/${encodeURIComponent(this.zoneId)}/dns_records`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "TXT",
          name: record.fqdn,
          content: record.value,
          ttl: 60,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const body = await parseResponse(response);
    const recordId = body.result?.id;
    if (
      !response.ok ||
      body.success === false ||
      typeof recordId !== "string" ||
      recordId.length === 0 ||
      recordId.length > 256
    ) {
      throw new Error(
        `Cloudflare TXT creation failed (${response.status})${cloudflareError(body)}`,
      );
    }
    return recordId;
  }

  async deleteTxt(providerRecordId: string): Promise<void> {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(providerRecordId)) {
      throw new Error("Invalid Cloudflare DNS record id");
    }
    const response = await this.fetchImplementation(
      `${CLOUDFLARE_API}/zones/${encodeURIComponent(this.zoneId)}/dns_records/${encodeURIComponent(providerRecordId)}`,
      {
        method: "DELETE",
        headers: { Authorization: `Bearer ${this.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const body = await parseResponse(response);
    if (!response.ok || body.success === false) {
      throw new Error(
        `Cloudflare TXT cleanup failed (${response.status})${cloudflareError(body)}`,
      );
    }
  }
}

async function parseResponse(response: Response): Promise<CloudflareResponse> {
  try {
    return (await response.json()) as CloudflareResponse;
  } catch {
    return {};
  }
}

function cloudflareError(body: CloudflareResponse): string {
  const message = body.errors
    ?.map((error) => error.message)
    .find((value): value is string => typeof value === "string");
  return message ? `: ${message.slice(0, 512)}` : "";
}

export function getCloudflareDnsProvider(): CloudflareDnsProvider | null {
  const env = getServerEnv();
  if (!env.CLOUDFLARE_DNS_API_TOKEN || !env.CLOUDFLARE_DNS_ZONE_ID) {
    return null;
  }
  return new CloudflareDnsProvider(
    env.CLOUDFLARE_DNS_API_TOKEN,
    env.CLOUDFLARE_DNS_ZONE_ID,
  );
}
