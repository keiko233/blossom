import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { DownloadIcon } from "lucide-react";
import type React from "react";
import { useState } from "react";

import { ListPagination } from "@/components/list-pagination";
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
import { downloadCsv } from "@/lib/download-csv";
import { formatDateTime } from "@/lib/format";
import { getPageCount } from "@/lib/pagination";
import type { RedeemDetailSearch } from "@/lib/redeem-search";
import { DEFAULT_PAGE_SIZE } from "@/lib/subscription-search";
import { REDEEM_PAGE_SIZES } from "@/orpc/redeem/schema";
import { m } from "@/paraglide/messages";
import {
  exportRedemptionsCsv,
  listRedeemRedemptions,
  REDEEM_QUERY_KEY,
} from "@/query/redeem";

export interface BatchRedemptionsTableProps {
  batchId: string;
  search: RedeemDetailSearch;
}

/** Who redeemed what in one batch, with a CSV export of all of it. */
export function BatchRedemptionsTable({
  batchId,
  search,
}: BatchRedemptionsTableProps): React.ReactElement {
  const navigate = useNavigate({ from: "/admin/redeem/$batchId" });
  const [isExporting, setIsExporting] = useState(false);

  const page = search.redemptionsPage ?? 1;
  const pageSize = search.pageSize ?? DEFAULT_PAGE_SIZE;
  const input = { batchId, page, pageSize };

  const { data, isPending, isPlaceholderData } = useQuery({
    queryKey: [...REDEEM_QUERY_KEY, "redemptions", input],
    queryFn: () => listRedeemRedemptions({ data: input }),
    placeholderData: keepPreviousData,
  });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pageCount = getPageCount(total, pageSize);

  const exportCsv = async () => {
    setIsExporting(true);
    try {
      const result = await exportRedemptionsCsv({ data: { batchId } });
      downloadCsv(
        `redemptions-${new Date().toISOString().slice(0, 10)}.csv`,
        result.csv,
      );
      toastManager.add({
        type: result.truncated ? "warning" : "success",
        title: result.truncated
          ? m.admin_redeem_export_truncated({ count: result.count })
          : m.admin_redeem_export_done({ count: result.count }),
      });
    } catch {
      toastManager.add({
        type: "error",
        title: m.admin_redeem_export_error(),
      });
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.admin_redeem_redemptions_title()}</CardTitle>
        <CardDescription>
          {m.admin_redeem_redemptions_description()}
        </CardDescription>
        <div className="col-start-2 row-span-2 row-start-1 self-start justify-self-end">
          <Button
            disabled={total === 0}
            loading={isExporting}
            size="sm"
            variant="outline"
            onClick={() => void exportCsv()}
          >
            <DownloadIcon />
            {m.admin_redeem_export()}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isPending ? (
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            {m.admin_redeem_redemptions_empty()}
          </p>
        ) : (
          <div
            className={isPlaceholderData ? "opacity-60 transition-opacity" : ""}
          >
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{m.admin_redeem_redemptions_col_user()}</TableHead>
                  <TableHead>{m.admin_redeem_redemptions_col_code()}</TableHead>
                  <TableHead>
                    {m.admin_redeem_redemptions_col_subscription()}
                  </TableHead>
                  <TableHead>{m.admin_redeem_redemptions_col_time()}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Link
                        className="flex flex-col"
                        params={{ userId: row.userId }}
                        to="/admin/users/$userId"
                      >
                        <span className="font-medium hover:underline">
                          {row.userName}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {row.userEmail}
                        </span>
                      </Link>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.codePrefix}-…
                    </TableCell>
                    <TableCell>
                      {row.subscriptionId ? (
                        <Link
                          className="text-xs hover:underline"
                          search={{ q: row.subscriptionId }}
                          to="/admin/subscriptions"
                        >
                          {m.admin_redeem_redemptions_view_subscription()}
                        </Link>
                      ) : (
                        <Link
                          className="text-xs text-muted-foreground hover:underline"
                          params={{ userId: row.userId }}
                          to="/admin/users/$userId"
                        >
                          {m.admin_redeem_redemptions_no_subscription()}
                        </Link>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(row.createdAt)}
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
                    redemptionsPage: target === 1 ? undefined : target,
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
