// Reusable disposable environment for the two-agent canary (task 10).
//
// Builds on the single-agent Harness (disposable PostgreSQL, built app, pinned
// sing-box and the Rust agent binary) and adds the pieces the canary needs:
// two independent agent processes, loopback origin capture, a client for a
// peer credential negative dial, and a SOCKS connect helper for stats
// isolation. It starts nothing by itself; the live scenario and the CLI decide
// when the environment is complete.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";

import { canaryAgentLaunch, canaryAgentLayout } from "./canary.mjs";
import { buildClientConfig, clashProxyToOutbound } from "./clash.mjs";
import { Harness } from "./harness.mjs";
import { ManagedProcess } from "./proc.mjs";
import { isPortFree, randomHex, run, freePort, waitFor } from "./util.mjs";

const MIN_ENV = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C.UTF-8",
};

/** Node reports IPv4 loopback as `::ffff:127.0.0.1` in some listeners. */
export function normalizeRemoteAddress(value) {
  if (typeof value !== "string") return value;
  return value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
}

function sqlText(value) {
  return String(value).replaceAll("'", "''");
}

export class CanaryHarness extends Harness {
  constructor(args) {
    super(args);
    this.layout = null;
    this.agents = {};
    this.canaryOrigins = [];
  }

  async start() {
    await super.start();
    this.layout = canaryAgentLayout(this.workdir);
    for (const agent of Object.values(this.layout)) {
      mkdirSync(agent.stateDir, { recursive: true, mode: 0o700 });
      mkdirSync(agent.homeDir, { recursive: true, mode: 0o700 });
    }
    mkdirSync(path.join(this.workdir, "logs"), { recursive: true, mode: 0o700 });
    return this;
  }

  /**
   * Starts one canary agent. The token is passed only through AGENT_TOKEN;
   * `canaryAgentLaunch` deliberately keeps it out of argv. Each agent has its
   * own state, HOME and log under the one disposable work directory.
   */
  startCanaryAgent(name, { appUrl, singBox, token }) {
    if (this.stopping) throw new Error("the harness is shutting down");
    const agent = this.layout?.[name];
    if (!agent) throw new Error(`unknown canary agent '${name}'`);
    if (this.agents[name]?.running) {
      throw new Error(`canary agent ${name} is already running`);
    }
    this.secret(token);
    const launch = canaryAgentLaunch(agent, { appUrl, singBox, token });
    const proc = new ManagedProcess(
      `agent-${name}`,
      this.agentBin,
      launch.args,
      {
        env: { ...MIN_ENV, ...launch.env },
        cwd: agent.homeDir,
        logFile: launch.logFile,
        trackEveryMs: 1000,
      },
    );
    this.processes.push(proc);
    this.started.push(proc);
    this.agents[name] = proc;
    this.log(`canary agent ${name} started (pid ${proc.pid})`);
    return proc;
  }

  async stopCanaryAgent(name) {
    const proc = this.agents[name];
    if (!proc) return;
    await proc.stop();
    this.processes = this.processes.filter((item) => item !== proc);
    delete this.agents[name];
  }

  /** One `server` row as plain values; no hash or token column is selected. */
  serverRow(serverId) {
    const row = this.psql(
      `select coalesce(enabled::text, ''), coalesce(config_state, ''),
              coalesce(runtime_state, ''), coalesce(applied_revision_seq::text, ''),
              coalesce(desired_revision_seq::text, ''),
              coalesce(ws_session_id, ''),
              coalesce(agent_capabilities::text, '[]')
       from server where id = '${sqlText(serverId)}'`,
    );
    if (!row) throw new Error(`server ${serverId} was not found`);
    const [
      enabled,
      configState,
      runtimeState,
      appliedRevisionSeq,
      desiredRevisionSeq,
      wsSessionId,
      capabilities,
    ] = row.split("|");
    return {
      serverId,
      enabled: enabled === "t",
      configState,
      runtimeState,
      appliedRevisionSeq: Number(appliedRevisionSeq),
      desiredRevisionSeq: Number(desiredRevisionSeq),
      wsSessionId,
      capabilities: JSON.parse(capabilities || "[]"),
    };
  }

  waitAgentReady(serverId, capability = "managed-networking-v1") {
    return waitFor(
      `canary agent ${serverId} to apply the initial config with ${capability}`,
      () => {
        const row = this.serverRow(serverId);
        const ready =
          row.wsSessionId !== "" &&
          row.capabilities.includes(capability) &&
          row.configState === "applied" &&
          row.appliedRevisionSeq >= row.desiredRevisionSeq;
        return ready ? row : null;
      },
      { timeoutMs: 180_000, intervalMs: 1000 },
    );
  }

  /** Parses the committed agent config without exposing its secret values. */
  agentActiveConfig(name) {
    const agent = this.layout?.[name];
    if (!agent) throw new Error(`unknown canary agent '${name}'`);
    const file = path.join(agent.stateDir, "active.json");
    return JSON.parse(readFileSync(file, "utf8"));
  }

  /** The agent-owned loopback stats endpoint from the committed config. */
  agentStatsEndpoint(name) {
    const config = this.agentActiveConfig(name);
    const api = (config.services ?? []).find(
      (service) => service?.type === "api",
    );
    if (!api || typeof api.listen !== "string" || !Number.isInteger(api.listen_port)) {
      throw new Error(`canary agent ${name} has no committed api service`);
    }
    return {
      agent: name,
      host: api.listen,
      port: api.listen_port,
      address: `${api.listen}:${api.listen_port}`,
    };
  }
}

/**
 * Loopback HTTP origin with a bounded request log. `GET /bytes/<token>/<n>`
 * serves exactly n bytes; the token is a per-request correlation value, never
 * an authentication credential. The log records only path token, remote
 * address/port and byte count so the relay judge can distinguish B's egress
 * from a direct connection.
 */
export function startCanaryOrigin({
  harness,
  host = "127.0.0.1",
  port = 0,
  tokenPrefix = "origin",
} = {}) {
  const requests = [];
  const logFile = harness?.workdir
    ? path.join(harness.workdir, "logs", "origin.jsonl")
    : undefined;
  if (logFile) mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });
  const record = (entry) => {
    requests.push(entry);
    if (requests.length > 10_000) requests.shift();
    if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`, "utf8");
  };

  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://canary.invalid").pathname;
    const match = /^\/bytes\/([A-Za-z0-9_-]{1,128})\/(\d{1,9})$/.exec(pathname);
    if (!match) {
      response.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    const token = match[1];
    const size = Number(match[2]);
    record({
      at: new Date().toISOString(),
      token,
      remoteAddress: normalizeRemoteAddress(request.socket.remoteAddress),
      remotePort: request.socket.remotePort,
      method: request.method,
      bytes: size,
    });
    response.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": size,
      "cache-control": "no-store",
    });
    response.end(Buffer.alloc(size, 0x61));
  });

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const bound = server.address();
      const origin = {
        host,
        port: bound.port,
        requests,
        logFile,
        url(token, bytes) {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(token)) {
            throw new Error("origin token must be URL-safe");
          }
          return `http://${host}:${bound.port}/bytes/${token}/${bytes}`;
        },
        newToken() {
          return `${tokenPrefix}-${randomHex(6)}`;
        },
        close: () =>
          new Promise((done) => {
            server.closeAllConnections?.();
            server.close(() => done());
          }),
      };
      harness?.fixtures.push(origin);
      harness?.canaryOrigins.push(origin);
      resolve(origin);
    });
  });
  return ready;
}

/** Fetch the origin directly from the harness host and return its peer. */
export async function probeHostEgress(origin, { token = origin.newToken() } = {}) {
  await fetch(origin.url(token, 1));
  await waitFor(
    `origin to record direct egress ${token}`,
    () => origin.requests.find((request) => request.token === token),
    { timeoutMs: 5_000, intervalMs: 50 },
  );
  return origin.requests.find((request) => request.token === token).remoteAddress;
}

/** A sing-box client whose outbound is derived from a served subscription. */
export async function startSubscriptionClient(
  harness,
  name,
  proxy,
  overrides = {},
) {
  const outbound = { ...clashProxyToOutbound(proxy), ...overrides };
  const listenPort = await freePort();
  const config = buildClientConfig(
    outbound,
    listenPort,
    path.join(harness.workdir, "logs", `client-${name}-singbox.log`),
  );
  return startCanaryClient(harness, name, config, [outbound.uuid]);
}

/**
 * Starts a sing-box client with an explicit config. Used for peer-credential
 * negative dials where the outbound is trojan/vless rather than the harness's
 * vmess subscription shape.
 */
export async function startCanaryClient(harness, name, config, secrets = []) {
  if (harness.stopping) throw new Error("the harness is shutting down");
  for (const secret of secrets) harness.secret(secret);
  const directory = path.join(harness.workdir, "client");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${name}.json`);
  writeFileSync(file, JSON.stringify(config, null, 2), { mode: 0o600 });
  const check = run(harness.singBox, ["check", "-c", file]);
  if (check.status !== 0) {
    throw new Error(
      `client config ${name} failed sing-box check: ${check.stderr.trim()}`,
    );
  }
  const proc = new ManagedProcess(
    `client-${name}`,
    harness.singBox,
    ["run", "-c", file],
    {
      env: { ...MIN_ENV, HOME: path.join(harness.workdir, "home") },
      cwd: directory,
      logFile: path.join(harness.workdir, "logs", `client-${name}.log`),
    },
  );
  harness.processes.push(proc);
  harness.started.push(proc);
  const listenPort = config.inbounds[0].listen_port;
  await waitFor(`client ${name} to listen`, () => isPortFree(listenPort).then((free) => !free), {
    timeoutMs: 15_000,
    intervalMs: 200,
  });
  return { port: listenPort, process: proc };
}

/** A plain TCP+SOCKS5 CONNECT result: the data plane either accepted or not. */
export function socksConnect(proxyPort, host, port, { timeoutMs = 5_000 } = {}) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: proxyPort });
    let buffer = Buffer.alloc(0);
    let stage = "greeting";
    let settled = false;
    let timer;
    const finish = (outcome, detail) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      socket.destroy();
      resolve({ outcome, detail });
    };
    timer = setTimeout(() => finish("refused", "timeout"), timeoutMs);
    timer.unref?.();
    const sendConnect = () => {
      const address = net.isIP(host);
      const hostBytes =
        address === 4
          ? Buffer.from(host.split(".").map(Number))
          : address === 6
            ? Buffer.from(host.replaceAll(":", "").padStart(32, "0"), "hex")
            : (() => {
                const bytes = Buffer.from(host, "utf8");
                return Buffer.concat([Buffer.from([bytes.length]), bytes]);
              })();
      const atyp = address === 4 ? 0x01 : address === 6 ? 0x04 : 0x03;
      const portBytes = Buffer.alloc(2);
      portBytes.writeUInt16BE(port);
      socket.write(
        Buffer.concat([
          Buffer.from([0x05, 0x01, 0x00, atyp]),
          hostBytes,
          portBytes,
        ]),
      );
      stage = "reply";
    };
    socket.once("connect", () => {
      socket.write(Buffer.from([0x05, 0x01, 0x00]));
    });
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === "greeting" && buffer.length >= 2) {
        if (buffer[0] !== 0x05 || buffer[1] !== 0x00) {
          finish("refused", "socks greeting rejected");
          return;
        }
        buffer = buffer.subarray(2);
        sendConnect();
        return;
      }
      if (stage === "reply" && buffer.length >= 4) {
        const rep = buffer[1];
        if (rep === 0x00) finish("connected", "socks connect succeeded");
        else finish("refused", `socks reply ${rep}`);
      }
    });
    socket.once("error", () => finish("refused", "connect error"));
    socket.once("close", () => finish("refused", "closed before reply"));
  });
}

/**
 * A sing-box outbound that dials B's peer listener with a deliberately
 * different credential class than the controller issued for the link. TLS
 * verification is disabled only for this negative probe: a connected tunnel
 * would still fail the judge, while a TLS failure is not mistaken for auth
 * rejection.
 */
export function buildPeerProbeClientConfig({
  protocol,
  server,
  port,
  credential,
  tlsServerName,
  listenPort,
  logPath,
}) {
  const tls = {
    enabled: true,
    server_name: tlsServerName,
    insecure: true,
  };
  const outbound =
    protocol === "vless"
      ? {
          type: "vless",
          tag: "peer-probe",
          server,
          server_port: port,
          uuid: credential,
          tls,
        }
      : {
          type: "trojan",
          tag: "peer-probe",
          server,
          server_port: port,
          password: credential,
          tls,
        };
  return {
    log: { level: "warn", output: logPath, timestamp: true },
    inbounds: [
      {
        type: "mixed",
        tag: "local",
        listen: "127.0.0.1",
        listen_port: listenPort,
      },
    ],
    outbounds: [outbound],
    route: { final: outbound.tag },
  };
}