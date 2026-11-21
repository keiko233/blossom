import type { ThemedToken } from "shiki/core";

import { sanitizeLogText } from "@/lib/admin-logs-view";

type LogTheme = "github-dark" | "github-light";
type Highlighter = Awaited<
  ReturnType<typeof import("shiki/core").createHighlighterCore>
>;

let highlighterPromise: Promise<Highlighter> | null = null;
const tokenCache = new Map<string, ThemedToken[] | null>();
const TOKEN_CACHE_LIMIT = 600;

/**
 * The Logs tab loads only the grammars it uses, and only when a line is ready
 * to render. The bundle stays out of the route chunk until then.
 */
function loadHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= (async () => {
    const [core, javascript, json, log, light, dark] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/langs/json.mjs"),
      import("shiki/langs/log.mjs"),
      import("shiki/themes/github-light.mjs"),
      import("shiki/themes/github-dark.mjs"),
    ]);
    return core.createHighlighterCore({
      themes: [light.default, dark.default],
      langs: [json.default, log.default],
      engine: javascript.createJavaScriptRegexEngine(),
    });
  })();
  return highlighterPromise;
}

function isJsonLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) {
    return false;
  }
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "object" && value !== null;
  } catch {
    return false;
  }
}

function remember(key: string, tokens: ThemedToken[] | null) {
  if (tokenCache.size >= TOKEN_CACHE_LIMIT) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) {
      tokenCache.delete(oldest);
    }
  }
  tokenCache.set(key, tokens);
}

/**
 * Tokenizes one line to React-renderable tokens. Returning null tells the view
 * to use its plain-text fallback; no log data is ever passed as raw HTML.
 */
export async function highlightLogLine(
  text: string,
  theme: LogTheme,
): Promise<ThemedToken[] | null> {
  const safeText = sanitizeLogText(text);
  const cacheKey = `${theme}:${safeText}`;
  if (tokenCache.has(cacheKey)) {
    return tokenCache.get(cacheKey) ?? null;
  }

  try {
    const highlighter = await loadHighlighter();
    const [line] = highlighter.codeToTokensBase(safeText, {
      lang: isJsonLine(safeText) ? "json" : "log",
      theme,
    });
    const tokens = line ?? [];
    remember(cacheKey, tokens);
    return tokens;
  } catch {
    remember(cacheKey, null);
    return null;
  }
}
