import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import type React from "react";

import { DebouncedSearchInput } from "@/components/debounced-search-input";
import { ListPagination } from "@/components/list-pagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toastManager } from "@/components/ui/toast";
import { formatDateTime } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import type { RedeemDetailSearch } from "@/lib/redeem-search";
import { DEFAULT_PAGE_SIZE } from "@/lib/subscription-search";
import { REDEEM_PAGE_SIZES } from "@/orpc/redeem/schema";
import { m } from "@/paraglide/messages";
import {
  listRedeemCodes,
  REDEEM_QUERY_KEY,
  type RedeemCodeListItem,
  updateRedeemCode,
} from "@/query/redeem";

export interface BatchCodesTableProps {
  batchId: string;
  maxRedemptionsPerCode: number;
  search: RedeemDetailSearch;
}

/** Codes of one batch: prefix, uses, state and a disable/enable toggle. */
export function BatchCodesTable({
  batchId,
  maxRedemptionsPerCode,
  search,
}: BatchCodesTableProps): React.ReactElement {
  const navigate = useNavigate({ from: "/admin/redeem/$batchId" });
  const queryClient = useQueryClient();

  const page = search.codesPage ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE;
  const input = { batchId, search: search.q, page, pageSize };

  const { data, isPending, isPlaceholderData } = useQuery({
    queryKey: [...REDEEM_QUERY_KEY, "codes", input],
    queryFn: () => listRedeemCodes({ data: input }),
    placeholderData: keepPreviousData,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = getPageCount(total, pageSize);

  const toggle = useMutation({
    mutationFn: (code: RedeemCodeListItem) =>
      updateRedeemCode({ data: { id: code.id, disabled: !code.disabled } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: REDEEM_QUERY_KEY });
    },
    onError: () => {
      toastManager.add({ type: "error", title: m.admin_redeem_toast_error() });
    },
  });

  const updateSearch = (patch: Partial<RedeemDetailSearch>) =>
    void navigate({
      search: (prev) => ({ ...prev, ...patch, codesPage: undefined }),
      replace: true,
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.admin_redeem_codes_title()}</CardTitle>
        <CardDescription>{m.admin_redeem_codes_description()}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <DebouncedSearchInput
          defaultValue={search.q ?? ""}
          placeholder={m.admin_redeem_codes_search_placeholder()}
          onSearch={(value) => updateSearch({ q: value || undefined })}
        />
        {isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {search.q
              ? m.admin_redeem_codes_empty_filtered()
              : m.admin_redeem_codes_empty()}
          </p>
        ) : (
          <div
            className={isPlaceholderData ? "opacity-60 transition-opacity" : ""}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.admin_redeem_codes_col_prefix()}</TableHead>
                  <TableHead>{m.admin_redeem_codes_col_uses()}</TableHead>
                  <TableHead>{m.admin_redeem_codes_col_status()}</TableHead>
                  <TableHead>{m.admin_redeem_codes_col_created()}</TableHead>
                  <TableHead>
                    <span className="sr-only">Actions</span>
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((code) => (
                  <TableRow key={code.id}>
                    <TableCell className="font-mono text-xs">
                      {code.prefix}-…
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {code.redemptionCount} / {maxRedemptionsPerCode}
                    </TableCell>
                    <TableCell>
                      {code.disabled ? (
                        <Badge variant="outline">
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-destructive"
                          />
                          {m.admin_redeem_code_disabled()}
                        </Badge>
                      ) : code.redemptionCount >= maxRedemptionsPerCode ? (
                        <Badge variant="outline">
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-amber-500"
                          />
                          {m.admin_redeem_code_used()}
                        </Badge>
                      ) : (
                        <Badge variant="outline">
                          <span
                            aria-hidden="true"
                            className="size-1.5 rounded-full bg-emerald-500"
                          />
                          {m.admin_redeem_code_available()}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(code.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        loading={
                          toggle.isPending && toggle.variables?.id === code.id
                        }
                        size="xs"
                        variant="outline"
                        onClick={() => toggle.mutate(code)}
                      >
                        {code.disabled
                          ? m.admin_redeem_action_enable()
                          : m.admin_redeem_action_disable()}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <ListPagination
              link={(target) => (
                <Link
                  from="/admin/redeem/$batchId"
                  to="/admin/redeem/$batchId"
                  search={(prev) => ({
                    ...prev,
                    codesPage: target === 1 ? undefined : target,
                  })}
                />
              )}
              page={page}
              pageCount={pageCount}
              pageSize={pageSize}
              pageSizes={REDEEM_PAGE_SIZES}
              total={total}
              onPageSizeChange={(size) =>
                void navigate({
                  search: (prev) => ({
                    ...prev,
                    codesPage: undefined,
                    redemptionsPage: undefined,
                    pageSize: size === DEFAULT_PAGE_SIZE ? undefined : size,
                  }),
                  replace: true,
                })
              }
            />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
