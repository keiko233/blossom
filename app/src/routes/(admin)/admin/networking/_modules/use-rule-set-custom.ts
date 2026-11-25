import { useEffect, useRef, useState } from "react";

import {
  compileRuleSet,
  computeStats,
  decodePayload,
  encodePayload,
  isSrsError,
  parseRuleSetSource,
  unpackSrs,
  type RuleSetSource,
  type SrsStats,
} from "@/lib/srs";

export type RuleSetEditorMode = "structured" | "json";

export interface RuleSetValidation {
  ok: boolean;
  message: string | null;
  path: string | null;
  stats: SrsStats | null;
  payloadBytes: number | null;
}

export interface RuleSetCustomDraft {
  ruleSetId: string;
  version: string;
  mode: RuleSetEditorMode;
  rules: unknown;
}

const DEBOUNCE_MS = 250;

function validateSource(source: unknown): {
  parsed: RuleSetSource | null;
  validation: RuleSetValidation;
} {
  try {
    const parsed = parseRuleSetSource(source);
    const payload = encodePayload(parsed);
    return {
      parsed,
      validation: {
        ok: true,
        message: null,
        path: null,
        stats: computeStats(parsed),
        payloadBytes: payload.length,
      },
    };
  } catch (error) {
    if (isSrsError(error)) {
      return {
        parsed: null,
        validation: {
          ok: false,
          message: error.code,
          path: error.path ?? null,
          stats: null,
          payloadBytes: null,
        },
      };
    }
    return {
      parsed: null,
      validation: {
        ok: false,
        message: "invalid_field",
        path: null,
        stats: null,
        payloadBytes: null,
      },
    };
  }
}

/**
 * Client-side live validation for the custom editor. Server validation stays
 * authoritative; this only prevents obviously bad drafts from being submitted.
 */
export function useRuleSetCustomValidation(source: unknown) {
  const serialized = JSON.stringify(source);
  const [result, setResult] = useState<RuleSetValidation>(
    () => validateSource(source).validation,
  );
  const latest = useRef(serialized);
  latest.current = serialized;
  const previous = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(
      () => {
        if (latest.current !== serialized) return;
        setResult(validateSource(JSON.parse(serialized)).validation);
      },
      previous.current === serialized ? 0 : DEBOUNCE_MS,
    );
    previous.current = serialized;
    return () => clearTimeout(timer);
  }, [serialized]);

  return result;
}

export async function decodeRuleSetAsset(
  bytes: Uint8Array,
): Promise<RuleSetSource | null> {
  try {
    const { payload } = await unpackSrs(bytes);
    return decodePayload(payload);
  } catch {
    return null;
  }
}

export async function downloadCustomRuleSet(
  source: unknown,
  fileName: string,
): Promise<void> {
  const compiled = await compileRuleSet(source);
  const blob = new Blob([compiled.bytes.slice().buffer], {
    type: "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName.endsWith(".srs") ? fileName : `${fileName}.srs`;
    anchor.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
