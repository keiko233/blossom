// Evidence journal for the two-agent canary (task 10). A live run records only
// bounded observations and the judge verdict; raw tokens, passwords and keys
// stay in memory and are never serialized. A missing prerequisite or an
// incomplete observation is `blocked`/`not_run`, never `passed`.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CANARY_EVIDENCE } from "./canary.mjs";
import { redact } from "./util.mjs";

export const CANARY_EVIDENCE_STATES = [
  "passed",
  "failed",
  "blocked",
  "not_run",
];

const EVIDENCE_IDS = new Set(CANARY_EVIDENCE.map((entry) => entry.id));
const EVIDENCE_ORDER = new Map(
  CANARY_EVIDENCE.map((entry, index) => [entry.id, index]),
);

// Keys whose values are always omitted. `credential` is intentionally absent:
// the relay judge uses it as a non-secret label ("subscriber").
const SECRET_KEYS = new Set([
  "token",
  "subscriptionToken",
  "agentToken",
  "password",
  "authSecret",
  "secret",
  "statsSecret",
  "privateKey",
  "privateKeyPem",
  "keyPem",
  "certificateKey",
  "cookie",
  "authorization",
  "accessToken",
  "refreshToken",
]);

function sanitizeValue(value, secrets, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redact(value, secrets);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, secrets, seen));
  }
  if (typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.has(key)) out[key] = "[redacted]";
      else out[key] = sanitizeValue(item, secrets, seen);
    }
    seen.delete(value);
    return out;
  }
  return String(value);
}

/** Public for tests: the bounded, secret-free projection of an observation. */
export function sanitizeEvidence(value, secrets = []) {
  return sanitizeValue(value, secrets);
}

function verdictStatus(judge) {
  if (!judge || typeof judge.pass !== "boolean") return "not_run";
  return judge.pass ? "passed" : "failed";
}

/**
 * In-memory journal. `record` derives `passed`/`failed` from a judge verdict;
 * only an explicit `blockedBy` produces `blocked`. Nothing can be recorded as
 * passed without a passing judge, so a partially implemented scenario cannot
 * claim the evidence.
 */
export class CanaryEvidenceJournal {
  constructor({
    runId,
    workdir,
    startedAt = new Date(),
    secrets = [],
    repoRoot = undefined,
  }) {
    if (!runId) throw new Error("canary evidence needs a run id");
    this.runId = runId;
    this.workdir = workdir;
    this.startedAt = startedAt;
    this.secrets = [...secrets];
    this.repoRoot = repoRoot;
    this.facts = {};
    this.missingPrerequisites = [];
    this.records = new Map();
  }

  secret(value) {
    if (typeof value === "string" && value.length > 0) {
      this.secrets.push(value);
    }
    return value;
  }

  fact(name, value) {
    this.facts[name] = sanitizeValue(value, this.secrets);
    return this.facts[name];
  }

  prerequisites({ facts = {}, missing = [] }) {
    for (const [name, value] of Object.entries(facts)) this.fact(name, value);
    this.missingPrerequisites = missing.map(({ id, detail }) => ({
      id,
      detail: redact(detail, this.secrets),
    }));
  }

  #write(id, record) {
    if (!EVIDENCE_IDS.has(id)) {
      throw new Error(`unknown canary evidence id '${id}'`);
    }
    const existing = this.records.get(id);
    if (existing?.status === "blocked" && !record.blockedBy?.length) {
      return existing;
    }
    const status = record.blockedBy?.length
      ? "blocked"
      : (record.status ?? verdictStatus(record.judge));
    if (!CANARY_EVIDENCE_STATES.includes(status)) {
      throw new Error(`invalid canary evidence status '${status}'`);
    }
    const entry = {
      id,
      status,
      capturedAt: new Date().toISOString(),
      detail: record.detail ? redact(record.detail, this.secrets) : null,
      blockedBy: record.blockedBy ?? [],
      failures: record.judge?.failures ?? [],
      observations: sanitizeValue(record.observations, this.secrets),
    };
    this.records.set(id, entry);
    return entry;
  }

  /** Records a scenario observation plus the judge verdict for that evidence. */
  judge(id, verdict, observations = {}, detail = undefined) {
    if (!verdict || typeof verdict.pass !== "boolean") {
      throw new Error(`judge for '${id}' returned no verdict`);
    }
    return this.#write(id, {
      judge: { pass: verdict.pass, failures: [...verdict.failures] },
      observations,
      detail,
    });
  }

  /** Marks evidence blocked by named prerequisites. It can never pass. */
  block(id, blockedBy, detail) {
    return this.#write(id, {
      status: "blocked",
      blockedBy: [...new Set(blockedBy)],
      detail,
    });
  }

  /** Explicitly records a scenario that ran but could not produce evidence. */
  notRun(id, detail) {
    return this.#write(id, { status: "not_run", detail });
  }

  /** Records an unexpected scenario failure; never a pass. */
  fail(id, detail) {
    return this.#write(id, { status: "failed", detail });
  }

  entries() {
    const rows = [...this.records.values()].sort(
      (left, right) =>
        EVIDENCE_ORDER.get(left.id) - EVIDENCE_ORDER.get(right.id),
    );
    const recorded = new Set(rows.map((row) => row.id));
    const missing = CANARY_EVIDENCE.filter(
      (entry) => !recorded.has(entry.id),
    ).map((entry) => ({
      id: entry.id,
      status: "not_run",
      capturedAt: null,
      detail: "the live scenario did not record this evidence",
      blockedBy: [],
      failures: [],
      observations: {},
    }));
    return [...rows, ...missing].sort(
      (left, right) =>
        EVIDENCE_ORDER.get(left.id) - EVIDENCE_ORDER.get(right.id),
    );
  }

  summary() {
    const entries = this.entries();
    const counts = Object.fromEntries(
      CANARY_EVIDENCE_STATES.map((state) => [
        state,
        entries.filter((entry) => entry.status === state).length,
      ]),
    );
    const exitCode =
      counts.failed > 0
        ? 1
        : entries.some((entry) => entry.status !== "passed")
          ? 3
          : 0;
    return {
      total: entries.length,
      ...counts,
      complete: exitCode === 0,
      exitCode,
    };
  }

  toJSON({ finishedAt = new Date() } = {}) {
    return {
      schemaVersion: 1,
      runId: this.runId,
      repoRoot: this.repoRoot,
      startedAt: this.startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      secretsRedacted: true,
      facts: this.facts,
      missingPrerequisites: this.missingPrerequisites,
      evidence: this.entries(),
      summary: this.summary(),
    };
  }

  /** Writes the report mode 0600 through an atomic rename. */
  write(filePath = path.join(this.workdir, "canary-evidence.json")) {
    const directory = path.dirname(filePath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filePath}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(this.toJSON(), null, 2)}\n`, {
      mode: 0o600,
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
    return filePath;
  }
}
