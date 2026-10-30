// Calls the app's TanStack Start server functions over HTTP, the same way the
// browser does, so the harness can provision data through the supported admin
// flows instead of writing rows directly.
//
// Two pieces of framework behaviour are reproduced here:
//  - the function id: in a production build it is the sha256 of
//    `<file>--<export>_createServerFn_handler` (checked by `assertServerFnIds`
//    against the ids the built server actually registers);
//  - the wire format: seroval "cross JSON". Only the subset the admin
//    functions use is implemented (primitives, plain objects, arrays, dates).

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const T_NUMBER = 0;
const T_STRING = 1;
const T_CONSTANT = 2;
const T_BIGINT = 3;
const T_REFERENCE = 4;
const T_DATE = 5;
const T_ARRAY = 9;
const T_OBJECT = 10;

// seroval constant codes
const C_NULL = 0;
const C_UNDEFINED = 1;
const C_TRUE = 2;
const C_FALSE = 3;

export function serverFnId(file, exportName) {
  return createHash("sha256")
    .update(`${file}--${exportName}_createServerFn_handler`)
    .digest("hex");
}

export function encodeSeroval(value) {
  let next = 0;
  const walk = (v) => {
    if (v === null) return { t: T_CONSTANT, s: C_NULL };
    if (v === undefined) return { t: T_CONSTANT, s: C_UNDEFINED };
    if (v === true) return { t: T_CONSTANT, s: C_TRUE };
    if (v === false) return { t: T_CONSTANT, s: C_FALSE };
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        throw new Error("cannot encode a non-finite number");
      }
      return { t: T_NUMBER, s: v };
    }
    if (typeof v === "string") return { t: T_STRING, s: v };
    if (v instanceof Date) {
      return { t: T_DATE, i: next++, s: v.toISOString() };
    }
    if (Array.isArray(v)) {
      const i = next++;
      return { t: T_ARRAY, i, a: v.map(walk), o: 0 };
    }
    if (typeof v === "object") {
      const i = next++;
      const keys = Object.keys(v);
      return {
        t: T_OBJECT,
        i,
        p: { k: keys, v: keys.map((key) => walk(v[key])) },
        o: 0,
      };
    }
    throw new Error(`cannot encode a ${typeof v}`);
  };
  return walk(value);
}

export function decodeSeroval(node) {
  const refs = new Map();
  const walk = (n) => {
    switch (n.t) {
      case T_NUMBER:
        return n.s;
      case T_STRING:
        return n.s;
      case T_CONSTANT:
        return [null, undefined, true, false][n.s];
      case T_BIGINT:
        return BigInt(n.s);
      case T_REFERENCE:
        if (!refs.has(n.i)) throw new Error(`dangling reference ${n.i}`);
        return refs.get(n.i);
      case T_DATE: {
        const date = new Date(n.s);
        refs.set(n.i, date);
        return date;
      }
      case T_ARRAY: {
        const out = [];
        refs.set(n.i, out);
        for (const item of n.a) out.push(walk(item));
        return out;
      }
      case T_OBJECT: {
        const out = {};
        refs.set(n.i, out);
        n.p.k.forEach((key, index) => {
          out[key] = walk(n.p.v[index]);
        });
        return out;
      }
      default:
        // Plugin nodes (errors, streams) are not needed; surface them as-is.
        if (n.c === "$TSR/Error") {
          const err = new Error(walk(n.s.message));
          refs.set(n.i, err);
          return err;
        }
        throw new Error(`unsupported seroval node type ${n.t}`);
    }
  };
  return walk(node);
}

/**
 * Verifies that every (file, export) pair the harness calls is registered
 * under the derived id in the built server, so a framework change fails with
 * a clear message instead of an opaque 404.
 */
export async function assertServerFnIds(ssrBundlePath, fns) {
  const bundle = await readFile(ssrBundlePath, "utf8");
  const missing = fns.filter(([file, name]) => {
    return !bundle.includes(`"${serverFnId(file, name)}"`);
  });
  if (missing.length > 0) {
    throw new Error(
      `server function ids not found in the build: ${missing
        .map(([file, name]) => `${file}#${name}`)
        .join(", ")}`,
    );
  }
}

export class ServerFnError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ServerFnError";
    this.status = status;
  }
}

/** Minimal cookie jar + better-auth sign-in + server function caller. */
export class AppClient {
  #base;
  #cookies = new Map();

  constructor(baseUrl) {
    this.#base = baseUrl.replace(/\/$/, "");
  }

  get baseUrl() {
    return this.#base;
  }

  #storeCookies(response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === "" || /max-age=0/i.test(line)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
  }

  #headers(extra = {}) {
    const cookie = [...this.#cookies]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    return {
      // The app rejects state-changing requests without a same-origin header.
      origin: this.#base,
      ...(cookie ? { cookie } : {}),
      ...extra,
    };
  }

  async auth(path, body) {
    const response = await fetch(`${this.#base}/api/auth/${path}`, {
      method: "POST",
      headers: this.#headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    });
    this.#storeCookies(response);
    if (!response.ok) {
      throw new ServerFnError(
        `auth ${path} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return response.json();
  }

  signUp(email, password, name) {
    return this.auth("sign-up/email", { email, password, name });
  }

  signIn(email, password) {
    return this.auth("sign-in/email", { email, password });
  }

  /**
   * Calls `export` from `file` (relative to app/, e.g. src/query/servers.ts).
   * `method` must match how the function was declared (`GET` or `POST`).
   */
  async call([file, exportName], data, { method = "POST" } = {}) {
    const envelope = JSON.stringify({
      // Requests use seroval's non-cross JSON envelope; responses do not.
      t: encodeSeroval({ data, context: {} }),
      f: 127,
      m: [],
    });
    const url = `${this.#base}/_serverFn/${serverFnId(file, exportName)}`;
    const response =
      method === "GET"
        ? await fetch(
            data === undefined
              ? url
              : `${url}?payload=${encodeURIComponent(envelope)}`,
            { headers: this.#headers({ "x-tsr-serverFn": "true" }) },
          )
        : await fetch(url, {
            method,
            headers: this.#headers({
              "content-type": "application/json",
              "x-tsr-serverFn": "true",
            }),
            body: envelope,
          });
    const text = await response.text();
    let parsed;
    try {
      parsed = decodeSeroval(JSON.parse(text));
    } catch {
      throw new ServerFnError(
        `${exportName} returned HTTP ${response.status} with an undecodable body`,
        response.status,
      );
    }
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const message =
        parsed.error instanceof Error ? parsed.error.message : "server error";
      throw new ServerFnError(
        `${exportName} failed: ${message}`,
        response.status,
      );
    }
    if (!response.ok) {
      throw new ServerFnError(
        `${exportName} failed with HTTP ${response.status}`,
        response.status,
      );
    }
    return parsed.result;
  }
}
