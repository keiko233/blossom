import { useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getNetworkingWorkspace,
  getServerRouting,
  NETWORKING_QUERY_KEY,
  type ServerRoutingData,
} from "@/query/networking";

export function useNetworkingWorkspace() {
  return useQuery({
    queryKey: NETWORKING_QUERY_KEY,
    queryFn: () => getNetworkingWorkspace(),
    refetchInterval: 30_000,
  });
}

export function useServerRouting(serverId: string | null) {
  return useQuery({
    queryKey: [...NETWORKING_QUERY_KEY, "routing", serverId],
    queryFn: () => getServerRouting({ data: { serverId: serverId! } }),
    enabled: Boolean(serverId),
    refetchInterval: 30_000,
  });
}

export function useInvalidateNetworking() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({ queryKey: NETWORKING_QUERY_KEY });
}

export type { ServerRoutingData };
