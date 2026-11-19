import { useQuery } from "@tanstack/react-query";

import { listServers, SERVERS_QUERY_KEY } from "@/query/servers";

/**
 * The admin server list, read by the sidebar and by the selected-server header.
 * Both mount together, so they share one query and one refresh interval.
 */
export function useServerList() {
  return useQuery({
    queryKey: SERVERS_QUERY_KEY,
    queryFn: () => listServers(),
    refetchInterval: 15_000,
  });
}
