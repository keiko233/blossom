// Lifecycle of the disposable stack: PostgreSQL (Docker), the built app, the
// Rust agent with the real sing-box it supervises, and a sing-box client.
//
// Isolation rules:
//  - every port except sing-box's v2ray stats API (hard-coded by the app to
//    127.0.0.1:8080, checked in preflight) is allocated by the OS;
//  - child processes get a minimal environment, never the caller's;
//  - everything lives under one temp directory plus one labelled container;
//  - a lock stops two harness runs overlapping (they would fight over 8080)
//    and lets the next run clean up after a crashed one.

import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { ManagedProcess } from "./proc.mjs";
import {
  freePort,
  isPortFree,
  randomHex,
  redact,
  run,
  sleep,
  waitFor,
} from "./util.mjs";

export const V2RAY_API_PORT = 8080;
const LOCK_DIR = path.join(os.tmpdir(), "blossom-integration.lock");
const LABEL = "blossom-integration";

const CONTAINER_PATTERN = /^blossom-it-[0-9a-f]{8}$/;
const WORKDIR_PATTERN = /^blossom-it-[0-9a-f]{8}-/;
// A lock directory without info.json younger than this belongs to a run that
// is still starting up.
const LOCK_GRACE_MS = 30_000;

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error.code === "EPERM";
  }
}

function baseEnv() {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: "C.UTF-8",
  };
}

/**
 * The docker CLI needs the caller's environment (HOME for contexts, DOCKER_*)
 * to find the daemon; nothing from it reaches a container except the variables
 * named with a bare `-e NAME`.
 */
function dockerEnv(extra = {}) {
  return { ...process.env, ...extra };
}

/** Refuses anything but a database on this machine's loopback interface. */
export function assertLoopbackDatabase(url) {
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "[::1]") {
    throw new Error(`refusing to use a non-loopback database host '${host}'`);
  }
}

/** Only directories this harness could have created are ever deleted. */
export function isHarnessWorkdir(dir, tmp = os.tmpdir()) {
  return (
    typeof dir === "string" &&
    path.dirname(dir) === tmp &&
    WORKDIR_PATTERN.test(path.basename(dir))
  );
}

export function isHarnessContainer(name) {
  return typeof name === "string" && CONTAINER_PATTERN.test(name);
}

export class Harness {
  constructor({ repoRoot, options }) {
    this.repoRoot = repoRoot;
    this.options = options;
    this.runId = `blossom-it-${randomHex(4)}`;
    this.secrets = [];
    this.processes = [];
    this.started = [];
    this.stopping = false;
    this.fixtures = [];
    this.container = this.runId;
    this.ports = {};
    this.lockHeld = false;
    this.workdir = undefined;
  }

  log(message) {
    console.log(`[harness] ${message}`);
  }

  secret(value) {
    this.secrets.push(value);
    return value;
  }

  // -- preflight -----------------------------------------------------------

  /** Returns { ok, problems, facts } without starting anything. */
  async preflight() {
    const problems = [];
    const facts = {};
    const { repoRoot, options } = this;

    const major = Number(process.versions.node.split(".")[0]);
    facts.node = process.versions.node;
    if (major < 26) problems.push(`Node.js >= 26 is required (found ${facts.node})`);

    const pnpm = run("pnpm", ["--version"]);
    if (pnpm.status !== 0) problems.push("pnpm is not available on PATH");
    else facts.pnpm = pnpm.stdout.trim();

    if (!existsSync(path.join(repoRoot, "node_modules"))) {
      problems.push("dependencies missing: run `pnpm install --frozen-lockfile`");
    }

    const docker = run("docker", ["version", "--format", "{{.Server.Version}}"], {
      env: dockerEnv(),
    });
    if (docker.status !== 0) {
      problems.push("the Docker daemon is not reachable");
    } else {
      facts.docker = docker.stdout.trim();
      // The harness reaches PostgreSQL on a published loopback port, so the
      // daemon must be local; this also keeps a remote daemon from hosting it.
      const endpoint =
        process.env.DOCKER_HOST ??
        run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
          env: dockerEnv(),
        }).stdout.trim();
      if (endpoint && !endpoint.startsWith("unix://") && !endpoint.startsWith("npipe://")) {
        problems.push("the Docker daemon must be local (unix socket or named pipe)");
      }
    }

    const singBox = options.singBox ?? run("sh", ["-c", "command -v sing-box"]).stdout.trim();
    if (!singBox) {
      problems.push("sing-box not found: install it or pass --sing-box <path>");
    } else {
      const version = run(singBox, ["version"]);
      if (version.status !== 0) {
        problems.push(`'${singBox} version' failed`);
      } else if (!/with_v2ray_api/.test(version.stdout)) {
        problems.push(
          "sing-box was built without the with_v2ray_api tag, which traffic accounting needs",
        );
      }
      facts.singBox = singBox;
      facts.singBoxVersion = version.stdout.split("\n")[0]?.trim();
    }
    this.singBox = singBox;

    if (options.agentBin) {
      if (!existsSync(options.agentBin)) problems.push(`agent binary ${options.agentBin} not found`);
      this.agentBin = options.agentBin;
    } else {
      if (run("cargo", ["--version"]).status !== 0) {
        problems.push("cargo is not available (or pass --agent-bin <path>)");
      }
      this.agentBin = path.join(repoRoot, "server-agent", "target", "debug", "server-agent");
    }

    if (run("curl", ["--version"]).status !== 0) problems.push("curl is not available");

    if (!(await isPortFree(V2RAY_API_PORT))) {
      problems.push(
        `127.0.0.1:${V2RAY_API_PORT} is in use; the app hard-codes it as sing-box's stats API port`,
      );
    }

    const lock = this.#readLock();
    if (lock && pidAlive(lock.pid)) {
      problems.push(`another harness run (pid ${lock.pid}) holds ${LOCK_DIR}`);
    }

    return { ok: problems.length === 0, problems, facts };
  }

  // -- lock and stale cleanup ------------------------------------------------

  #readLock() {
    try {
      return JSON.parse(readFileSync(path.join(LOCK_DIR, "info.json"), "utf8"));
    } catch {
      return undefined;
    }
  }

  #acquireLock() {
    if (existsSync(LOCK_DIR)) {
      const stale = this.#readLock();
      if (stale && pidAlive(stale.pid)) {
        throw new Error(`another harness run (pid ${stale.pid}) is active`);
      }
      if (!stale && Date.now() - statSync(LOCK_DIR).mtimeMs < LOCK_GRACE_MS) {
        throw new Error(`another harness run is starting (${LOCK_DIR} is brand new)`);
      }
      this.log("removing leftovers of a previous run that did not clean up");
      // The lock file is only trusted for names this harness generates, and a
      // container is only removed if it carries this harness's label.
      if (isHarnessContainer(stale?.container)) {
        const label = run(
          "docker",
          ["inspect", "--format", `{{index .Config.Labels "${LABEL}"}}`, stale.container],
          { env: dockerEnv() },
        );
        if (label.status === 0 && label.stdout.trim() === stale.container) {
          run("docker", ["rm", "-f", stale.container], { env: dockerEnv() });
        }
      }
      if (isHarnessWorkdir(stale?.workdir)) {
        rmSync(stale.workdir, { recursive: true, force: true });
      }
      rmSync(LOCK_DIR, { recursive: true, force: true });
    }
    try {
      mkdirSync(LOCK_DIR);
    } catch (error) {
      if (error.code === "EEXIST") throw new Error("another harness run won the lock");
      throw error;
    }
    this.lockHeld = true;
    this.#writeLock();
  }

  #writeLock() {
    writeFileSync(
      path.join(LOCK_DIR, "info.json"),
      JSON.stringify({
        pid: process.pid,
        container: this.container,
        workdir: this.workdir,
      }),
    );
  }

  // -- startup -----------------------------------------------------------------

  async start() {
    this.#acquireLock();
    this.workdir = mkdtempSync(path.join(os.tmpdir(), `${this.runId}-`));
    this.#writeLock();
    for (const dir of ["logs", "home", "agent-state", "client"]) {
      mkdirSync(path.join(this.workdir, dir));
    }
    this.log(`work directory ${this.workdir}`);

    this.credentials = {
      dbPassword: this.secret(randomHex(16)),
      authSecret: this.secret(randomHex(32)),
      certificateKey: this.secret(randomHex(32)),
      adminPassword: this.secret(`Adm-${randomHex(8)}`),
      userPassword: this.secret(`Usr-${randomHex(8)}`),
    };

    await this.#startPostgres();
    await this.#migrate();
    await this.#buildApp();
    await this.#startApp();
    await this.#buildAgent();
  }

  async #startPostgres() {
    const image = this.options.postgresImage;
    if (run("docker", ["image", "inspect", image], { env: dockerEnv() }).status !== 0) {
      this.log(`pulling ${image} (not present locally)`);
      const pull = run("docker", ["pull", image], { env: dockerEnv() });
      if (pull.status !== 0) throw new Error(`docker pull ${image} failed`);
    }
    this.ports.postgres = await freePort();
    const started = run(
      "docker",
      [
        "run", "-d", "--rm",
        "--name", this.container,
        "--label", `${LABEL}=${this.runId}`,
        "-e", "POSTGRES_PASSWORD",
        "-e", "POSTGRES_USER=it",
        "-e", "POSTGRES_DB=it",
        "-p", `127.0.0.1:${this.ports.postgres}:5432`,
        "--tmpfs", "/var/lib/postgresql",
        image,
        "-c", "fsync=off",
      ],
      { env: dockerEnv({ POSTGRES_PASSWORD: this.credentials.dbPassword }) },
    );
    if (started.status !== 0) {
      throw new Error(`could not start PostgreSQL: ${redact(started.stderr, this.secrets)}`);
    }
    this.databaseUrl = `postgresql://it:${this.credentials.dbPassword}@127.0.0.1:${this.ports.postgres}/it`;
    assertLoopbackDatabase(this.databaseUrl);
    this.secret(this.databaseUrl);
    // initdb runs a throw-away server first, so wait for the real one.
    await waitFor("PostgreSQL to accept connections", () => this.psql("select 1") === "1", {
      timeoutMs: 60_000,
      intervalMs: 1000,
    });
    this.log(`PostgreSQL ready on 127.0.0.1:${this.ports.postgres}`);
  }

  /** Runs one SQL statement in the disposable database; returns trimmed -At output. */
  psql(sql) {
    const result = run("docker", [
      "exec", "-e", "PGPASSWORD",
      this.container,
      "psql", "-h", "127.0.0.1", "-U", "it", "-d", "it",
      "-At", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", sql,
    ], { env: dockerEnv({ PGPASSWORD: this.credentials.dbPassword }) });
    if (result.status !== 0) {
      throw new Error(`psql failed: ${redact(result.stderr, this.secrets).trim()}`);
    }
    return result.stdout.trim();
  }

  async #migrate() {
    this.log("applying migrations to the disposable database");
    // DATABASE_URL is set explicitly; drizzle.config.ts only fills in values
    // from .env files that are not already set, so a developer's .env.local
    // cannot redirect this.
    const result = run(
      "pnpm",
      ["--filter", "@blossom/app", "db:migrate"],
      {
        cwd: this.repoRoot,
        env: {
          ...baseEnv(),
          HOME: process.env.HOME ?? "",
          DATABASE_URL: this.databaseUrl,
        },
      },
    );
    writeFileSync(path.join(this.workdir, "logs", "migrate.log"), redact(result.stdout + result.stderr, this.secrets));
    if (result.status !== 0) throw new Error("db:migrate failed (see logs/migrate.log)");
    const tables = Number(
      this.psql("select count(*) from information_schema.tables where table_schema = 'public'"),
    );
    if (tables < 10) throw new Error(`migration left only ${tables} tables`);
  }

  async #buildApp() {
    const output = path.join(this.repoRoot, "app", ".output", "server", "index.mjs");
    if (this.options.reuseBuild && existsSync(output)) {
      this.log("reusing existing app/.output build (--reuse-build)");
      return;
    }
    this.log("building the app for the node target (pnpm build:node)");
    const result = run("pnpm", ["--filter", "@blossom/app", "build:node"], {
      cwd: this.repoRoot,
      env: { ...baseEnv(), HOME: process.env.HOME ?? "" },
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(path.join(this.workdir, "logs", "build.log"), result.stdout + result.stderr);
    if (result.status !== 0) throw new Error("app build failed (see logs/build.log)");
  }

  async #startApp() {
    this.#assertNotStopping();
    this.ports.app = await freePort();
    this.appUrl = `http://127.0.0.1:${this.ports.app}`;
    const env = {
      ...baseEnv(),
      HOME: path.join(this.workdir, "home"),
      NODE_ENV: "production",
      HOST: "127.0.0.1",
      NITRO_HOST: "127.0.0.1",
      PORT: String(this.ports.app),
      NITRO_PORT: String(this.ports.app),
      APP_NAME: "Blossom Integration",
      DATABASE_URL: this.databaseUrl,
      DATABASE_DRIVER: "node-postgres",
      BETTER_AUTH_URL: this.appUrl,
      BETTER_AUTH_SECRET: this.credentials.authSecret,
      CERTIFICATE_MASTER_KEY: Buffer.from(this.credentials.certificateKey, "hex").toString("base64url"),
    };
    const app = new ManagedProcess(
      "app",
      process.execPath,
      [path.join(this.repoRoot, "app", ".output", "server", "index.mjs")],
      { env, cwd: path.join(this.repoRoot, "app"), logFile: path.join(this.workdir, "logs", "app.log") },
    );
    this.#register(app);
    this.app = app;
    await waitFor(
      "the app health check",
      async () => {
        if (!app.running) throw new Error("app exited early");
        const response = await fetch(`${this.appUrl}/api/health`);
        return response.ok;
      },
      { timeoutMs: 60_000 },
    );
    this.log(`app ready on ${this.appUrl}`);
  }

  async #buildAgent() {
    if (this.options.agentBin) return;
    this.log("building the agent (cargo build --locked)");
    const result = run("cargo", ["build", "--locked"], {
      cwd: path.join(this.repoRoot, "server-agent"),
      env: { ...baseEnv(), HOME: process.env.HOME ?? "", CARGO_HOME: process.env.CARGO_HOME ?? path.join(process.env.HOME ?? "", ".cargo"), RUSTUP_HOME: process.env.RUSTUP_HOME ?? path.join(process.env.HOME ?? "", ".rustup") },
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(path.join(this.workdir, "logs", "agent-build.log"), result.stdout + result.stderr);
    if (result.status !== 0) throw new Error("agent build failed (see logs/agent-build.log)");
  }

  /** Called before spawning, so a signal-triggered teardown is not raced by new children. */
  #assertNotStopping() {
    if (this.stopping) throw new Error("the harness is shutting down");
  }

  #register(proc) {
    this.processes.push(proc);
    this.started.push(proc);
  }

  // -- agent and sing-box ---------------------------------------------------------

  startAgent(token, { pollSeconds = 5 } = {}) {
    this.#assertNotStopping();
    this.secret(token);
    const agent = new ManagedProcess(
      "agent",
      this.agentBin,
      [
        "--url", `${this.appUrl}/api`,
        "--state-dir", path.join(this.workdir, "agent-state"),
        "--sing-box-path", this.singBox,
        "--interval", String(pollSeconds),
        "--log-level", "info",
      ],
      {
        env: { ...baseEnv(), HOME: path.join(this.workdir, "home"), AGENT_TOKEN: token },
        cwd: this.workdir,
        logFile: path.join(this.workdir, "logs", "agent.log"),
        trackEveryMs: 1000,
      },
    );
    this.#register(agent);
    this.agent = agent;
    return agent;
  }

  async stopAgent() {
    if (!this.agent) return;
    await this.agent.stop();
    this.processes = this.processes.filter((p) => p !== this.agent);
    this.agent = undefined;
  }

  /** Writes a sing-box client config and runs it; returns { port, process }. */
  async startClient(name, config) {
    this.#assertNotStopping();
    const dir = path.join(this.workdir, "client");
    const file = path.join(dir, `${name}.json`);
    writeFileSync(file, JSON.stringify(config, null, 2));
    this.secret(config.outbounds[0].uuid);
    const check = run(this.singBox, ["check", "-c", file]);
    if (check.status !== 0) {
      throw new Error(`client config ${name} failed sing-box check: ${check.stderr.trim()}`);
    }
    const proc = new ManagedProcess(`client-${name}`, this.singBox, ["run", "-c", file], {
      env: { ...baseEnv(), HOME: path.join(this.workdir, "home") },
      cwd: dir,
      logFile: path.join(this.workdir, "logs", `client-${name}.log`),
    });
    this.#register(proc);
    const port = config.inbounds[0].listen_port;
    await waitFor(`client ${name} to listen`, async () => !(await isPortFree(port)), {
      timeoutMs: 15_000,
      intervalMs: 200,
    });
    return { port, process: proc };
  }

  async stopProcess(proc) {
    await proc.stop();
    this.processes = this.processes.filter((p) => p !== proc);
  }

  /**
   * Fetches through a client's SOCKS inbound; never throws on proxy failure.
   * Must be asynchronous: the origin it downloads from runs in this process.
   */
  async fetchViaProxy(port, url, { maxSeconds = 15 } = {}) {
    const result = await new Promise((resolve) => {
      execFile(
        "curl",
        [
          "-sS", "--max-time", String(maxSeconds),
          "--socks5-hostname", `127.0.0.1:${port}`,
          "-o", "/dev/null",
          "-w", "%{http_code} %{size_download}",
          url,
        ],
        { encoding: "utf8" },
        (error, stdout, stderr) => {
          resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
        },
      );
    });
    const [code, size] = result.stdout.trim().split(" ");
    return {
      ok: result.status === 0 && code === "200",
      curlExit: result.status,
      status: Number(code) || 0,
      bytes: Number(size) || 0,
      error: result.stderr.trim(),
    };
  }

  // -- diagnostics and cleanup ---------------------------------------------------------

  logTail(name, lines = 40) {
    const proc = this.processes.find((p) => p.name === name) ?? (name === "app" ? this.app : undefined);
    const raw = proc ? proc.tail(lines) : "";
    return redact(raw, this.secrets);
  }

  dumpLogs() {
    for (const name of ["app", "agent"]) {
      const file = path.join(this.workdir ?? "", "logs", `${name}.log`);
      if (!existsSync(file)) continue;
      const tail = readFileSync(file, "utf8").split("\n").slice(-30).join("\n");
      console.log(`--- last lines of ${name}.log (redacted) ---\n${redact(tail, this.secrets)}`);
    }
  }

  async stop() {
    this.stopping = true;
    for (const proc of [...this.processes].reverse()) {
      try {
        await proc.stop();
      } catch (error) {
        console.error(`[harness] failed to stop ${proc.name}: ${error.message}`);
      }
    }
    this.processes = [];
    for (const fixture of this.fixtures) {
      try {
        await fixture.close();
      } catch {
        // already closed
      }
    }
    this.fixtures = [];
    if (this.container) run("docker", ["rm", "-f", this.container], { env: dockerEnv() });
    // SIGKILL is asynchronous; give the processes a moment to disappear.
    for (let i = 0; i < 30 && this.started.some((p) => p.survivors().length > 0); i += 1) {
      await sleep(100);
    }
    if (this.options.keep) {
      this.log(`--keep: leaving ${this.workdir} (the container is still removed)`);
    } else if (this.workdir) {
      rmSync(this.workdir, { recursive: true, force: true });
    }
    if (this.lockHeld) {
      rmSync(LOCK_DIR, { recursive: true, force: true });
      this.lockHeld = false;
    }
  }

  /** Anything of ours still alive after stop(); empty means a clean teardown. */
  leftovers() {
    const found = [];
    const containers = run("docker", ["ps", "-aq", "--filter", `label=${LABEL}=${this.runId}`], {
      env: dockerEnv(),
    });
    if (containers.stdout.trim()) found.push(`docker container ${this.container}`);
    for (const proc of this.started) found.push(...proc.survivors());
    if (this.workdir && !this.options.keep && existsSync(this.workdir)) {
      found.push(`directory ${this.workdir}`);
    }
    if (existsSync(LOCK_DIR)) found.push(`lock ${LOCK_DIR}`);
    return found;
  }
}
