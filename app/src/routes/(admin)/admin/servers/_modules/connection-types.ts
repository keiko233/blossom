export interface ConnectionIdentityRow {
  id: string;
  generation: number;
  oauthClientId: string;
  status: string;
  createdAt: Date | string;
  activatedAt: Date | string | null;
  revokedAt: Date | string | null;
}

export interface ConnectionGrantRow {
  id: string;
  serverId: string | null;
  mode: string;
  capabilities: string[];
  release: string | null;
  status: string;
  expiresAt: Date | string;
  claimedAt: Date | string | null;
  redeemedAt: Date | string | null;
  revokedAt: Date | string | null;
  createdAt: Date | string;
}

export interface ConnectionReleaseOption {
  version: string;
  tag: string;
  singBoxVersion: string;
  capabilities: string[];
  compatible: boolean;
}
