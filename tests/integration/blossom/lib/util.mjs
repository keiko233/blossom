import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import net from "node:net";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function randomHex(bytes) {
  return randomBytes(bytes).toString("hex");
}

/** Asks the OS for a free loopback TCP port. */
export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Resolves true when nothing accepts connections on 127.0.0.1:port. */
export function isPortFree(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      const server = net.createServer();
      server.once("error", () => resolve(false));
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(true));
      });
    });
  });
}

/**
 * Polls `probe` until it returns a truthy value (which is returned) or the
 * timeout passes. `probe` may throw; that counts as "not yet".
 */
export async function waitFor(
  description,
  probe,
  { timeoutMs = 60_000, intervalMs = 500 } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  for (;;) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${description}` +
          (lastError ? ` (last error: ${lastError.message})` : ""),
      );
    }
    await sleep(intervalMs);
  }
}

/** Runs a short command synchronously; never throws on a non-zero exit. */
export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

/**
 * Masks every known secret value and anything shaped like a bearer token or a
 * long hex/base64 credential, so log excerpts printed on failure stay safe.
 */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret && secret.length >= 6) out = out.split(secret).join("[redacted]");
  }
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(token|password|secret|uuid)(["'=:\s]+)[A-Za-z0-9._~+/=-]{12,}/gi, "$1$2[redacted]")
    .replace(/\/api\/sub\/[A-Za-z0-9_-]+/g, "/api/sub/[redacted]");
}
