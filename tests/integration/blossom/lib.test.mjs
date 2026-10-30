// Fast checks for the harness's own helpers. They need no Docker, database or
// sing-box:  node --test tests/integration/blossom/lib.test.mjs

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  buildClientConfig,
  clashProxyToOutbound,
  loadYaml,
  parseClashProxies,
} from "./lib/clash.mjs";
import {
  AppClient,
  decodeSeroval,
  encodeSeroval,
  serverFnId,
} from "./lib/serverfn.mjs";
import { isPortFree, freePort, redact, waitFor } from "./lib/util.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

test("serverFnId derives the production id the built app registers", () => {
  // Value observed in a production build of src/query/servers.ts#createServer.
  assert.equal(
    serverFnId("src/query/servers.ts", "createServer"),
    "bef2e3c75a13895100d1c646012e520abfce3be2021b12de6b0d362868aa02b3",
  );
});

test("seroval encoding matches the wire shape and round-trips", () => {
  const value = {
    name: "x",
    n: 1.5,
    yes: true,
    no: false,
    nothing: null,
    list: [1, "a"],
    nested: { when: new Date("2026-01-02T03:04:05.000Z") },
  };
  const node = encodeSeroval({ data: value, context: {} });
  assert.equal(node.t, 10);
  assert.deepEqual(node.p.k, ["data", "context"]);
  assert.deepEqual(decodeSeroval(node).data, value);
  assert.deepEqual(encodeSeroval(true), { t: 2, s: 2 });
  assert.deepEqual(encodeSeroval("a"), { t: 1, s: "a" });
  assert.throws(() => encodeSeroval(Number.NaN), /non-finite/);
});

test("AppClient sends the envelope, cookies and origin the app expects", async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, body });
      if (req.url.startsWith("/api/auth/")) {
        res.writeHead(200, { "set-cookie": "better-auth.session_token=abc; Path=/; HttpOnly" });
        res.end("{}");
      } else {
        res.writeHead(200);
        res.end(JSON.stringify(encodeSeroval({ result: { ok: true } })));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const client = new AppClient(base);
    await client.signIn("a@example.test", "pw-pw-pw-pw");
    const result = await client.call(["src/query/servers.ts", "createServer"], { name: "n" });
    assert.deepEqual(result, { ok: true });

    const post = seen.at(-1);
    assert.equal(post.method, "POST");
    assert.equal(post.headers.origin, base);
    assert.equal(post.headers["x-tsr-serverfn"], "true");
    assert.match(post.headers.cookie, /better-auth\.session_token=abc/);
    const envelope = JSON.parse(post.body);
    assert.equal(envelope.f, 127);
    assert.deepEqual(decodeSeroval(envelope.t).data, { name: "n" });

    await client.call(["src/query/servers.ts", "listServers"], { page: 1 }, { method: "GET" });
    const get = seen.at(-1);
    assert.equal(get.method, "GET");
    const payload = JSON.parse(new URL(get.url, base).searchParams.get("payload"));
    assert.deepEqual(decodeSeroval(payload.t).data, { page: 1 });
  } finally {
    server.close();
  }
});

test("AppClient surfaces a server-function error message", async () => {
  // The wire shape of a thrown Error, as the app's server emits it.
  const thrown = {
    t: 10,
    i: 0,
    p: {
      k: ["error"],
      v: [{ t: 25, i: 1, s: { message: { t: 1, s: "Forbidden" } }, c: "$TSR/Error" }],
    },
    o: 0,
  };
  const server = http.createServer((req, res) => {
    res.writeHead(500);
    res.end(JSON.stringify(thrown));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const client = new AppClient(`http://127.0.0.1:${server.address().port}`);
    await assert.rejects(client.call(["a.ts", "b"], {}), /b failed: Forbidden/);
  } finally {
    server.close();
  }
});

test("clash vmess proxy becomes a sing-box outbound; other shapes are refused", () => {
  const yaml = loadYaml(repoRoot);
  const proxies = parseClashProxies(
    yaml,
    "proxies:\n  - {name: n, type: vmess, server: 127.0.0.1, port: 1234, uuid: 11111111-1111-4111-8111-111111111111, alterId: 0, cipher: auto}\n",
  );
  const outbound = clashProxyToOutbound(proxies[0]);
  assert.deepEqual(outbound, {
    type: "vmess",
    tag: "proxy",
    server: "127.0.0.1",
    server_port: 1234,
    uuid: "11111111-1111-4111-8111-111111111111",
    security: "auto",
    alter_id: 0,
  });
  const config = buildClientConfig(outbound, 4000, "/tmp/x.log");
  assert.equal(config.inbounds[0].listen, "127.0.0.1");
  assert.equal(config.route.final, "proxy");

  assert.throws(() => clashProxyToOutbound({ type: "trojan" }), /does not support/);
  assert.throws(
    () => clashProxyToOutbound({ type: "vmess", tls: true, server: "x", port: 1, uuid: "u" }),
    /plain TCP/,
  );
  assert.throws(() => parseClashProxies(yaml, "rules: []"), /no proxies/);
});

test("redact masks known secrets, bearer tokens and subscription links", () => {
  const text =
    "Authorization: Bearer abcdefghijklmnop1234 and http://h/api/sub/SECRETTOKEN123 plus s3cr3t-value";
  const out = redact(text, ["s3cr3t-value"]);
  assert.doesNotMatch(out, /abcdefghijklmnop1234|SECRETTOKEN123|s3cr3t-value/);
  assert.match(out, /Bearer \[redacted\]/);
});

test("waitFor returns the first truthy value and reports the last error on timeout", async () => {
  let calls = 0;
  const value = await waitFor("a value", () => (++calls >= 3 ? "ready" : null), {
    timeoutMs: 2000,
    intervalMs: 5,
  });
  assert.equal(value, "ready");
  await assert.rejects(
    waitFor("never", () => {
      throw new Error("still down");
    }, { timeoutMs: 30, intervalMs: 5 }),
    /timed out .* waiting for never .*still down/,
  );
});

test("port helpers agree about free and occupied ports", async () => {
  const port = await freePort();
  assert.equal(await isPortFree(port), true);
  const net = await import("node:net");
  const holder = net.createServer();
  await new Promise((resolve) => holder.listen(port, "127.0.0.1", resolve));
  try {
    assert.equal(await isPortFree(port), false);
  } finally {
    holder.close();
  }
});
