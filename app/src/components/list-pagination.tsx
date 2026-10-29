import type { ReactElement } from "react";

import { buttonVariants } from "@/components/ui/button";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { getPaginationRange } from "@/lib/pagination";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export interface ListPaginationProps {
  page: number;
  pageCount: number;
  pageSize: number;
  total: number;
  pageSizes: readonly number[];
  /** Fired with the chosen size; callers drop it from the URL if default. */
  onPageSizeChange: (size: number) => void;
  /**
   * A router `<Link>` that rewrites only the `page` search param for the given
   * page, so every page is a linkable URL and the other filters carry over.
   */
  link: (page: number) => ReactElement;
}

/** Footer of a URL-driven list: result range, page size and page links. */
export function ListPagination({
  page,
  pageCount,
  pageSize,
  total,
  pageSizes,
  onPageSizeChange,
  link,
}: ListPaginationProps) {
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4">
      <div className="flex items-center gap-3 text-sm text-muted-foreground">
        <span>{m.admin_subscriptions_range({ from, to, total })}</span>
        <Select
          items={pageSizes.map((size) => ({
            label: m.admin_subscriptions_page_size({ size }),
            value: String(size),
          }))}
          value={String(pageSize)}
          onValueChange={(next) => onPageSizeChange(Number(next))}
        >
          <SelectTrigger className="w-32" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {pageSizes.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {m.admin_subscriptions_page_size({ size })}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          <PaginationItem>
            {page > 1 ? (
              <PaginationPrevious
                className={cn(
                  buttonVariants({ size: "default", variant: "ghost" }),
                  "max-sm:aspect-square max-sm:p-0",
                )}
                render={link(page - 1)}
              />
            ) : (
              <PaginationPrevious
                aria-disabled
                className="pointer-events-none opacity-50"
              />
            )}
          </PaginationItem>
          {getPaginationRange(page, pageCount).map((item, index) =>
            item === "ellipsis" ? (
              <PaginationItem key={`ellipsis-${index}`}>
                <PaginationEllipsis />
              </PaginationItem>
            ) : (
              <PaginationItem key={item}>
                <PaginationLink
                  className={buttonVariants({
                    size: "icon",
                    variant: item === page ? "outline" : "ghost",
                  })}
                  isActive={item === page}
                  render={link(item)}
                >
                  {item}
                </PaginationLink>
              </PaginationItem>
            ),
          )}
          <PaginationItem>
            {page < pageCount ? (
              <PaginationNext
                className={cn(
                  buttonVariants({ size: "default", variant: "ghost" }),
                  "max-sm:aspect-square max-sm:p-0",
                )}
                render={link(page + 1)}
              />
            ) : (
              <PaginationNext
                aria-disabled
                className="pointer-events-none opacity-50"
              />
            )}
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    </div>
  );
}
