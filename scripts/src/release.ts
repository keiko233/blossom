import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseTarget = "app" | "server-agent" | "both";
export type ReleaseVersionType =
  | "major"
  | "minor"
  | "patch"
  | "premajor"
  | "preminor"
  | "prepatch"
  | "prerelease";
export type ReleasePreid = "beta" | "rc";

export type ReleaseOptions = {
  repositoryRoot?: string;
  target: ReleaseTarget;
  bump: ReleaseVersionType;
  preid: ReleasePreid;
  dryRun: boolean;
};

export type ReleasePlan = {
  target: ReleaseTarget;
  current: { app: string; "server-agent": string };
  version: string;
  tags: string[];
  files: string[];
  dryRun: boolean;
};

const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function resolveRepositoryRoot(root?: string): string {
  return root ?? defaultRepositoryRoot;
}

function parseTarget(value: string | undefined): ReleaseTarget {
  if (value === "app" || value === "server-agent" || value === "both") return value;
  throw new Error(`invalid --target: ${value ?? "(missing)"}`);
}

function parseVersionType(value: string | undefined): ReleaseVersionType {
  const versionType = [
    "major",
    "minor",
    "patch",
    "premajor",
    "preminor",
    "prepatch",
    "prerelease",
  ].find((candidate) => candidate === value);
  if (!versionType) throw new Error(`invalid --bump: ${value ?? "(missing)"}`);
  return versionType as ReleaseVersionType;
}

function parsePreid(value: string | undefined): ReleasePreid {
  if (value === "beta" || value === "rc") return value;
  throw new Error(`invalid --preid: ${value ?? "(missing)"}`);
}

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
};

function parseVersion(value: string): ParsedVersion {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/.exec(
      value,
    );
  if (!match) throw new Error(`invalid version: ${value}`);
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function validatePrerelease(prerelease: string[]): void {
  if (prerelease.length === 0) return;
  if (prerelease[0] !== "beta" && prerelease[0] !== "rc") {
    throw new Error(`unsupported prerelease identifier: ${prerelease[0]}`);
  }
  if (prerelease.length !== 2 || !/^(0|[1-9]\d*)$/.test(prerelease[1])) {
    throw new Error(`unsupported prerelease: ${prerelease.join(".")}`);
  }
}

function serializeVersion(version: ParsedVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length ? `${base}-${version.prerelease.join(".")}` : base;
}

function nextStableVersion(
  current: ParsedVersion,
  versionType: Exclude<ReleaseVersionType, "prerelease">,
): ParsedVersion {
  const next = {
    major: current.major,
    minor: current.minor,
    patch: current.patch,
    prerelease: [],
  };
  if (versionType === "major" || versionType === "premajor") {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (versionType === "minor" || versionType === "preminor") {
    next.minor += 1;
    next.patch = 0;
  } else {
    next.patch += 1;
  }
  return next;
}

export function nextVersion(
  currentVersion: string,
  versionType: ReleaseVersionType,
  preid: ReleasePreid,
): string {
  const current = parseVersion(currentVersion);
  validatePrerelease(current.prerelease);
  if (versionType === "prerelease") {
    if (current.prerelease.length === 0) {
      throw new Error("--bump prerelease requires a prerelease version");
    }
    const number = Number(current.prerelease[1]);
    if (preid !== current.prerelease[0] && number === 0) {
      throw new Error(`invalid prerelease transition: ${currentVersion} to ${preid}`);
    }
    return serializeVersion({ ...current, prerelease: [preid, String(number + 1)] });
  }
  const next = nextStableVersion(current, versionType);
  next.prerelease = versionType.startsWith("pre") ? [preid, "1"] : [];
  return serializeVersion(next);
}

async function readJson(
  root: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as Record<
    string,
    unknown
  >;
}

export async function readAppVersion(repositoryRoot?: string): Promise<string> {
  const root = resolveRepositoryRoot(repositoryRoot);
  const rootManifest = await readJson(root, "package.json");
  const rootVersion =
    typeof rootManifest.version === "string" ? rootManifest.version : "0.0.0";
  validatePrerelease(parseVersion(rootVersion).prerelease);
  const appManifest = await readJson(root, "app/package.json");
  if (
    typeof appManifest.version === "string" &&
    appManifest.version !== rootVersion
  ) {
    throw new Error(
      `version mismatch between package.json (${rootVersion}) and app/package.json (${appManifest.version})`,
    );
  }
  return rootVersion;
}

export async function readServerAgentVersion(repositoryRoot?: string): Promise<string> {
  const root = resolveRepositoryRoot(repositoryRoot);
  const manifest = await readFile(path.join(root, "server-agent/Cargo.toml"), "utf8");
  const match =
    /^\[package\]\nname = "server-agent"\nversion = "([^"]+)"/m.exec(manifest);
  if (!match) throw new Error("server-agent package version not found");
  validatePrerelease(parseVersion(match[1]).prerelease);
  const lock = await readFile(path.join(root, "server-agent/Cargo.lock"), "utf8");
  const lockMatch =
    /\[\[package\]\]\nname = "server-agent"\nversion = "([^"]+)"/.exec(lock);
  if (!lockMatch) throw new Error("server-agent lock version not found");
  if (lockMatch[1] !== match[1]) {
    throw new Error(
      `server-agent version mismatch between Cargo.toml (${match[1]}) and Cargo.lock (${lockMatch[1]})`,
    );
  }
  return match[1];
}

function replaceOnce(
  source: string,
  match: RegExpExecArray,
  replacement: string,
): string {
  return `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`;
}

async function updateJsonVersion(
  root: string,
  relativePath: string,
  version: string,
): Promise<void> {
  const filePath = path.join(root, relativePath);
  const source = await readFile(filePath, "utf8");
  const manifest = JSON.parse(source) as Record<string, unknown>;
  manifest.version = version;
  const ending = source.endsWith("\n") ? "\n" : "";
  await writeFile(filePath, `${JSON.stringify(manifest, null, 2)}${ending}`);
}

async function updateCargoVersion(root: string, version: string): Promise<void> {
  const manifestPath = path.join(root, "server-agent/Cargo.toml");
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifestMatch =
    /^\[package\]\nname = "server-agent"\nversion = "[^"]+"/.exec(manifestSource);
  if (!manifestMatch) throw new Error("server-agent package version not found");
  const manifestStart = manifestMatch[0].replace(/version = "[^"]+"$/, `version = "${version}"`);
  await writeFile(manifestPath, replaceOnce(manifestSource, manifestMatch, manifestStart));

  const lockPath = path.join(root, "server-agent/Cargo.lock");
  const lockSource = await readFile(lockPath, "utf8");
  const lockMatch =
    /\[\[package\]\]\nname = "server-agent"\nversion = "[^"]+"/.exec(lockSource);
  if (!lockMatch) throw new Error("server-agent lock version not found");
  const lockStart = lockMatch[0].replace(/version = "[^"]+"$/, `version = "${version}"`);
  await writeFile(lockPath, replaceOnce(lockSource, lockMatch, lockStart));
}

export function tagsFor(target: ReleaseTarget, version: string): string[] {
  parseVersion(version);
  if (target === "app") return [`v${version}`];
  if (target === "server-agent") return [`server-agent-v${version}`];
  return [`v${version}`, `server-agent-v${version}`];
}

function filesFor(target: ReleaseTarget): string[] {
  const appFiles = ["package.json", "app/package.json"];
  const agentFiles = ["server-agent/Cargo.toml", "server-agent/Cargo.lock"];
  if (target === "app") return appFiles;
  if (target === "server-agent") return agentFiles;
  return [...appFiles, ...agentFiles];
}

export async function createPlan(options: ReleaseOptions): Promise<ReleasePlan> {
  const [appVersion, serverAgentVersion] = await Promise.all([
    readAppVersion(options.repositoryRoot),
    readServerAgentVersion(options.repositoryRoot),
  ]);
  const version = nextVersion(
    options.target === "server-agent" ? serverAgentVersion : appVersion,
    options.bump,
    options.preid,
  );
  return {
    target: options.target,
    current: { app: appVersion, "server-agent": serverAgentVersion },
    version,
    tags: tagsFor(options.target, version),
    files: filesFor(options.target),
    dryRun: options.dryRun,
  };
}

export async function applyVersion(
  target: ReleaseTarget,
  version: string,
  repositoryRoot?: string,
): Promise<void> {
  const root = resolveRepositoryRoot(repositoryRoot);
  parseVersion(version);
  if (target === "app" || target === "both") {
    await updateJsonVersion(root, "package.json", version);
    await updateJsonVersion(root, "app/package.json", version);
  }
  if (target === "server-agent" || target === "both") {
    await updateCargoVersion(root, version);
  }
}

export async function release(argv: string[]): Promise<ReleasePlan> {
  let target: ReleaseTarget | undefined;
  let bump: ReleaseVersionType | undefined;
  let preid: ReleasePreid | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--dry-run") {
      if (value !== undefined) throw new Error("--dry-run does not accept a value");
      dryRun = true;
      index -= 1;
      continue;
    }
    if (value === undefined) throw new Error(`missing value for ${name}`);
    if (name === "--target") target = parseTarget(value);
    else if (name === "--bump") bump = parseVersionType(value);
    else if (name === "--preid") preid = parsePreid(value);
    else throw new Error(`unknown option: ${name}`);
  }
  if (!target || !bump) throw new Error("--target and --bump are required");
  const plan = await createPlan({
    repositoryRoot: defaultRepositoryRoot,
    target,
    bump,
    preid: preid ?? "beta",
    dryRun,
  });
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  await applyVersion(target, plan.version, defaultRepositoryRoot);
  console.log(JSON.stringify({ ...plan, applied: true }, null, 2));
  return plan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await release(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
