// Integrated OAuth enrollment + WebSocket v2 runtime check.
//
// Runs the built Node control plane with Better Auth over a disposable
// PostgreSQL cluster, the real Rust agent, and the real installer script in the
// existing fake-systemd sandbox. No shared-host install, DNS, or service
// mutation: the installer is path-rewritten into a temp root and its `curl`,
// `systemctl`, `useradd`, `id` and `uname` are fakes.
//
// The Rust WebSocket client trusts webpki roots only, so a self-signed local
// HTTPS origin cannot carry its wss session. The admin/installer origin is
// HTTPS (the installer refuses anything else); the agent's WS runtime uses the
// loopback HTTP origin the agent explicitly permits, in front of the same
// app/database. Both origins run the same built server.
//
// Usage:
//   node tests/integration/blossom/oauth-runtime.mjs --agent-bin <path> \
//     --sing-box-archive <tar.gz> [--release-version 1.3.0] \
//     [--sing-box-version 1.14.4] [--agent-url <https url>] \
//     [--sing-box-url <https url>] [--keep] [--workdir <dir>]
//
// The approved-release catalog must contain the matching synthetic release for
// this run. That catalog entry is disposable test data: do not commit it.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { AppClient } from "./lib/serverfn.mjs";
import { freePort, redact, run, sleep, waitFor } from "./lib/util.mjs";

const REPO = path.resolve(import.meta.dirname, "../../..");
const OUTPUT = path.join(REPO, "app", ".output", "server", "index.mjs");
const V2_PROTOCOL = "blossom-agent.v2";

const RELEASE_CAPABILITIES = [
  "config-v3",
  "ws-v1",
  "credentials-file-v1",
  "oauth-enrollment-cli-v1",
  "oauth-ws-v1",
];

const secrets = [];
function secret(value) {
  secrets.push(value);
  return value;
}

function log(message) {
  process.stdout.write(`[oauth-it] ${message}\n`);
}

function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function parseArgs(argv) {
  const options = {
    keep: false,
    workdir: undefined,
    releaseVersion: "1.3.0",
    singBoxVersion: "1.14.4",
    agentUrl: "https://artifacts.invalid/server-agent-amd64",
    singBoxUrl: "https://artifacts.invalid/sing-box-amd64.tar.gz",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--keep") options.keep = true;
    else if (arg === "--agent-bin") options.agentBin = argv[++index];
    else if (arg === "--sing-box-archive") {
      options.singBoxArchive = argv[++index];
    } else if (arg === "--workdir") options.workdir = argv[++index];
    else if (arg === "--release-version")
      options.releaseVersion = argv[++index];
    else if (arg === "--sing-box-version")
      options.singBoxVersion = argv[++index];
    else if (arg === "--agent-url") options.agentUrl = argv[++index];
    else if (arg === "--sing-box-url") options.singBoxUrl = argv[++index];
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!options.agentBin || !options.singBoxArchive) {
    throw new Error("--agent-bin and --sing-box-archive are required");
  }
  return options;
}

// ---------------------------------------------------------------- PostgreSQL

function startPostgres(root) {
  const data = path.join(root, "pg");
  const sock = path.join(root, "pg-sock");
  const logFile = path.join(root, "pg.log");
  mkdirSync(sock, { recursive: true });
  const init = run(
    "initdb",
    ["-D", data, "-U", "postgres", "--auth=trust", "--no-locale", "-E", "UTF8"],
    { encoding: "utf8" },
  );
  if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
  return freePort().then((port) => {
    const start = run(
      "pg_ctl",
      [
        "-D",
        data,
        "-l",
        logFile,
        "-o",
        `-p ${port} -k ${sock} -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off`,
        "start",
      ],
      { encoding: "utf8" },
    );
    if (start.status !== 0) {
      throw new Error(`pg_ctl start failed: ${start.stderr} ${start.stdout}`);
    }
    return { data, port, sock, logFile };
  });
}

function psql(pg, sql, database = "blossom_disposable_oauth") {
  const result = run("psql", [
    "-h",
    "127.0.0.1",
    "-p",
    String(pg.port),
    "-U",
    "postgres",
    "-d",
    database,
    "-At",
    "-F",
    "|",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    sql,
  ]);
  if (result.status !== 0) {
    throw new Error(`psql failed: ${redact(result.stderr, secrets).trim()}`);
  }
  return result.stdout.trim();
}

async function prepareDatabase(root, pg) {
  const created = run("createdb", [
    "-h",
    "127.0.0.1",
    "-p",
    String(pg.port),
    "-U",
    "postgres",
    "blossom_disposable_oauth",
  ]);
  if (created.status !== 0)
    throw new Error(`createdb failed: ${created.stderr}`);
  const url = `postgresql://postgres@127.0.0.1:${pg.port}/blossom_disposable_oauth`;
  secret(url);
  log("applying migrations to the disposable database");
  const migrate = run("pnpm", ["--filter", "@blossom/app", "db:migrate"], {
    cwd: REPO,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATABASE_URL: url,
    },
    encoding: "utf8",
  });
  writeFileSync(
    path.join(root, "logs", "migrate.log"),
    migrate.stdout + migrate.stderr,
  );
  if (migrate.status !== 0) throw new Error("db:migrate failed");
  const tables = Number(
    psql(
      pg,
      "select count(*) from information_schema.tables where table_schema = 'public'",
    ),
  );
  if (tables < 10) throw new Error(`migration left only ${tables} tables`);
  return url;
}

// ---------------------------------------------------------------- processes

const children = [];
const listeners = [];

function startProcess(name, command, args, options) {
  const logFile = path.join(options.workdir, "logs", `${name}.log`);
  mkdirSync(path.dirname(logFile), { recursive: true });
  const fd = openSync(logFile, "a");
  const child = spawn(command, args, {
    cwd: options.cwd ?? REPO,
    env: options.env,
    stdio: ["ignore", fd, fd],
  });
  closeSync(fd);
  const exited = new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
    child.once("error", (error) => resolve({ error }));
  });
  const record = { name, child, logFile, exited };
  children.push(record);
  return record;
}

function stopProcess(record, signal = "SIGTERM") {
  if (!record?.child || record.child.exitCode !== null) return;
  try {
    record.child.kill(signal);
  } catch {
    // already gone
  }
}

async function waitHttp(url, timeoutMs = 60_000) {
  await waitFor(
    `health at ${url}`,
    async () => {
      const response = await fetch(`${url}/api/health`);
      return response.ok;
    },
    { timeoutMs, intervalMs: 500 },
  );
}

function appEnv({ port, databaseUrl, authSecret, authUrl, certificateKey }) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    LANG: "C.UTF-8",
    NODE_ENV: "production",
    HOST: "127.0.0.1",
    NITRO_HOST: "127.0.0.1",
    PORT: String(port),
    NITRO_PORT: String(port),
    APP_NAME: "Blossom OAuth Integration",
    DATABASE_URL: databaseUrl,
    DATABASE_DRIVER: "node-postgres",
    BETTER_AUTH_URL: authUrl,
    BETTER_AUTH_SECRET: authSecret,
    CERTIFICATE_MASTER_KEY: certificateKey,
  };
}

// ---------------------------------------------------------------- proxies

function rawHeaders(headers) {
  const lines = [];
  for (let index = 0; index < headers.length; index += 2) {
    lines.push(`${headers[index]}: ${headers[index + 1]}`);
  }
  return `${lines.join("\r\n")}\r\n\r\n`;
}

function tlsOrigin({ cert, key, targetPort }) {
  const server = https.createServer({ cert, key }, (request, response) => {
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: request.method,
        path: request.url,
        headers: request.headers,
      },
      (upstreamResponse) => {
        response.writeHead(
          upstreamResponse.statusCode,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  server.on("upgrade", (request, clientSocket, head) => {
    const upstream = net.connect(targetPort, "127.0.0.1", () => {
      upstream.write(
        `${request.method} ${request.url} HTTP/1.1\r\n${rawHeaders(request.rawHeaders)}`,
      );
      if (head?.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => upstream.destroy());
  });
  return server;
}

class FrameReader {
  constructor(direction, sink) {
    this.direction = direction;
    this.sink = sink;
    this.buffer = Buffer.alloc(0);
    this.fragments = null;
    this.fragmentOpcode = 0;
    this.closed = false;
  }

  feed(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    this.#parse();
  }

  #parse() {
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0];
      const second = this.buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < offset + 2) return;
        length = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (this.buffer.length < offset + 8) return;
        const big = this.buffer.readBigUInt64BE(offset);
        if (big > 64n * 1024n * 1024n) {
          this.closed = true;
          return;
        }
        length = Number(big);
        offset += 8;
      }
      let mask;
      if (masked) {
        if (this.buffer.length < offset + 4) return;
        mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(
        this.buffer.subarray(offset, offset + length),
      );
      this.buffer = this.buffer.subarray(offset + length);
      if (masked) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }
      this.#frame(opcode, fin, payload);
    }
  }

  #frame(opcode, fin, payload) {
    if (opcode === 8) {
      const code = payload.length >= 2 ? payload.readUInt16BE(0) : null;
      const reason = payload.length > 2 ? payload.subarray(2).toString() : "";
      this.sink({ direction: this.direction, type: "close", code, reason });
      this.closed = true;
      return;
    }
    if (opcode === 9 || opcode === 10) return;
    if (opcode === 0) {
      this.fragments = Buffer.concat([
        this.fragments ?? Buffer.alloc(0),
        payload,
      ]);
      if (fin) {
        this.#message(this.fragmentOpcode, this.fragments);
        this.fragments = null;
      }
      return;
    }
    if (!fin) {
      this.fragmentOpcode = opcode;
      this.fragments = payload;
      return;
    }
    this.#message(opcode, payload);
  }

  #message(opcode, payload) {
    if (opcode !== 1) {
      this.sink({
        direction: this.direction,
        type: "binary",
        bytes: payload.length,
      });
      return;
    }
    let frame;
    try {
      frame = JSON.parse(payload.toString("utf8"));
    } catch {
      this.sink({ direction: this.direction, type: "unparseable" });
      return;
    }
    this.sink({
      direction: this.direction,
      type: frame.type,
      v: frame.v,
      payload: summarizeFrame(frame),
    });
  }
}

function summarizeFrame(frame) {
  const payload = frame.payload;
  if (!payload || typeof payload !== "object") return undefined;
  switch (frame.type) {
    case "hello":
      return {
        applied: payload.applied,
        build: payload.build,
        capabilities: payload.capabilities,
      };
    case "welcome":
      return {
        sessionId: payload.sessionId,
        desired: payload.desired,
        statusIntervalSeconds: payload.statusIntervalSeconds,
        limits: payload.limits,
      };
    case "config.get":
      return { requestId: payload.requestId, reason: payload.reason };
    case "config.snapshot.begin":
      return {
        requestId: payload.requestId,
        desired: payload.desired,
        totalBytes: payload.totalBytes,
        chunkCount: payload.chunkCount,
        digest: payload.digest,
      };
    case "config.snapshot.chunk":
      return { requestId: payload.requestId, index: payload.index };
    case "config.snapshot.end":
    case "config.snapshot.error":
      return { requestId: payload.requestId, code: payload.code };
    case "config.ack":
      return {
        requestId: payload.requestId,
        desired: payload.desired,
        outcome: payload.outcome,
        stage: payload.stage,
        error: payload.error,
      };
    case "agent.status":
      return {
        reason: payload.reason,
        runtimeState: payload.runtimeState,
        configState: payload.configState,
        singBoxVersion: payload.singBoxVersion,
        activeNodeIds: payload.activeNodeIds?.length,
      };
    case "agent.status.ack":
      return { desired: payload.desired };
    case "traffic.report":
      return {
        reportId: payload.reportId,
        entries: Array.isArray(payload.entries)
          ? payload.entries.length
          : undefined,
      };
    case "traffic.ack":
      return { reportId: payload.reportId, result: payload.result };
    case "error":
      return { code: payload.code, message: payload.message };
    default:
      return undefined;
  }
}

function loggingOrigin({ targetPort }) {
  const requests = [];
  const upgrades = [];
  const frames = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const record = { method: request.method, path: request.url, status: 0 };
    requests.push(record);
    const upstream = http.request(
      {
        host: "127.0.0.1",
        port: targetPort,
        method: request.method,
        path: request.url,
        headers: { ...request.headers, host: `127.0.0.1:${targetPort}` },
      },
      (upstreamResponse) => {
        record.status = upstreamResponse.statusCode;
        response.writeHead(
          upstreamResponse.statusCode,
          upstreamResponse.statusMessage,
          upstreamResponse.headers,
        );
        upstreamResponse.pipe(response);
      },
    );
    upstream.on("error", () => {
      record.status = 502;
      response.destroy();
    });
    request.pipe(upstream);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, clientSocket, head) => {
    upgrades.push({
      path: request.url,
      offered: request.headers["sec-websocket-protocol"] ?? null,
      accepted: null,
    });
    const upstream = http.request({
      host: "127.0.0.1",
      port: targetPort,
      method: request.method,
      path: request.url,
      headers: { ...request.headers, host: `127.0.0.1:${targetPort}` },
    });
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      const record = upgrades.at(-1);
      record.accepted =
        upstreamResponse.headers["sec-websocket-protocol"] ?? null;
      clientSocket.write(
        `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n${rawHeaders(upstreamResponse.rawHeaders)}`,
      );
      if (upstreamHead?.length) clientSocket.write(upstreamHead);
      if (head?.length) upstreamSocket.write(head);

      const toServer = new FrameReader("agent->control", (frame) =>
        frames.push(frame),
      );
      const toAgent = new FrameReader("control->agent", (frame) =>
        frames.push(frame),
      );
      clientSocket.on("data", (chunk) => {
        toServer.feed(chunk);
        upstreamSocket.write(chunk);
      });
      upstreamSocket.on("data", (chunk) => {
        toAgent.feed(chunk);
        clientSocket.write(chunk);
      });
      clientSocket.on("close", () => upstreamSocket.destroy());
      upstreamSocket.on("close", () => clientSocket.destroy());
      clientSocket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => clientSocket.destroy());
    });
    upstream.on("response", (upstreamResponse) => {
      const record = upgrades.at(-1);
      record.status = upstreamResponse.statusCode;
      clientSocket.write(
        `HTTP/1.1 ${upstreamResponse.statusCode} ${upstreamResponse.statusMessage}\r\n${rawHeaders(upstreamResponse.rawHeaders)}`,
      );
      upstreamResponse.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
    upstream.end();
  });
  return {
    server,
    requests,
    upgrades,
    frames,
    resetFrames() {
      frames.length = 0;
    },
    async destroy() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------- installer sandbox

function fakeBin(dir, state, agentUrl, singBoxUrl, agentFile, singBoxArchive) {
  mkdirSync(dir, { recursive: true });
  const write = (name, body) => {
    const file = path.join(dir, name);
    writeFileSync(file, body);
    chmodSync(file, 0o755);
  };
  write(
    "curl",
    `#!/bin/sh
set -eu
output=
url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --output|-o) output=$2; shift 2 ;;
    --proto|--proto-redir|--retry|--retry-delay|--connect-timeout|--max-time) shift 2 ;;
    --fail|--show-error|--silent|--location|--tlsv1.2) shift ;;
    *) url=$1; shift ;;
  esac
done
[ -n "$output" ] || exit 64
printf '%s\\n' "$url" >>"$FAKE_STATE/curl.log"
case "$url" in
  "$FAKE_AGENT_URL") cp "$FAKE_AGENT" "$output" ;;
  "$FAKE_SING_BOX_URL") cp "$FAKE_SING_BOX_ARCHIVE" "$output" ;;
  *) exit 22 ;;
esac
`,
  );
  write(
    "systemctl",
    `#!/bin/sh
set -eu
command=$1
shift || true
printf '%s\\n' "$command" >>"$FAKE_STATE/systemctl.log"
case "$command" in
  --version) echo "systemd 255"; exit 0 ;;
  daemon-reload|enable|disable) exit 0 ;;
  stop) rm -f "$FAKE_STATE/active"; exit 0 ;;
  start|restart) touch "$FAKE_STATE/active"; exit 0 ;;
  is-active) [ -f "$FAKE_STATE/active" ] && exit 0 || exit 3 ;;
  status) echo "fake blossom-agent active"; exit 0 ;;
  *) exit 64 ;;
esac
`,
  );
  write(
    "uname",
    `#!/bin/sh
case "$1" in
  -s) echo Linux ;;
  -m) echo x86_64 ;;
  *) exit 64 ;;
esac
`,
  );
  write(
    "id",
    `#!/bin/sh
case "$1" in
  -u) echo 0; exit 0 ;;
  -gn) echo "$(id -gn)"; exit 0 ;;
  *) echo "$(id)"; exit 0 ;;
esac
`,
  );
  write("useradd", "#!/bin/sh\nexit 0\n");
  write("userdel", "#!/bin/sh\nexit 0\n");
  return { dir, state, agentUrl, singBoxUrl, agentFile, singBoxArchive };
}

function rewriteInstaller(script, sandbox, user, group) {
  return script
    .replaceAll(
      "/usr/local/lib/blossom-agent",
      path.join(sandbox.root, "usr/local/lib/blossom-agent"),
    )
    .replaceAll(
      "/etc/blossom-agent",
      path.join(sandbox.root, "etc/blossom-agent"),
    )
    .replaceAll(
      "/etc/systemd/system",
      path.join(sandbox.root, "etc/systemd/system"),
    )
    .replaceAll(
      "/var/lib/blossom-agent",
      path.join(sandbox.root, "var/lib/blossom-agent"),
    )
    .replace(
      "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
      `PATH=${sandbox.bin}:/usr/sbin:/usr/bin:/sbin:/bin`,
    )
    .replaceAll("SERVICE_USER=blossom-agent", `SERVICE_USER=${user}`)
    .replaceAll("SERVICE_GROUP=blossom-agent", `SERVICE_GROUP=${group}`)
    .replaceAll("userdel blossom-agent", `userdel ${user}`);
}

function runInstaller(scriptPath, env, input) {
  return runCapture("sh", [scriptPath], { env, input });
}

function runCapture(command, args, { env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      resolve({ status: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

// ---------------------------------------------------------------- JWT

function decodeJwt(token) {
  const [, payload] = token.split(".");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
}

// ---------------------------------------------------------------- main

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const { releaseVersion, singBoxVersion } = options;
  if (!existsSync(OUTPUT)) {
    throw new Error(
      "app/.output is missing; run pnpm --filter @blossom/app build:node",
    );
  }
  const root = options.workdir
    ? options.workdir
    : mkdtempSync(path.join(os.tmpdir(), "blossom-oauth-it-"));
  mkdirSync(path.join(root, "logs"), { recursive: true });
  mkdirSync(path.join(root, "home"), { recursive: true });
  log(`workdir ${root}`);

  const agentBin = path.resolve(options.agentBin);
  const singBoxArchive = path.resolve(options.singBoxArchive);
  const agentDigest = sha256File(agentBin);
  const singBoxDigest = sha256File(singBoxArchive);
  log(
    `agent ${agentDigest.slice(0, 12)}… sing-box archive ${singBoxDigest.slice(0, 12)}…`,
  );

  const postgres = await startPostgres(root);
  try {
    const databaseUrl = await prepareDatabase(root, postgres);
    const authSecret = secret(randomUUID().replaceAll("-", ""));
    const certificateKey = Buffer.from(authSecret.slice(0, 32)).toString(
      "base64url",
    );

    const ports = {
      tls: await freePort(),
      appA: await freePort(),
      proxyB: await freePort(),
      appB: await freePort(),
    };
    const originA = `https://127.0.0.1:${ports.tls}`;
    const originB = `http://127.0.0.1:${ports.proxyB}`;

    // TLS material for the admin/installer origin.
    const caKey = path.join(root, "ca.key");
    const caPem = path.join(root, "ca.pem");
    const serverKey = path.join(root, "server.key");
    const serverCsr = path.join(root, "server.csr");
    const serverPem = path.join(root, "server.pem");
    const ext = path.join(root, "server.ext");
    writeFileSync(ext, "subjectAltName=IP:127.0.0.1,DNS:localhost\n");
    const openssl = (args) => {
      const result = run("openssl", args, { encoding: "utf8" });
      if (result.status !== 0) throw new Error(result.stderr);
    };
    openssl([
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      caKey,
      "-out",
      caPem,
      "-days",
      "1",
      "-subj",
      "/CN=Blossom Integration CA",
    ]);
    openssl([
      "req",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      serverKey,
      "-out",
      serverCsr,
      "-subj",
      "/CN=127.0.0.1",
    ]);
    openssl([
      "x509",
      "-req",
      "-in",
      serverCsr,
      "-CA",
      caPem,
      "-CAkey",
      caKey,
      "-CAcreateserial",
      "-out",
      serverPem,
      "-days",
      "1",
      "-extfile",
      ext,
    ]);

    const tls = tlsOrigin({
      cert: readFileSync(serverPem),
      key: readFileSync(serverKey),
      targetPort: ports.appA,
    });
    await listen(tls, ports.tls);
    listeners.push(tls);
    let logging = loggingOrigin({ targetPort: ports.appB });
    await listen(logging.server, ports.proxyB);
    listeners.push(logging.server);

    log("starting the built Node app on the HTTPS admin/installer origin");
    startProcess("app-a", process.execPath, [OUTPUT], {
      workdir: root,
      cwd: path.join(REPO, "app"),
      env: appEnv({
        port: ports.appA,
        databaseUrl,
        authSecret,
        authUrl: originA,
        certificateKey,
      }),
    });
    await waitHttp(originA);

    log("starting the same build on the loopback HTTP agent origin");
    const appB = startProcess("app-b", process.execPath, [OUTPUT], {
      workdir: root,
      cwd: path.join(REPO, "app"),
      env: appEnv({
        port: ports.appB,
        databaseUrl,
        authSecret,
        authUrl: originB,
        certificateKey,
      }),
    });
    await waitHttp(originB);

    // ------------------------------------------------------------ admin

    const admin = new AppClient(originA);
    const adminHttp = new AppClient(`http://127.0.0.1:${ports.appA}`);
    const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
    const adminPassword = secret(`Adm-${randomUUID().slice(0, 12)}`);
    log("signing up the first administrator through Better Auth");
    await admin.signUp(adminEmail, adminPassword, "OAuth Runtime Admin");
    adminHttp.adoptCookies(admin.cookieHeader());
    const fn = {
      createServer: ["src/query/servers.ts", "createServer"],
      createNode: ["src/query/nodes.ts", "createNode"],
      createGrant: [
        "src/query/agent-identity.ts",
        "createAgentEnrollmentGrant",
      ],
      revokeIdentity: [
        "src/query/agent-identity.ts",
        "revokeAgentIdentityAccess",
      ],
      identityState: ["src/query/agent-identity.ts", "getAgentIdentityState"],
    };
    const installerServer = await adminHttp.call(fn.createServer, {
      name: "installer-server",
      remark: "oauth runtime installer",
      address: "127.0.0.1",
      configPollIntervalSeconds: 5,
      heartbeatIntervalSeconds: 5,
    });
    const runtimeServer = await adminHttp.call(fn.createServer, {
      name: "runtime-server",
      remark: "oauth runtime ws",
      address: "127.0.0.1",
      configPollIntervalSeconds: 5,
      heartbeatIntervalSeconds: 5,
    });
    const runtimeNodePort = await freePort();
    await adminHttp.call(fn.createNode, {
      name: "runtime-vmess",
      serverId: runtimeServer.server.id,
      listenPort: runtimeNodePort,
      protocol: "vmess",
      settings: {},
    });
    log(`servers ${installerServer.server.id} and ${runtimeServer.server.id}`);

    // ------------------------------------------------------------ installer

    log(
      "creating the inline enrollment grant through the audited admin function",
    );
    const inline = await adminHttp.call(fn.createGrant, {
      serverId: installerServer.server.id,
      mode: "enroll",
      capabilities: RELEASE_CAPABILITIES,
      release: releaseVersion,
      delivery: "inline",
    });
    assert.match(inline.script.content, /^#!\/bin\/sh/m);
    assert.match(inline.script.content, /egr_[A-Za-z0-9_-]{43}/);
    assert.equal(
      (inline.script.content.match(/egr_[A-Za-z0-9_-]{43}/g) ?? []).length,
      1,
      "the inline script must contain exactly one grant",
    );
    const grantSecret = inline.script.content.match(/egr_[A-Za-z0-9_-]{43}/)[0];
    secret(grantSecret);
    assert.equal(inline.grant.status, "issued");
    assert.ok(inline.downloadPath.includes(inline.grant.id));

    log("downloading the secret-free installer through the admin route");
    const download = await fetch(
      `http://127.0.0.1:${ports.appA}${inline.downloadPath}`,
      {
        headers: { cookie: adminHttp.cookieHeader(), origin: originA },
      },
    );
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("cache-control"), "private, no-store");
    const downloaded = await download.text();
    assert.doesNotMatch(downloaded, /egr_[A-Za-z0-9_-]{43}/);
    assert.match(downloaded, /BLOSSOM_GRANT_STDIN=1/);
    const crossSite = await fetch(
      `http://127.0.0.1:${ports.appA}${inline.downloadPath}`,
      {
        headers: {
          cookie: adminHttp.cookieHeader(),
          origin: "https://evil.example",
        },
      },
    );
    assert.equal(
      crossSite.status,
      403,
      "cross-site installer download must be refused",
    );

    const sandbox = {
      root: path.join(root, "installer-root"),
      state: path.join(root, "installer-state"),
      bin: path.join(root, "installer-root", "fake-bin"),
    };
    for (const dir of [
      sandbox.state,
      sandbox.bin,
      path.join(sandbox.root, "etc/systemd/system"),
      path.join(sandbox.root, "usr/local/lib"),
      path.join(sandbox.root, "var/lib"),
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    const fake = fakeBin(
      sandbox.bin,
      sandbox.state,
      options.agentUrl,
      options.singBoxUrl,
      agentBin,
      singBoxArchive,
    );
    sandbox.agentUrl = fake.agentUrl;
    sandbox.singBoxUrl = fake.singBoxUrl;

    const user = process.env.USER ?? "root";
    const group =
      run("id", ["-gn", user], { encoding: "utf8" }).stdout.trim() || user;
    const scriptPath = path.join(root, "install.sh");
    const script = rewriteInstaller(
      inline.script.content,
      sandbox,
      user,
      group,
    );
    writeFileSync(scriptPath, script);
    chmodSync(scriptPath, 0o600);
    log("running the exact installer logic in the fake-systemd sandbox");
    const install = await runInstaller(
      scriptPath,
      {
        PATH: process.env.PATH,
        HOME: path.join(root, "home"),
        FAKE_STATE: sandbox.state,
        FAKE_AGENT_URL: sandbox.agentUrl,
        FAKE_AGENT: agentBin,
        FAKE_SING_BOX_URL: sandbox.singBoxUrl,
        FAKE_SING_BOX_ARCHIVE: singBoxArchive,
        BLOSSOM_INSTALL_HEALTH_SECONDS: "0",
        SSL_CERT_FILE: caPem,
      },
      `${grantSecret}\n`,
    );
    writeFileSync(
      path.join(root, "logs", "installer.log"),
      `${install.stdout}\n${install.stderr}`,
    );
    assert.equal(install.status, 0, install.stderr);
    assert.doesNotMatch(install.stderr, new RegExp(grantSecret));
    const installed = {
      agent: path.join(
        sandbox.root,
        "usr/local/lib/blossom-agent/server-agent",
      ),
      singBox: path.join(sandbox.root, "usr/local/lib/blossom-agent/sing-box"),
      unit: path.join(sandbox.root, "etc/systemd/system/blossom-agent.service"),
      credentials: path.join(
        sandbox.root,
        "etc/blossom-agent/credentials.json",
      ),
      metadata: path.join(sandbox.root, "etc/blossom-agent/installation.json"),
      state: path.join(sandbox.root, "var/lib/blossom-agent"),
    };
    assert.equal(
      readFileSync(installed.agent).length,
      readFileSync(agentBin).length,
    );
    assert.equal(statSync(installed.credentials).mode & 0o777, 0o600);
    assert.equal(statSync(installed.metadata).mode & 0o777, 0o600);
    assert.equal(statSync(installed.state).mode & 0o777, 0o700);
    assert.equal(statSync(installed.unit).mode & 0o777, 0o644);
    const credentials = JSON.parse(readFileSync(installed.credentials, "utf8"));
    assert.equal(credentials.identityStatus, "pending");
    assert.equal(credentials.generation, 1);
    assert.equal(credentials.clientAuthMethod, "client_secret_basic");
    assert.equal(credentials.tokenEndpoint, `${originA}/api/auth/oauth2/token`);
    assert.equal(credentials.issuer, `${originA}/api/auth`);
    assert.equal(credentials.resource, `${originA}/api/agent`);
    assert.equal(credentials.scope, "blossom:agent:connect");
    assert.match(credentials.clientId, /^agent_/);
    assert.match(credentials.clientSecret, /^ags_/);
    secret(credentials.clientSecret);
    assert.equal(
      readFileSync(installed.metadata, "utf8").includes(
        `grant_id=${inline.grant.id}`,
      ),
      true,
    );
    const unit = readFileSync(installed.unit, "utf8");
    assert.ok(
      unit.includes(`User=${user}`),
      "the unit must run as the service user",
    );
    assert.match(unit, /UMask=0077/);
    assert.match(unit, /ProtectSystem=strict/);
    assert.match(unit, /NoNewPrivileges=true/);
    assert.match(unit, /CapabilityBoundingSet=CAP_NET_BIND_SERVICE/);
    assert.match(unit, /--credentials-file/);
    assert.match(unit, /--self-update=false/);
    assert.doesNotMatch(unit, /--token/);
    assert.match(unit, /--url https:\/\/127\.0\.0\.1:/);
    assert.match(install.stderr, /enrollment complete: server /);
    assert.equal(
      readFileSync(path.join(sandbox.state, "curl.log"), "utf8")
        .trim()
        .split("\n").length,
      2,
      "the installer must download the agent and sing-box exactly once",
    );
    assert.match(
      readFileSync(path.join(sandbox.state, "systemctl.log"), "utf8"),
      /^start$/m,
    );
    const identityRow = psql(
      postgres,
      `select status, generation, oauth_client_id from agent_identity where server_id = '${installerServer.server.id}'`,
    ).split("|");
    assert.deepEqual(identityRow.slice(0, 2), ["pending", "1"]);
    assert.equal(
      psql(
        postgres,
        `select status from agent_enrollment_grant where id = '${inline.grant.id}'`,
      ),
      "redeemed",
    );
    log(
      "installer: exact CLI redemption, 0600 credentials, unit and modes verified",
    );

    // ------------------------------------------------------------ runtime

    log("creating the runtime server grant (stdin delivery)");
    const runtimeGrant = await adminHttp.call(fn.createGrant, {
      serverId: runtimeServer.server.id,
      mode: "enroll",
      capabilities: RELEASE_CAPABILITIES,
      release: releaseVersion,
      delivery: "stdin",
    });
    secret(runtimeGrant.secret);
    assert.match(runtimeGrant.secret, /^egr_/);
    const runtimeGrantFile = path.join(root, "runtime-grant");
    writeFileSync(runtimeGrantFile, `${runtimeGrant.secret}\n`);
    chmodSync(runtimeGrantFile, 0o600);

    const runtimeCredentials = path.join(root, "runtime-credentials.json");
    log(
      "redeeming the runtime grant with the real enroll CLI against loopback HTTP",
    );
    const enroll = await runCapture(
      agentBin,
      [
        "enroll",
        "--url",
        `${originB}/api`,
        "--grant-file",
        runtimeGrantFile,
        "--credentials-file",
        runtimeCredentials,
      ],
      { env: { PATH: process.env.PATH, HOME: path.join(root, "home") } },
    );
    assert.equal(enroll.status, 0, enroll.stderr);
    assert.doesNotMatch(
      enroll.stdout + enroll.stderr,
      new RegExp(runtimeGrant.secret),
    );
    assert.equal(statSync(runtimeCredentials).mode & 0o777, 0o600);
    const runtimeCredential = JSON.parse(
      readFileSync(runtimeCredentials, "utf8"),
    );
    assert.equal(runtimeCredential.identityStatus, "pending");
    assert.equal(
      runtimeCredential.tokenEndpoint,
      `${originB}/api/auth/oauth2/token`,
    );
    assert.equal(runtimeCredential.resource, `${originB}/api/agent`);
    secret(runtimeCredential.clientSecret);
    assert.equal(
      psql(
        postgres,
        `select status || '|' || generation from agent_identity where server_id = '${runtimeServer.server.id}'`,
      ),
      "pending|1",
      "redemption must leave the identity pending",
    );

    log(
      "requesting a client_credentials token and checking the machine claims",
    );
    const tokenResponse = await fetch(`${originB}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${runtimeCredential.clientId}:${runtimeCredential.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource: runtimeCredential.resource,
        scope: runtimeCredential.scope,
      }),
    });
    assert.equal(tokenResponse.status, 200);
    const tokenBody = await tokenResponse.json();
    assert.equal(tokenBody.token_type, "Bearer");
    assert.equal(tokenBody.expires_in, 900);
    assert.equal(tokenBody.scope, "blossom:agent:connect");
    secret(tokenBody.access_token);
    const claims = decodeJwt(tokenBody.access_token);
    assert.equal(claims.iss, `${originB}/api/auth`);
    assert.equal(claims.aud, `${originB}/api/agent`);
    assert.equal(claims.scope, "blossom:agent:connect");
    assert.equal(claims.client_id, runtimeCredential.clientId);
    assert.equal(claims.azp, runtimeCredential.clientId);
    assert.equal(claims.sub, runtimeCredential.clientId);
    assert.equal(claims.exp - claims.iat, 900);
    log("client_credentials token claims verified");

    // Fake sing-box records the config the agent runs.
    const singBoxState = path.join(root, "singbox");
    mkdirSync(singBoxState, { recursive: true });
    const fakeSingBox = path.join(root, "fake-sing-box");
    writeFileSync(
      fakeSingBox,
      `#!/bin/sh
set -eu
state=\${FAKE_SINGBOX_STATE:?}
case "$1" in
  version) echo "sing-box version ${singBoxVersion}"; exit 0 ;;
  check)
    cfg=$3
    [ -s "$cfg" ] || exit 1
    echo "configuration OK"
    exit 0
    ;;
  run)
    cfg=$3
    cp "$cfg" "$state/running-config.json"
    echo $$ >"$state/running-pid"
    trap 'exit 0' TERM INT
    while :; do sleep 1; done
    ;;
esac
exit 64
`,
    );
    chmodSync(fakeSingBox, 0o755);

    logging.resetFrames();
    const agent = startProcess(
      "agent",
      agentBin,
      [
        "--url",
        `${originB}/api`,
        "--credentials-file",
        runtimeCredentials,
        "--state-dir",
        path.join(root, "agent-state"),
        "--sing-box-path",
        fakeSingBox,
        "--download-dir",
        path.join(root, "agent-downloads"),
        "--self-update=false",
        "--log-level",
        "debug",
      ],
      {
        workdir: root,
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          FAKE_SINGBOX_STATE: singBoxState,
        },
      },
    );
    log(
      "waiting for the real agent to promote the identity and apply a config",
    );
    const applied = await waitFor(
      "the v2 session to apply the desired config",
      () => {
        const row = psql(
          postgres,
          `select s.config_state, s.applied_revision_seq, s.desired_revision_seq,
                  coalesce(s.ws_credential_kind, ''), coalesce(s.transport_mode, ''),
                  coalesce(i.status, '')
           from server s left join agent_identity i
             on i.server_id = s.id and i.id = s.ws_credential_identity_id
           where s.id = '${runtimeServer.server.id}'`,
        ).split("|");
        return row[0] === "applied" &&
          Number(row[1]) >= Number(row[2]) &&
          row[3] === "oauth" &&
          row[4] === "ws" &&
          row[5] === "active"
          ? {
              configState: row[0],
              appliedSeq: Number(row[1]),
              desiredSeq: Number(row[2]),
              kind: row[3],
              transport: row[4],
              identity: row[5],
            }
          : null;
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );
    assert.equal(applied.kind, "oauth");
    assert.equal(applied.transport, "ws");
    assert.ok(applied.appliedSeq >= 1);
    assert.ok(
      existsSync(path.join(singBoxState, "running-config.json")),
      "the fake sing-box must have been started with a compiled config",
    );
    const runningConfig = JSON.parse(
      readFileSync(path.join(singBoxState, "running-config.json"), "utf8"),
    );
    assert.ok(
      runningConfig.inbounds,
      "the compiled config must contain inbounds",
    );
    log(
      `identity active; config applied at seq ${applied.appliedSeq}; sing-box running`,
    );

    const hello = logging.frames.find(
      (frame) => frame.direction === "agent->control" && frame.type === "hello",
    );
    const welcome = logging.frames.find(
      (frame) =>
        frame.direction === "control->agent" && frame.type === "welcome",
    );
    const ack = logging.frames.find(
      (frame) =>
        frame.direction === "agent->control" &&
        frame.type === "config.ack" &&
        frame.payload?.outcome === "applied",
    );
    const status = logging.frames.find(
      (frame) =>
        frame.direction === "agent->control" &&
        frame.type === "agent.status" &&
        frame.payload?.configState === "applied",
    );
    assert.ok(hello, "the agent must send hello first");
    assert.equal(hello.v, 2);
    assert.equal(
      welcome?.v,
      2,
      "the control plane must reply with a v2 welcome",
    );
    assert.ok(welcome.payload.sessionId);
    assert.ok(welcome.payload.statusIntervalSeconds >= 1);
    assert.ok(ack, "the agent must acknowledge the applied snapshot");
    assert.ok(status, "the agent must report its applied status");
    assert.equal(
      hello.payload.capabilities.includes("pty-v1"),
      false,
      "v2 must not advertise pty-v1",
    );
    assert.equal(logging.upgrades.length >= 1, true);
    assert.equal(logging.upgrades.at(-1).accepted, V2_PROTOCOL);
    const helloIndex = logging.frames.findIndex(
      (frame) => frame.type === "hello",
    );
    const firstAgentFrame = logging.frames.findIndex(
      (frame) => frame.direction === "agent->control",
    );
    assert.equal(
      helloIndex,
      firstAgentFrame,
      "hello must be the first agent frame",
    );
    log(
      "v2 hello/welcome, config.get/snapshot, applied ack and status verified",
    );

    const forbidden = [
      "/api/agent/config/v3",
      "/api/agent/heartbeat",
      "/api/agent/traffic",
    ];
    for (const suffix of forbidden) {
      assert.equal(
        logging.requests.some((request) => request.path.startsWith(suffix)),
        false,
        `v2 must not use legacy polling (${suffix})`,
      );
    }
    assert.ok(
      logging.requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === "/api/auth/oauth2/token",
      ),
      "the agent must obtain a token",
    );
    log("no legacy HTTP agent polling observed");

    // ------------------------------------------------------------ outage

    const singBoxPid = Number(
      readFileSync(path.join(singBoxState, "running-pid"), "utf8").trim(),
    );
    const sessionBefore = psql(
      postgres,
      `select coalesce(ws_session_id, '') from server where id = '${runtimeServer.server.id}'`,
    );
    log("stopping the control plane to exercise an OAuth/WS outage");
    await logging.destroy();
    stopProcess(appB);
    await Promise.race([appB.exited, delay(8_000)]);
    if (appB.child.exitCode === null) stopProcess(appB, "SIGKILL");
    await appB.exited;
    await delay(8_000);
    assert.doesNotThrow(
      () => process.kill(singBoxPid, 0),
      "the last-known-good sing-box must keep running during the outage",
    );
    assert.equal(
      agent.child.exitCode,
      null,
      "the agent must not exit during the outage",
    );
    log("last-known-good sing-box survived the outage");

    log("restarting the control plane on the same origin");
    logging = loggingOrigin({ targetPort: ports.appB });
    await listen(logging.server, ports.proxyB);
    listeners.push(logging.server);
    startProcess("app-b2", process.execPath, [OUTPUT], {
      workdir: root,
      cwd: path.join(REPO, "app"),
      env: appEnv({
        port: ports.appB,
        databaseUrl,
        authSecret,
        authUrl: originB,
        certificateKey,
      }),
    });
    await waitHttp(originB);
    await waitFor(
      "the agent to reconnect and welcome a new session",
      () => {
        const session = psql(
          postgres,
          `select coalesce(ws_session_id, '') from server where id = '${runtimeServer.server.id}'`,
        );
        return session && session !== sessionBefore ? session : null;
      },
      { timeoutMs: 90_000, intervalMs: 1_000 },
    );
    assert.doesNotThrow(() => process.kill(singBoxPid, 0));
    log("agent reconnected and re-handshook after the outage");

    // ------------------------------------------------------------ revocation

    const identityId = psql(
      postgres,
      `select id from agent_identity where server_id = '${runtimeServer.server.id}' and status = 'active'`,
    );
    log("revoking the active machine identity through the admin function");
    const revoked = await adminHttp.call(fn.revokeIdentity, { identityId });
    assert.equal(revoked.changed, true);
    await waitFor(
      "the revoked identity to lose its session and fail reauthorization",
      () => {
        const state = psql(
          postgres,
          `select coalesce(i.status, ''), coalesce(c.disabled::text, ''), coalesce(s.ws_session_id, '')
           from agent_identity i join oauth_client c on c.client_id = i.oauth_client_id
           left join server s on s.id = i.server_id
           where i.id = '${identityId}'`,
        ).split("|");
        return state[0] === "revoked" && state[1] === "true" && state[2] === "";
      },
      { timeoutMs: 90_000, intervalMs: 1_000 },
    );
    assert.doesNotThrow(
      () => process.kill(singBoxPid, 0),
      "revocation must not stop the local proxy",
    );
    const refreshAfterRevoke = await fetch(`${originB}/api/auth/oauth2/token`, {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${runtimeCredential.clientId}:${runtimeCredential.clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        resource: runtimeCredential.resource,
        scope: runtimeCredential.scope,
      }),
    });
    assert.notEqual(refreshAfterRevoke.status, 200);
    log(
      `revocation closed the session and refused the client (HTTP ${refreshAfterRevoke.status})`,
    );

    log("re-enrolling a fresh generation and proving reconnection");
    const freshGrant = await adminHttp.call(fn.createGrant, {
      serverId: runtimeServer.server.id,
      mode: "enroll",
      capabilities: RELEASE_CAPABILITIES,
      release: releaseVersion,
      delivery: "stdin",
    });
    secret(freshGrant.secret);
    const freshGrantFile = path.join(root, "fresh-grant");
    writeFileSync(freshGrantFile, `${freshGrant.secret}\n`);
    chmodSync(freshGrantFile, 0o600);
    const freshCredentials = path.join(root, "fresh-credentials.json");
    const freshEnroll = await runCapture(
      agentBin,
      [
        "enroll",
        "--url",
        `${originB}/api`,
        "--grant-file",
        freshGrantFile,
        "--credentials-file",
        freshCredentials,
      ],
      { env: { PATH: process.env.PATH, HOME: path.join(root, "home") } },
    );
    assert.equal(freshEnroll.status, 0, freshEnroll.stderr);
    stopProcess(agent);
    await agent.exited;
    const agent2 = startProcess(
      "agent-2",
      agentBin,
      [
        "--url",
        `${originB}/api`,
        "--credentials-file",
        freshCredentials,
        "--state-dir",
        path.join(root, "agent-state"),
        "--sing-box-path",
        fakeSingBox,
        "--download-dir",
        path.join(root, "agent-downloads"),
        "--self-update=false",
        "--log-level",
        "debug",
      ],
      {
        workdir: root,
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: path.join(root, "home"),
          FAKE_SINGBOX_STATE: singBoxState,
        },
      },
    );
    await waitFor(
      "generation 2 to become active and apply",
      () => {
        const row = psql(
          postgres,
          `select i.status || '|' || i.generation || '|' || s.config_state
           from server s join agent_identity i on i.server_id = s.id
           where s.id = '${runtimeServer.server.id}' and i.status = 'active'`,
        );
        return row === "active|2|applied" ? row : null;
      },
      { timeoutMs: 120_000, intervalMs: 1_000 },
    );
    assert.equal(agent2.child.exitCode, null);
    log("fresh generation reconnected and applied");

    log(`PASS (workdir ${root})`);
  } finally {
    for (const server of listeners) {
      server.close();
      server.closeAllConnections?.();
    }
    for (const record of children.reverse()) stopProcess(record);
    await sleep(1_000);
    for (const record of children.reverse()) {
      if (record.child.exitCode === null) stopProcess(record, "SIGKILL");
    }
    run("pg_ctl", ["-D", postgres.data, "-m", "immediate", "stop"], {
      encoding: "utf8",
    });
    if (!options.keep) rmSync(root, { recursive: true, force: true });
    else log(`kept ${root}`);
  }
}

main().catch((error) => {
  console.error(redact(error.stack ?? String(error), secrets));
  process.exitCode = 1;
});
