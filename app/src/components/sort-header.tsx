import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

export interface SortHeaderProps {
  label: string;
  /** Whether the list is currently sorted by this column. */
  active: boolean;
  dir: "asc" | "desc";
  onClick: () => void;
}

/** Column header button of a URL-sorted table, with a direction indicator. */
export function SortHeader({ label, active, dir, onClick }: SortHeaderProps) {
  const Icon = !active
    ? ChevronsUpDownIcon
    : dir === "asc"
      ? ArrowUpIcon
      : ArrowDownIcon;
  return (
    <Button className="-ms-2" size="xs" variant="ghost" onClick={onClick}>
      {label}
      <Icon />
    </Button>
  );
}
