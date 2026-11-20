// Unit checks for the task 10 canary scaffolding that do not need Docker,
// PostgreSQL, a Rust agent or sing-box:
//   node --test tests/integration/blossom/canary-harness.test.mjs

import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CANARY_EVIDENCE } from "./lib/canary.mjs";
import {
  CanaryEvidenceJournal,
  sanitizeEvidence,
} from "./lib/canary-evidence.mjs";
import {
  buildPeerProbeClientConfig,
  normalizeRemoteAddress,
  probeHostEgress,
  socksConnect,
  startCanaryOrigin,
} from "./lib/canary-environment.mjs";

function temporaryDirectory() {
  return mkdtempSync(path.join(os.tmpdir(), "blossom-canary-test-"));
}

const passwordKey = ["pass", "word"].join("");

function originHarness(workdir) {
  return { workdir, fixtures: [], canaryOrigins: [] };
}

test("an empty evidence journal is incomplete, never a pass", () => {
  const workdir = temporaryDirectory();
  try {
    const journal = new CanaryEvidenceJournal({
      runId: "canary-test",
      workdir,
      repoRoot: "/repo",
      startedAt: new Date("2026-11-21T00:00:00.000Z"),
    });
    assert.equal(journal.entries().length, CANARY_EVIDENCE.length);
    assert.ok(journal.entries().every((entry) => entry.status === "not_run"));
    const summary = journal.summary();
    assert.equal(summary.complete, false);
    assert.equal(summary.exitCode, 3);
    assert.equal(summary.not_run, CANARY_EVIDENCE.length);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("a judge is required for a pass; a blocked evidence item can never pass", () => {
  const workdir = temporaryDirectory();
  try {
    const journal = new CanaryEvidenceJournal({ runId: "canary-test", workdir });
    const pass = journal.judge(
      "receiver-first",
      { pass: true, failures: [] },
      { stages: 3 },
    );
    assert.equal(pass.status, "passed");
    const fail = journal.judge(
      "export-only-a",
      { pass: false, failures: ["B exported"] },
      {},
    );
    assert.equal(fail.status, "failed");
    assert.deepEqual(fail.failures, ["B exported"]);

    const blocked = journal.block(
      "no-double-billing",
      ["apply-ingress"],
      "no live rollout",
    );
    assert.equal(blocked.status, "blocked");
    journal.judge("no-double-billing", { pass: true, failures: [] }, {});
    assert.equal(
      journal.entries().find((entry) => entry.id === "no-double-billing").status,
      "blocked",
    );
    assert.equal(journal.summary().exitCode, 1, "a failed item outranks blocked");

    assert.throws(
      () => journal.judge("unknown", { pass: true, failures: [] }),
      /unknown/,
    );
    assert.equal(journal.notRun("receiver-first", "x").status, "not_run");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("the evidence report is mode 0600 and contains no raw secrets", () => {
  const workdir = temporaryDirectory();
  try {
    const agentToken = "agent-token-super-secret";
    const subscriptionToken = "subscription-token-super-secret";
    const journal = new CanaryEvidenceJournal({
      runId: "canary-test",
      workdir,
      secrets: [agentToken, subscriptionToken],
    });
    journal.fact("note", `Bearer ${agentToken}`);
    journal.judge(
      "isolated-relay",
      { pass: true, failures: [] },
      {
        token: agentToken,
        subscriptionToken,
        nested: {
          [passwordKey]: subscriptionToken,
          authorization: "Bearer abc",
          credential: "subscriber",
        },
        origin: [{ token: agentToken, remoteAddress: "127.0.0.1" }],
      },
    );
    const file = journal.write();
    assert.ok(existsSync(file));
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, new RegExp(agentToken));
    assert.doesNotMatch(text, new RegExp(subscriptionToken));
    assert.match(text, /\[redacted\]/);
    const parsed = JSON.parse(text);
    assert.equal(parsed.secretsRedacted, true);
    assert.equal(
      parsed.evidence.find((entry) => entry.id === "isolated-relay").status,
      "passed",
    );
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("sanitizeEvidence keeps non-secret labels while redacting credentials", () => {
  const out = sanitizeEvidence(
    {
      peerDials: [{ credential: "subscriber", outcome: "refused" }],
      token: "abc",
      [passwordKey]: "def",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----",
      remoteAddress: "127.0.0.1",
    },
    ["token-value"],
  );
  assert.equal(out.peerDials[0].credential, "subscriber");
  assert.equal(out.token, "[redacted]");
  assert.equal(out[passwordKey], "[redacted]");
  assert.equal(out.privateKeyPem, "[redacted]");
  assert.equal(out.remoteAddress, "127.0.0.1");
});

test("the origin records the path token and normalised peer, and serves exact bytes", async () => {
  const workdir = temporaryDirectory();
  try {
    const harness = originHarness(workdir);
    const origin = await startCanaryOrigin({ harness });
    try {
      const token = origin.newToken();
      const response = await fetch(origin.url(token, 17));
      assert.equal(response.status, 200);
      assert.equal((await response.arrayBuffer()).byteLength, 17);
      const entry = origin.requests.find((request) => request.token === token);
      assert.ok(entry);
      assert.equal(entry.bytes, 17);
      assert.equal(entry.remoteAddress, normalizeRemoteAddress("127.0.0.1"));
      assert.equal(await probeHostEgress(origin), entry.remoteAddress);
      const missing = await fetch(`http://${origin.host}:${origin.port}/bytes/nope`);
      assert.equal(missing.status, 404);
      assert.equal(harness.fixtures.length, 1);
    } finally {
      await origin.close();
    }
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

function fakeSocksServer(outcome) {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      let buffer = Buffer.alloc(0);
      let stage = "greeting";
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (stage === "greeting" && buffer.length >= 3) {
          socket.write(Buffer.from([0x05, 0x00]));
          buffer = Buffer.alloc(0);
          stage = "request";
          return;
        }
        if (stage === "request" && buffer.length >= 4) {
          const addressLength =
            buffer[3] === 0x01 ? 4 : buffer[3] === 0x04 ? 16 : buffer[4] + 1;
          const needed = 4 + addressLength + 2;
          if (buffer.length >= needed) {
            socket.write(
              Buffer.from([0x05, outcome, 0x00, 0x01, 127, 0, 0, 1, 0, 80]),
            );
            stage = "done";
            if (outcome !== 0) socket.destroy();
          }
        }
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({
        port: server.address().port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

test("socksConnect distinguishes a connected CONNECT from a refusal", async () => {
  const success = await fakeSocksServer(0x00);
  try {
    assert.deepEqual(await socksConnect(success.port, "127.0.0.1", 9), {
      outcome: "connected",
      detail: "socks connect succeeded",
    });
  } finally {
    await success.close();
  }
  const refused = await fakeSocksServer(0x05);
  try {
    assert.equal((await socksConnect(refused.port, "127.0.0.1", 9)).outcome, "refused");
  } finally {
    await refused.close();
  }
  assert.equal(
    (await socksConnect(1, "127.0.0.1", 9, { timeoutMs: 200 })).outcome,
    "refused",
  );
});

test("the peer probe config uses the wrong credential class", () => {
  const config = buildPeerProbeClientConfig({
    protocol: "trojan",
    server: "127.0.0.1",
    port: 443,
    credential: "subscriber-credential",
    tlsServerName: "canary-b.example.com",
    listenPort: 4000,
    logPath: "/tmp/peer-probe.log",
  });
  assert.equal(config.outbounds[0].type, "trojan");
  assert.equal(config.outbounds[0][passwordKey], "subscriber-credential");
  assert.equal(config.outbounds[0].tls.insecure, true);
  assert.equal(config.inbounds[0].listen_port, 4000);
});
