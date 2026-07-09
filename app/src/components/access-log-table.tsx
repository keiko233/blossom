import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import type React from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  listAccessLogs,
  ACCESS_LOGS_QUERY_KEY,
  type AccessLogListResult,
} from "@/lib/access-logs";
import { m } from "@/paraglide/messages";

const PAGE_SIZE = 20;

interface AccessLogTableProps {
  subjectType: string;
  subjectId: string;
}

function formatClient(
  name: string | null,
  version: string | null,
): React.ReactNode {
  if (!name) {
    return (
      <span className="text-muted-foreground">{m.access_log_unknown()}</span>
    );
  }
  return (
    <span>
      {name}
      {version ? (
        <span className="text-muted-foreground"> {version}</span>
      ) : null}
    </span>
  );
}

export function AccessLogTable({
  subjectType,
  subjectId,
}: AccessLogTableProps): React.ReactElement {
  const [page, setPage] = useState(0);
  const cursor = page * PAGE_SIZE;

  const { data, isPending } = useQuery<AccessLogListResult>({
    queryKey: [...ACCESS_LOGS_QUERY_KEY, subjectType, subjectId, page] as const,
    queryFn: () =>
      listAccessLogs({
        data: {
          subjectType,
          subjectId,
          cursor,
          limit: PAGE_SIZE,
        },
      }),
  });

  if (isPending || !data) {
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  }

  const { rows, total } = data;
  const hasNext = cursor + rows.length < total;

  return (
    <div className="flex flex-col gap-3">
      {rows.length > 0 ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{m.access_log_col_time()}</TableHead>
                <TableHead>{m.access_log_col_ip()}</TableHead>
                <TableHead>{m.access_log_col_client()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <span className="text-xs text-muted-foreground">
                      {new Date(row.createdAt).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <span className="font-mono text-xs">{row.ip ?? "—"}</span>
                  </TableCell>
                  <TableCell>
                    <span
                      className="block max-w-xs truncate text-sm"
                      title={row.userAgent ?? undefined}
                    >
                      {formatClient(row.clientName, row.clientVersion)}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {cursor + 1}–{cursor + rows.length} / {total}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeftIcon />
                {m.access_log_prev()}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={!hasNext}
              >
                {m.access_log_next()}
                <ChevronRightIcon />
              </Button>
            </div>
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
          {m.access_log_empty()}
        </div>
      )}
    </div>
  );
}
