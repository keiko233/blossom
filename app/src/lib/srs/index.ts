export { SRS_ERROR_CODES, SrsError, isSrsError, srsError } from "./errors";
export type { SrsErrorCode } from "./errors";
export {
  SRS_MAX_FILE_BYTES,
  SRS_MAX_PAYLOAD_BYTES,
  SRS_MAX_READ_VERSION,
  SRS_WRITE_VERSION,
  packSrs,
  unpackSrs,
} from "./container";
export {
  computeStats,
  decodePayload,
  encodePayload,
  parseRuleSetSource,
} from "./payload";
export type {
  CompiledRuleSet,
  DefaultRule,
  LogicalRule,
  RuleSetRule,
  RuleSetSource,
  SrsStats,
  SrsSummary,
} from "./types";

import {
  SRS_MAX_FILE_BYTES,
  SRS_WRITE_VERSION,
  packSrs,
  unpackSrs,
} from "./container";
import { srsError } from "./errors";
import {
  computeStats,
  decodePayload,
  encodePayload,
  parseRuleSetSource,
} from "./payload";
import type { CompiledRuleSet, RuleSetSource, SrsSummary } from "./types";

export async function compileRuleSet(input: unknown): Promise<CompiledRuleSet> {
  const source = parseRuleSetSource(input);
  const payload = encodePayload(source);
  const bytes = await packSrs(payload, SRS_WRITE_VERSION);
  if (bytes.length > SRS_MAX_FILE_BYTES) throw srsError("file_too_large");
  return {
    bytes,
    version: SRS_WRITE_VERSION,
    payloadBytes: payload.length,
    stats: computeStats(source),
  };
}

export async function inspectSrs(file: Uint8Array): Promise<SrsSummary> {
  const { version, payload } = await unpackSrs(file);
  let stats: SrsSummary["stats"] = null;
  try {
    const source: RuleSetSource = decodePayload(payload);
    stats = computeStats(source);
  } catch {
    stats = null;
  }
  return { version, payloadBytes: payload.length, stats };
}
