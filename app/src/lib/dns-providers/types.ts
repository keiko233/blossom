export interface DnsTxtRecord {
  fqdn: string;
  value: string;
}

export interface DnsProvider {
  createTxt(record: DnsTxtRecord): Promise<string>;
  deleteTxt(providerRecordId: string): Promise<void>;
}
