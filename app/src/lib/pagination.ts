export type PaginationItemKind = number | "ellipsis";

/** Total page count for a result set; always at least 1. */
export function getPageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}

/**
 * Page numbers to render: first and last page, the current page with
 * `siblings` neighbours on each side, and an ellipsis for each skipped gap
 * (a gap of exactly one page shows that page instead).
 */
export function getPaginationRange(
  page: number,
  pageCount: number,
  siblings = 1,
): PaginationItemKind[] {
  const wanted = new Set<number>([1, pageCount]);
  for (let p = page - siblings; p <= page + siblings; p++) {
    if (p >= 1 && p <= pageCount) wanted.add(p);
  }
  const pages = [...wanted].sort((a, b) => a - b);

  const items: PaginationItemKind[] = [];
  for (const [index, current] of pages.entries()) {
    const previous = pages[index - 1];
    if (previous !== undefined) {
      if (current - previous === 2) items.push(previous + 1);
      else if (current - previous > 2) items.push("ellipsis");
    }
    items.push(current);
  }
  return items;
}
