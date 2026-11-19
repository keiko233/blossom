import type { Server } from "@/db/proxy-schema";

/**
 * Server row as served outside the control plane. `agentTokenHash` is
 * deliberately omitted: only the non-secret prefix and whether a static backup
 * credential exists are exposed.
 */
export type ServerDTO = Omit<Server, "agentTokenHash"> & {
  backupTokenEnabled: boolean;
};

export function toServerDTO(row: Server): ServerDTO {
  const { agentTokenHash, ...rest } = row;
  return { ...rest, backupTokenEnabled: agentTokenHash !== null };
}
