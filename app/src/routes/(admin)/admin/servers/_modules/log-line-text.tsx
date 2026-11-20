"use client";

import type React from "react";
import { useEffect, useState } from "react";
import type { ThemedToken } from "shiki/core";
import { useTheme } from "tanstack-theme-kit";

import { logTextForDisplay, splitLogMatch } from "@/lib/admin-logs-view";

import { highlightLogLine } from "./log-highlighter";

export interface LogLineTextProps {
  text: string;
  /** Current search text; when present, matches render without token colors. */
  query?: string;
}

/**
 * Renders log data as React text nodes only. Highlighting is lazy and optional:
 * the plain sanitized line shows first and remains if Shiki fails to load.
 */
export function LogLineText({
  text,
  query = "",
}: LogLineTextProps): React.ReactElement {
  const { theme } = useTheme();
  const [tokens, setTokens] = useState<ThemedToken[] | null | undefined>(
    undefined,
  );
  const dark =
    typeof document !== "undefined" &&
    document.documentElement.classList.contains("dark");

  useEffect(() => {
    if (query.trim()) {
      return;
    }
    let cancelled = false;
    setTokens(undefined);
    void highlightLogLine(text, dark ? "github-dark" : "github-light").then(
      (result) => {
        if (!cancelled) {
          setTokens(result);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [text, dark, query, theme]);

  if (query.trim()) {
    return (
      <span data-slot="log-line-text">
        {splitLogMatch(text, query).map((part, index) =>
          part.match ? (
            <mark key={index} className="rounded-xs bg-warning/30 text-inherit">
              {part.text}
            </mark>
          ) : (
            <span key={index}>{part.text}</span>
          ),
        )}
      </span>
    );
  }

  if (!tokens) {
    return <span data-slot="log-line-text">{logTextForDisplay(text)}</span>;
  }

  return (
    <span data-slot="log-line-text">
      {tokens.map((token, index) => (
        <span
          key={index}
          style={token.color ? { color: token.color } : undefined}
        >
          {token.content}
        </span>
      ))}
    </span>
  );
}
