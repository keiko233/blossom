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
  readCurrentVersion,
  readServerAgentVersion,
  tagFor,
} from "./release.ts";

async function createFixtureRepository(version = "0.1.0"): Promise<string> {
  const repository = await mkdtemp(path.join(tmpdir(), "blossom-release-"));
  await mkdir(path.join(repository, "app"), { recursive: true });
  await mkdir(path.join(repository, "server-agent"), { recursive: true });
  await writeFile(
    path.join(repository, "package.json"),
    `${JSON.stringify({ name: "fixture", private: true, version }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repository, "app/package.json"),
    `${JSON.stringify({ name: "fixture-app", private: true, version }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repository, "server-agent/Cargo.toml"),
    `[package]\nname = "server-agent"\nversion = "${version}"\n`,
  );
  await writeFile(
    path.join(repository, "server-agent/Cargo.lock"),
    `[[package]]\nname = "other"\nversion = "1.0.0"\n\n[[package]]\nname = "server-agent"\nversion = "${version}"\n`,
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
  assert.throws(() => tagFor("1.2.3-rc.1"), /must not be a prerelease/);
});

test("reads and validates unified current version", async () => {
  const repository = await createFixtureRepository("1.3.0");
  assert.equal(await readAppVersion(repository), "1.3.0");
  assert.equal(await readServerAgentVersion(repository), "1.3.0");
  assert.equal(await readCurrentVersion(repository), "1.3.0");
});

test("rejects missing and mismatched versions across manifests", async () => {
  const repository = await createFixtureRepository("0.1.0");
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

  await writeFile(
    appManifestPath,
    `${JSON.stringify({ name: "fixture-app", private: true, version: "0.1.0" }, null, 2)}\n`,
  );
  await writeFile(
    path.join(repository, "server-agent/Cargo.toml"),
    `[package]\nname = "server-agent"\nversion = "0.2.0"\n`,
  );
  await writeFile(
    path.join(repository, "server-agent/Cargo.lock"),
    `[[package]]\nname = "server-agent"\nversion = "0.2.0"\n`,
  );
  await assert.rejects(
    readCurrentVersion(repository),
    /version mismatch between app \(0\.1\.0\) and server-agent \(0\.2\.0\)/,
  );
});

test("creates a unified release plan", async () => {
  const repository = await createFixtureRepository("1.3.0");
  const plan = await createPlan({
    repositoryRoot: repository,
    bump: "minor",
    dryRun: true,
  });
  assert.equal(plan.current, "1.3.0");
  assert.equal(plan.version, "1.4.0");
  assert.equal(plan.tag, "v1.4.0");
  assert.deepEqual(plan.files, [
    "package.json",
    "app/package.json",
    "server-agent/Cargo.toml",
    "server-agent/Cargo.lock",
  ]);
  assert.equal(tagFor(plan.version), "v1.4.0");
});

test("updates JSON and Cargo files together without external dependencies", async () => {
  const repository = await createFixtureRepository("1.3.0");
  await assert.rejects(
    applyVersion("1.2.3-beta.1", repository),
    /must not be a prerelease/,
  );
  await applyVersion("1.4.0", repository);
  assert.equal(
    JSON.parse(await readFile(path.join(repository, "package.json"), "utf8"))
      .version,
    "1.4.0",
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(repository, "app/package.json"), "utf8"),
    ).version,
    "1.4.0",
  );
  const manifest = await readFile(
    path.join(repository, "server-agent/Cargo.toml"),
    "utf8",
  );
  const lock = await readFile(
    path.join(repository, "server-agent/Cargo.lock"),
    "utf8",
  );
  assert.match(manifest, /name = "server-agent"\nversion = "1\.4\.0"/);
  assert.match(lock, /name = "server-agent"\nversion = "1\.4\.0"/);
  assert.equal(await readCurrentVersion(repository), "1.4.0");
});
