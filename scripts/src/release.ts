import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ReleaseVersionType = "major" | "minor" | "patch";

export type ReleaseOptions = {
  repositoryRoot?: string;
  bump: ReleaseVersionType;
  dryRun: boolean;
};

export type ReleasePlan = {
  current: string;
  version: string;
  tag: string;
  files: string[];
  dryRun: boolean;
};

const UNIFIED_FILES = [
  "package.json",
  "app/package.json",
  "server-agent/Cargo.toml",
  "server-agent/Cargo.lock",
] as const;

const defaultRepositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

function resolveRepositoryRoot(root?: string): string {
  return root ?? defaultRepositoryRoot;
}

function parseVersionType(value: string | undefined): ReleaseVersionType {
  const versionType = ["major", "minor", "patch"].find(
    (candidate) => candidate === value,
  );
  if (!versionType) throw new Error(`invalid --bump: ${value ?? "(missing)"}`);
  return versionType as ReleaseVersionType;
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

function serializeVersion(version: ParsedVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease.length
    ? `${base}-${version.prerelease.join(".")}`
    : base;
}

function assertStableVersion(version: ParsedVersion, label: string): void {
  if (version.prerelease.length > 0) {
    throw new Error(
      `${label} must not be a prerelease: ${serializeVersion(version)}`,
    );
  }
}

function nextStableVersion(
  current: ParsedVersion,
  versionType: ReleaseVersionType,
): ParsedVersion {
  const next = {
    major: current.major,
    minor: current.minor,
    patch: current.patch,
    prerelease: [],
  };
  if (versionType === "major") {
    next.major += 1;
    next.minor = 0;
    next.patch = 0;
  } else if (versionType === "minor") {
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
): string {
  const current = parseVersion(currentVersion);
  assertStableVersion(current, "current version");
  return serializeVersion(nextStableVersion(current, versionType));
}

async function readJson(
  root: string,
  relativePath: string,
): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(path.join(root, relativePath), "utf8"),
  ) as Record<string, unknown>;
}

export async function readAppVersion(repositoryRoot?: string): Promise<string> {
  const root = resolveRepositoryRoot(repositoryRoot);
  const rootManifest = await readJson(root, "package.json");
  const rootVersion = rootManifest.version;
  if (typeof rootVersion !== "string") {
    throw new Error("package.json is missing a version");
  }
  assertStableVersion(parseVersion(rootVersion), "package.json version");
  const appManifest = await readJson(root, "app/package.json");
  if (typeof appManifest.version !== "string") {
    throw new Error("app/package.json is missing a version");
  }
  if (appManifest.version !== rootVersion) {
    throw new Error(
      `version mismatch between package.json (${rootVersion}) and app/package.json (${appManifest.version})`,
    );
  }
  assertStableVersion(
    parseVersion(appManifest.version),
    "app/package.json version",
  );
  return rootVersion;
}

export async function readServerAgentVersion(
  repositoryRoot?: string,
): Promise<string> {
  const root = resolveRepositoryRoot(repositoryRoot);
  const manifest = await readFile(
    path.join(root, "server-agent/Cargo.toml"),
    "utf8",
  );
  const match =
    /^\[package\]\nname = "server-agent"\nversion = "([^"]+)"/m.exec(manifest);
  if (!match) throw new Error("server-agent package version not found");
  assertStableVersion(parseVersion(match[1]), "server-agent version");
  const lock = await readFile(
    path.join(root, "server-agent/Cargo.lock"),
    "utf8",
  );
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

export async function readCurrentVersion(
  repositoryRoot?: string,
): Promise<string> {
  const [appVersion, serverAgentVersion] = await Promise.all([
    readAppVersion(repositoryRoot),
    readServerAgentVersion(repositoryRoot),
  ]);
  if (appVersion !== serverAgentVersion) {
    throw new Error(
      `version mismatch between app (${appVersion}) and server-agent (${serverAgentVersion})`,
    );
  }
  return appVersion;
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

async function updateCargoVersion(
  root: string,
  version: string,
): Promise<void> {
  const manifestPath = path.join(root, "server-agent/Cargo.toml");
  const manifestSource = await readFile(manifestPath, "utf8");
  const manifestMatch =
    /^\[package\]\nname = "server-agent"\nversion = "[^"]+"/.exec(
      manifestSource,
    );
  if (!manifestMatch) throw new Error("server-agent package version not found");
  const manifestStart = manifestMatch[0].replace(
    /version = "[^"]+"$/,
    `version = "${version}"`,
  );
  await writeFile(
    manifestPath,
    replaceOnce(manifestSource, manifestMatch, manifestStart),
  );

  const lockPath = path.join(root, "server-agent/Cargo.lock");
  const lockSource = await readFile(lockPath, "utf8");
  const lockMatch =
    /\[\[package\]\]\nname = "server-agent"\nversion = "[^"]+"/.exec(
      lockSource,
    );
  if (!lockMatch) throw new Error("server-agent lock version not found");
  const lockStart = lockMatch[0].replace(
    /version = "[^"]+"$/,
    `version = "${version}"`,
  );
  await writeFile(lockPath, replaceOnce(lockSource, lockMatch, lockStart));
}

export function tagFor(version: string): string {
  assertStableVersion(parseVersion(version), "release version");
  return `v${version}`;
}

export async function createPlan(
  options: ReleaseOptions,
): Promise<ReleasePlan> {
  const current = await readCurrentVersion(options.repositoryRoot);
  const version = nextVersion(current, options.bump);
  return {
    current,
    version,
    tag: tagFor(version),
    files: [...UNIFIED_FILES],
    dryRun: options.dryRun,
  };
}

export async function applyVersion(
  version: string,
  repositoryRoot?: string,
): Promise<void> {
  const root = resolveRepositoryRoot(repositoryRoot);
  assertStableVersion(parseVersion(version), "release version");
  await updateJsonVersion(root, "package.json", version);
  await updateJsonVersion(root, "app/package.json", version);
  await updateCargoVersion(root, version);
}

export async function release(argv: string[]): Promise<ReleasePlan> {
  let bump: ReleaseVersionType | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--dry-run") {
      if (value !== undefined)
        throw new Error("--dry-run does not accept a value");
      dryRun = true;
      index -= 1;
      continue;
    }
    if (value === undefined) throw new Error(`missing value for ${name}`);
    if (name === "--bump") bump = parseVersionType(value);
    else throw new Error(`unknown option: ${name}`);
  }
  if (!bump) throw new Error("--bump is required");
  const plan = await createPlan({
    repositoryRoot: defaultRepositoryRoot,
    bump,
    dryRun,
  });
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return plan;
  }
  await applyVersion(plan.version, defaultRepositoryRoot);
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
