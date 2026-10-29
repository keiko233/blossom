import { SearchIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { Input } from "@/components/ui/input";

const SEARCH_DEBOUNCE_MS = 300;

export interface DebouncedSearchInputProps {
  /** Initial text, taken from the URL. Remount (via `key`) to reset it. */
  defaultValue: string;
  placeholder: string;
  /** Fired after typing pauses, with the trimmed text ("" when cleared). */
  onSearch: (value: string) => void;
}

/** Search box for URL-driven lists: debounces so each keystroke isn't a navigation. */
export function DebouncedSearchInput({
  defaultValue,
  placeholder,
  onSearch,
}: DebouncedSearchInputProps) {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const onInput = (value: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(
      () => onSearch(value.trim()),
      SEARCH_DEBOUNCE_MS,
    );
  };

  return (
    <div className="relative w-full sm:w-72">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute start-2.5 top-1/2 z-10 size-4 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        aria-label={placeholder}
        className="[&_input]:ps-8"
        defaultValue={defaultValue}
        placeholder={placeholder}
        type="search"
        onChange={(e) => onInput(e.target.value)}
      />
    </div>
  );
}
