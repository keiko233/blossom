import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  applyVersion,
  createPlan,
  nextVersion,
  readAppVersion,
  readServerAgentVersion,
  tagsFor,
} from "./release.ts";

async function createFixtureRepository(): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), "blossom-release-"));
  await mkdir(path.join(repository, "app"), { recursive: true });
  await mkdir(path.join(repository, "server-agent"), { recursive: true });
  await writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, version: "0.1.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repository, "app/package.json"),
    `${JSON.stringify({ name: "fixture-app", private: true, version: "0.1.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repository, "server-agent/Cargo.toml"),
    `[package]\nname = "server-agent"\nversion = "0.2.0"\n`,
  );
  await writeFile(
    path.join(repository, "server-agent/Cargo.lock"),
    `[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "server-agent"\nversion = "0.2.0"\n`,
  );
  return repository;
}

test("bumps stable versions", () => {
  assert.equal(nextVersion("0.0.0", "patch"), "0.0.1");
  assert.equal(nextVersion("1.2.3", "major"), "2.0.0");
  assert.equal(nextVersion("1.2.3", "minor"), "1.3.0");
});

test("rejects invalid and prerelease versions", () => {
  assert.throws(() => nextVersion("1.2", "patch"));
  assert.throws(
    () => nextVersion("1.2.3-beta.1", "patch"),
    /must not be a prerelease/,
  );
  assert.throws(() => tagsFor("app", "1.2.3-rc.1"), /must not be a prerelease/);
});

test("reads and validates current versions", async () => {
  const repository = await createFixtureRepository();
  assert.equal(await readAppVersion(repository), "0.1.0");
  assert.equal(await readServerAgentVersion(repository), "0.2.0");
  assert.ok(repository.length > 0);
});

test("rejects missing and mismatched app versions", async () => {
  const repository = await createFixtureRepository();
  const rootManifestPath = path.join(repository, "package.json");
  const appManifestPath = path.join(repository, "app/package.json");
  const rootManifest = JSON.parse(await readFile(rootManifestPath, "utf8"));
  delete rootManifest.version;
  await writeFile(
    rootManifestPath,
    `${JSON.stringify(rootManifest, null, 2)}\n`,
  );
  await assert.rejects(readAppVersion(repository), /missing a version/);

  await writeFile(
    rootManifestPath,
    `${JSON.stringify({ name: "fixture", private: true, version: "0.1.0" }, null, 2)}\n`,
  );
  await writeFile(
    appManifestPath,
    `${JSON.stringify({ name: "@fixture/app", private: true, version: "0.1.1" }, null, 2)}\n`,
  );
  await assert.rejects(readAppVersion(repository), /version mismatch/);
});

test("creates independent release lines", async () => {
  const repository = await createFixtureRepository();
  const appPlan = await createPlan({
    repositoryRoot: repository,
    target: "app",
    bump: "patch",
    dryRun: true,
  });
  const agentPlan = await createPlan({
    repositoryRoot: repository,
    target: "server-agent",
    bump: "patch",
    dryRun: true,
  });
  const bothPlan = await createPlan({
    repositoryRoot: repository,
    target: "both",
    bump: "minor",
    dryRun: true,
  });
  assert.equal(appPlan.version, "0.1.1");
  assert.equal(agentPlan.version, "0.2.1");
  assert.equal(bothPlan.version, "0.2.0");
  assert.deepEqual(tagsFor("app", appPlan.version), ["v0.1.1"]);
  assert.deepEqual(tagsFor("server-agent", agentPlan.version), [
    "server-agent-v0.2.1",
  ]);
  assert.deepEqual(tagsFor("both", bothPlan.version), [
    "v0.2.0",
    "server-agent-v0.2.0",
  ]);
  assert.ok(repository.length > 0);
});

test("updates JSON and Cargo files without external dependencies", async () => {
  const repository = await createFixtureRepository();
  await assert.rejects(
    applyVersion("app", "1.2.3-beta.1", repository),
    /must not be a prerelease/,
  );
  await applyVersion("app", "1.2.3", repository);
  await applyVersion("server-agent", "2.3.4", repository);
  assert.equal(
    JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"))
      .version,
    "1.2.3",
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(repository, "app/package.json"), "utf8"),
    ).version,
    "1.2.3",
  );
  const manifest = await readFile(
    path.join(repository, "server-agent/Cargo.toml"),
    "utf8",
  );
  const lock = await readFile(
    path.join(repository, "server-agent/Cargo.lock"),
    "utf8",
  );
  assert.match(manifest, /name = "server-agent"\nversion = "2\.3\.4"/);
  assert.match(lock, /name = "server-agent"\nversion = "2\.3\.4"/);
});
