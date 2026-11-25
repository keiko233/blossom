import { useQuery } from "@tanstack/react-query";

import { listOfficialRuleSets } from "@/query/networking-rule-sets";

export function useRuleSetOfficialCatalog() {
  return useQuery({
    queryKey: ["admin", "networking", "rule-sets", "official"],
    queryFn: () => listOfficialRuleSets(),
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });
}
