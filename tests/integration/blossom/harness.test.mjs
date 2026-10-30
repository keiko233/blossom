// Checks for the harness's process cleanup, preflight and fixtures. No Docker,
// database or sing-box is started:
//   node --test tests/integration/blossom/harness.test.mjs

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  Harness,
  assertLoopbackDatabase,
  isHarnessContainer,
  isHarnessWorkdir,
} from "./lib/harness.mjs";
import { occupyPort, startOrigin } from "./lib/net-fixtures.mjs";
import { ManagedProcess, descendants } from "./lib/proc.mjs";
import { isPortFree, sleep, waitFor } from "./lib/util.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("ManagedProcess.stop reaps the children the process spawned, and logs to a file", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "blossom-it-test-"));
  try {
    const proc = new ManagedProcess(
      "supervisor",
      "sh",
      ["-c", "echo started; sleep 300 & sleep 300 & wait"],
      { env: { PATH: process.env.PATH }, cwd: dir, logFile: path.join(dir, "out.log") },
    );
    const children = await waitFor("two children", () => {
      const found = descendants(proc.pid);
      return found.length >= 2 && found;
    }, { timeoutMs: 5000, intervalMs: 50 });
    assert.ok(children.every(alive));
    assert.match(proc.tail(), /started/);

    await proc.stop(2000);
    await sleep(200);
    assert.equal(proc.running, false);
    assert.deepEqual(children.filter(alive), [], "no child outlives the supervisor");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ManagedProcess.stop escalates to SIGKILL for a process that ignores SIGTERM", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "blossom-it-test-"));
  try {
    const proc = new ManagedProcess(
      "stubborn",
      "sh",
      ["-c", "trap '' TERM; while true; do sleep 1; done"],
      { env: { PATH: process.env.PATH }, cwd: dir, logFile: path.join(dir, "out.log") },
    );
    await sleep(200);
    assert.equal(proc.running, true);
    await proc.stop(300);
    assert.equal(proc.running, false);
    await sleep(1200);
    assert.deepEqual(
      [...proc.descendantPids].filter(alive),
      [],
      "the sleep started by the stubborn shell is reaped as well",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a supervisor that dies leaves no unknown orphan: children are tracked while it runs", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "blossom-it-test-"));
  try {
    const proc = new ManagedProcess(
      "crashing-supervisor",
      "sh",
      ["-c", "sleep 300 & sleep 1; kill -9 $$"],
      {
        env: { PATH: process.env.PATH },
        cwd: dir,
        logFile: path.join(dir, "out.log"),
        trackEveryMs: 100,
      },
    );
    await proc.exited;
    // `pgrep -P` finds nothing now (the orphan was re-parented), but the
    // earlier sampling remembered it.
    const orphans = proc.survivors();
    assert.equal(orphans.length, 1, orphans.join(", "));
    await proc.stop(500);
    await sleep(200);
    assert.deepEqual(proc.survivors(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stop never signals a recycled pid that is not the process it remembered", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "blossom-it-test-"));
  const bystander = spawn("sleep", ["300"], { stdio: "ignore" });
  try {
    const proc = new ManagedProcess("short", "sh", ["-c", "exit 0"], {
      env: { PATH: process.env.PATH },
      cwd: dir,
      logFile: path.join(dir, "out.log"),
    });
    await proc.exited;
    // As if our child had died and an unrelated process had taken its pid.
    proc.descendantStarts.set(bystander.pid, "Thu Jan  1 00:00:00 1970");
    await proc.stop(500);
    await sleep(200);
    assert.equal(alive(bystander.pid), true, "an unrelated process must be left alone");
    assert.deepEqual(proc.survivors(), []);
  } finally {
    bystander.kill("SIGKILL");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("stale-run cleanup only trusts names the harness generates", () => {
  const tmp = os.tmpdir();
  assert.equal(isHarnessWorkdir(path.join(tmp, "blossom-it-0123abcd-x1Y2z3"), tmp), true);
  assert.equal(isHarnessWorkdir(tmp, tmp), false);
  assert.equal(isHarnessWorkdir("/", tmp), false);
  assert.equal(isHarnessWorkdir(path.join(tmp, "other-dir"), tmp), false);
  assert.equal(isHarnessWorkdir(path.join(tmp, "nested", "blossom-it-0123abcd-x"), tmp), false);
  assert.equal(isHarnessWorkdir(undefined, tmp), false);

  assert.equal(isHarnessContainer("blossom-it-0123abcd"), true);
  assert.equal(isHarnessContainer("postgres"), false);
  assert.equal(isHarnessContainer("blossom-it-0123abcd --all"), false);
  assert.equal(isHarnessContainer(undefined), false);
});

test("only a loopback database is ever used, and the error carries no credentials", () => {
  assertLoopbackDatabase("postgresql://it:pw-not-real@127.0.0.1:5432/it");
  assertLoopbackDatabase("postgresql://it:pw-not-real@localhost:5432/it");
  assert.throws(
    () => assertLoopbackDatabase("postgresql://it:pw-not-real@db.example.com:5432/it"),
    (error) => /non-loopback/.test(error.message) && !error.message.includes("pw-not-real"),
  );
});

test("preflight names every missing tool instead of failing later", async () => {
  const harness = new Harness({
    repoRoot,
    options: {
      singBox: "/nonexistent/sing-box",
      agentBin: "/nonexistent/server-agent",
      postgresImage: "postgres:18-alpine",
    },
  });
  const { ok, problems } = await harness.preflight();
  assert.equal(ok, false);
  assert.ok(problems.some((p) => p.includes("/nonexistent/sing-box")), problems.join("\n"));
  assert.ok(
    problems.some((p) => p.includes("agent binary /nonexistent/server-agent not found")),
    problems.join("\n"),
  );
});

test("preflight refuses to run while the hard-coded stats port is taken", async (t) => {
  if (!(await isPortFree(8080))) {
    t.skip("127.0.0.1:8080 is already in use on this machine");
    return;
  }
  const net = await import("node:net");
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(8080, "127.0.0.1", resolve));
  try {
    const harness = new Harness({ repoRoot, options: { agentBin: "/nonexistent" } });
    const { problems } = await harness.preflight();
    assert.ok(problems.some((p) => p.includes("127.0.0.1:8080 is in use")), problems.join("\n"));
  } finally {
    holder.close();
  }
});

test("the origin serves exactly the requested number of bytes", async () => {
  const origin = await startOrigin();
  try {
    const response = await fetch(`http://127.0.0.1:${origin.port}/bytes/12345`);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, 12345);
    assert.equal((await fetch(`http://127.0.0.1:${origin.port}/other`)).status, 404);
  } finally {
    await origin.close();
  }
});

test("occupyPort blocks both the IPv4 loopback and wildcard binds, and releases on close", async () => {
  const blocker = await occupyPort();
  try {
    assert.equal(await isPortFree(blocker.port), false);
  } finally {
    await blocker.close();
  }
  assert.equal(await isPortFree(blocker.port), true);
});
