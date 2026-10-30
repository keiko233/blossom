// End-to-end scenario against real components: PostgreSQL, the built app, the
// Rust agent and the sing-box it supervises, plus a sing-box client. It is run
// by scripts/blossom-integration.mjs, which owns setup and cleanup.
//
// Data is created through the app's admin server functions and the public
// auth endpoints. Direct SQL is used to read state back for assertions.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import {
  AppClient,
  assertServerFnIds,
} from "./lib/serverfn.mjs";
import {
  buildClientConfig,
  clashProxyToOutbound,
  loadYaml,
  parseClashProxies,
} from "./lib/clash.mjs";
import { occupyPort, startOrigin } from "./lib/net-fixtures.mjs";
import { freePort, sleep, waitFor } from "./lib/util.mjs";
import path from "node:path";

const FN = {
  createServer: ["src/query/servers.ts", "createServer"],
  createNode: ["src/query/nodes.ts", "createNode"],
  deleteNode: ["src/query/nodes.ts", "deleteNode"],
  createGroup: ["src/query/groups.ts", "createGroup"],
  updateGroup: ["src/query/groups.ts", "updateGroup"],
  createPlan: ["src/query/plans.ts", "createPlan"],
  createUser: ["src/query/users.ts", "createUser"],
  createSubscription: ["src/query/subscriptions.ts", "createSubscription"],
  updateSubscription: ["src/query/subscriptions.ts", "updateSubscription"],
};

const MiB = 1024 * 1024;
const APPLY_TIMEOUT_MS = 120_000;

export async function runScenario(harness, step) {
  const yaml = loadYaml(harness.repoRoot);
  const origin = await startOrigin();
  harness.fixtures.push(origin);
  const originUrl = (bytes) => `http://127.0.0.1:${origin.port}/bytes/${bytes}`;

  const ctx = {};
  const admin = new AppClient(harness.appUrl);
  const adminEmail = `admin-${randomUUID().slice(0, 8)}@example.test`;
  const mainEmail = `main-${randomUUID().slice(0, 8)}@example.test`;
  const expiringEmail = `expiring-${randomUUID().slice(0, 8)}@example.test`;

  const serverState = () => {
    const [state, runtime, applied, desired, code, phase] = harness
      .psql(
        `select config_state, runtime_state, applied_revision_seq, desired_revision_seq,
                coalesce(last_error_code, ''), coalesce(last_error_phase, '')
         from server where id = '${ctx.serverId}'`,
      )
      .split("|");
    return {
      configState: state,
      runtimeState: runtime,
      appliedSeq: Number(applied),
      desiredSeq: Number(desired),
      errorCode: code,
      errorPhase: phase,
    };
  };

  /** Waits for the agent to confirm the latest desired revision as applied. */
  const waitApplied = (what) =>
    waitFor(
      `the agent to apply ${what}`,
      () => {
        const s = serverState();
        return s.configState === "applied" && s.appliedSeq >= s.desiredSeq && s;
      },
      { timeoutMs: APPLY_TIMEOUT_MS, intervalMs: 1000 },
    );

  const fetchSubscription = async (token) => {
    const response = await fetch(`${harness.appUrl}/api/sub/${token}`, {
      headers: { "user-agent": "clash.meta/1.18.0 (blossom-integration)" },
    });
    return { status: response.status, text: await response.text(), headers: response.headers };
  };

  const startClientFor = async (name, proxy, overrides = {}) => {
    const outbound = { ...clashProxyToOutbound(proxy), ...overrides };
    const port = await freePort();
    const config = buildClientConfig(
      outbound,
      port,
      path.join(harness.workdir, "logs", `client-${name}-singbox.log`),
    );
    return harness.startClient(name, config);
  };

  const fetchVia = (client, bytes, options) =>
    harness.fetchViaProxy(client.port, originUrl(bytes), options);

  const trafficFor = (subscriptionId) => {
    const [used, rows, up, down, withNode] = harness
      .psql(
        `select s.traffic_used_bytes,
                (select count(*) from traffic_record where subscription_id = s.id),
                (select coalesce(sum(uplink_bytes), 0) from traffic_record where subscription_id = s.id),
                (select coalesce(sum(downlink_bytes), 0) from traffic_record where subscription_id = s.id),
                (select count(*) from traffic_record where subscription_id = s.id and node_id = '${ctx.nodeId}' and server_id = '${ctx.serverId}')
         from subscription s where s.id = '${subscriptionId}'`,
      )
      .split("|")
      .map(Number);
    return { used, rows, up, down, withNode };
  };

  // ---------------------------------------------------------------- bootstrap

  await step("bootstrap: sign up the first administrator", async () => {
    await admin.signUp(adminEmail, harness.credentials.adminPassword, "Harness Admin");
    await admin.signIn(adminEmail, harness.credentials.adminPassword);
    await assertServerFnIds(
      path.join(harness.repoRoot, "app", ".output", "server", "_ssr", "ssr.mjs"),
      Object.values(FN),
    );
    // An admin-only function must work for the first account.
    const created = await admin.call(FN.createServer, {
      name: "Harness server",
      remark: "disposable",
      address: "127.0.0.1",
      configPollIntervalSeconds: 5,
      heartbeatIntervalSeconds: 5,
    });
    ctx.serverId = created.server.id;
    ctx.agentToken = harness.secret(created.token);
    assert.ok(ctx.agentToken.length > 16);
    assert.equal(created.server.configState, "unknown");
  });

  await step("authorization: a non-admin session cannot call admin functions", async () => {
    const outsider = new AppClient(harness.appUrl);
    await outsider.signUp(`outsider-${randomUUID().slice(0, 8)}@example.test`, harness.credentials.userPassword, "Outsider");
    await assert.rejects(
      outsider.call(FN.createServer, { name: "nope", address: "127.0.0.1" }),
      /Forbidden|Unauthorized/,
    );
    assert.equal(harness.psql(`select count(*) from server`), "1");
  });

  // ---------------------------------------------------------------- provision

  await step("provision: node, group, plan, users and subscriptions", async () => {
    ctx.nodePort = await freePort();
    const node = await admin.call(FN.createNode, {
      name: "harness-vmess",
      serverId: ctx.serverId,
      listenPort: ctx.nodePort,
      protocol: "vmess",
      settings: {},
    });
    ctx.nodeId = node.node.id;
    const group = await admin.call(FN.createGroup, {
      name: "Harness group",
      nodeIds: [ctx.nodeId],
    });
    ctx.groupId = group.id;
    const plan = await admin.call(FN.createPlan, {
      name: "Harness plan",
      priceCents: 0,
      durationDays: 30,
      trafficBytes: 1024 * MiB,
      groupIds: [group.id],
    });
    ctx.planId = plan.id;

    const main = await admin.call(FN.createUser, {
      name: "Main user",
      email: mainEmail,
      password: harness.credentials.userPassword,
    });
    const expiring = await admin.call(FN.createUser, {
      name: "Expiring user",
      email: expiringEmail,
      password: harness.credentials.userPassword,
    });
    const mainSub = await admin.call(FN.createSubscription, { userId: main.id, planId: ctx.planId });
    ctx.mainSub = { id: mainSub.id, token: harness.secret(mainSub.token) };
    const expiringSub = await admin.call(FN.createSubscription, { userId: expiring.id, planId: ctx.planId });
    ctx.expiringSub = { id: expiringSub.id, token: harness.secret(expiringSub.token) };

    const s = serverState();
    assert.ok(s.desiredSeq >= 3, "node, credentials and entitlements should each bump the revision");
    assert.equal(s.appliedSeq, 0);
    assert.equal(s.configState, "unknown");
  });

  await step("publish gate: nothing is served before an agent applies the config", async () => {
    const response = await fetchSubscription(ctx.mainSub.token);
    assert.equal(response.status, 503, "subscription should be held back, not describe an unserved node");
    assert.doesNotMatch(response.text, /vmess/);
    assert.equal(response.headers.get("retry-after"), "30");
    const unknown = await fetchSubscription("not-a-real-token");
    assert.equal(unknown.status, 404);
  });

  // -------------------------------------------------------------------- apply

  await step("agent: starts, applies the config and reports it", async () => {
    const agent = harness.startAgent(ctx.agentToken, { pollSeconds: 5 });
    const s = await waitApplied("the initial config");
    assert.equal(s.runtimeState, "running");
    assert.equal(s.errorCode, "");
    const [seen, version, caps, active] = harness
      .psql(
        `select last_seen_at is not null, coalesce(sing_box_version, ''),
                agent_capabilities::text, active_node_ids::text
         from server where id = '${ctx.serverId}'`,
      )
      .split("|");
    assert.equal(seen, "t");
    assert.ok(version.length > 0, "agent should report the sing-box version");
    assert.match(caps, /atomic-config-rollback/);
    assert.match(active, new RegExp(ctx.nodeId));
    const children = agent.trackDescendants();
    assert.ok(children.length >= 1, "the agent should be supervising a sing-box process");
    // The inbound really listens: a TCP connection is accepted.
    await waitFor("the node port to accept connections", async () => {
      const net = await import("node:net");
      return new Promise((resolve) => {
        const socket = net.connect(ctx.nodePort, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
    }, { timeoutMs: 10_000, intervalMs: 300 });
  });

  await step("subscription: served after apply with the user's own credentials", async () => {
    const response = await fetchSubscription(ctx.mainSub.token);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("subscription-userinfo") ?? "", /total=\d+; expire=\d+/);
    const proxies = parseClashProxies(yaml, response.text);
    assert.equal(proxies.length, 1);
    assert.equal(proxies[0].type, "vmess");
    assert.equal(proxies[0].server, "127.0.0.1");
    assert.equal(proxies[0].port, ctx.nodePort);
    ctx.mainProxy = proxies[0];

    const other = await fetchSubscription(ctx.expiringSub.token);
    assert.equal(other.status, 200);
    ctx.expiringProxy = parseClashProxies(yaml, other.text)[0];
    assert.notEqual(ctx.expiringProxy.uuid, ctx.mainProxy.uuid, "each subscription has its own credential");
    assert.ok(
      Number(harness.psql(`select count(*) from access_log where subject_id = '${ctx.mainSub.id}'`)) >= 1,
      "the fetch is recorded in the access log",
    );
  });

  // ------------------------------------------------------------------ traffic

  await step("proxy: the subscription's credentials work and an unknown uuid is refused", async () => {
    ctx.mainClient = await startClientFor("main", ctx.mainProxy);
    const ok = await fetchVia(ctx.mainClient, 1024);
    assert.deepEqual(
      { ok: ok.ok, bytes: ok.bytes },
      { ok: true, bytes: 1024 },
      `valid credentials were refused: curl exit ${ok.curlExit} ${ok.error}\n${harness.logTail("client-main")}`,
    );

    // Only meaningful once the same path is known to work: otherwise a dead
    // server would also "refuse" the rogue client.
    const rogue = await startClientFor("rogue", ctx.mainProxy, { uuid: randomUUID() });
    const denied = await fetchVia(rogue, 1024, { maxSeconds: 8 });
    assert.equal(denied.ok, false, "a client with an unknown uuid must not get through");
    await harness.stopProcess(rogue.process);
  });

  await step("accounting: proxied bytes are reported and counted against the subscription", async () => {
    // The 1 KiB fetched in the previous step is reported on the agent's next
    // heartbeat; let it land so it cannot be mistaken for part of this transfer.
    await waitFor(
      "the earlier request to be accounted",
      () => trafficFor(ctx.mainSub.id).used > 0,
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    const before = trafficFor(ctx.mainSub.id);
    ctx.transferred = 3 * MiB;
    const result = (await fetchVia(ctx.mainClient, ctx.transferred, { maxSeconds: 30 }));
    assert.equal(result.bytes, ctx.transferred);
    const expected = before.used + ctx.transferred;
    const after = await waitFor(
      "the agent to report the traffic",
      () => {
        const t = trafficFor(ctx.mainSub.id);
        return t.used >= expected && t;
      },
      { timeoutMs: 60_000, intervalMs: 1000 },
    );
    // Overhead is small; a wildly different figure means the counters are wrong.
    assert.ok(after.used - before.used < ctx.transferred * 1.1 + 64 * 1024,
      `counted ${after.used - before.used} bytes for ${ctx.transferred} transferred`);
    assert.ok(after.rows >= 1 && after.withNode >= 1, "history rows carry the node and server");
    assert.ok(after.down >= ctx.transferred, "download direction carries the payload");
    assert.equal(after.used, after.up + after.down, "the counter equals the summed history");
    assert.equal(trafficFor(ctx.expiringSub.id).used, 0, "an idle subscription is not charged");
  });

  // ---------------------------------------------------- invalid config / rollback

  await step("invalid config: sing-box rejects it, the running config keeps serving", async () => {
    const bad = await admin.call(FN.createNode, {
      name: "harness-bad-ss2022",
      serverId: ctx.serverId,
      listenPort: await freePort(),
      protocol: "shadowsocks",
      // Schema-valid, but not a valid 2022 pre-shared key, so `sing-box check`
      // fails in the agent.
      settings: { method: "2022-blake3-aes-256-gcm", password: "not-a-valid-key" },
    });
    ctx.badNodeId = bad.node.id;
    // Group membership is what puts a node in front of subscribers.
    await admin.call(FN.updateGroup, { id: ctx.groupId, nodeIds: [ctx.nodeId, ctx.badNodeId] });

    const s = await waitFor(
      "the agent to reject the candidate",
      () => {
        const state = serverState();
        return state.configState === "rejected" && state;
      },
      { timeoutMs: 90_000, intervalMs: 1000 },
    );
    assert.equal(s.errorCode, "SINGBOX_CONFIG_INVALID");
    assert.equal(s.errorPhase, "preflight");
    assert.ok(s.appliedSeq < s.desiredSeq, "the rejected revision is not acknowledged");
    assert.equal(s.runtimeState, "running", "the previous process was left alone");

    const still = (await fetchVia(ctx.mainClient, 2048));
    assert.deepEqual({ ok: still.ok, bytes: still.bytes }, { ok: true, bytes: 2048 });
    const sub = await fetchSubscription(ctx.mainSub.token);
    assert.equal(sub.status, 200);
    assert.doesNotMatch(sub.text, /harness-bad-ss2022/, "the unapplied node is not advertised");
  });

  await step("invalid config: removing the bad node returns the agent to applied", async () => {
    await admin.call(FN.deleteNode, { id: ctx.badNodeId });
    const s = await waitApplied("the config without the bad node");
    assert.equal(s.errorCode, "");
    const ok = (await fetchVia(ctx.mainClient, 2048));
    assert.equal(ok.ok, true);
  });

  await step("rollback: a config that passes check but cannot start is rolled back", async () => {
    const blocker = await occupyPort();
    harness.fixtures.push(blocker);
    const conflict = await admin.call(FN.createNode, {
      name: "harness-port-conflict",
      serverId: ctx.serverId,
      listenPort: blocker.port,
      protocol: "vmess",
      settings: {},
    });
    ctx.conflictNodeId = conflict.node.id;
    await admin.call(FN.updateGroup, { id: ctx.groupId, nodeIds: [ctx.nodeId, ctx.conflictNodeId] });

    const s = await waitFor(
      "the agent to report the failed apply",
      () => {
        const state = serverState();
        return state.configState === "apply_failed" && state;
      },
      { timeoutMs: 120_000, intervalMs: 1000 },
    );
    // sing-box may die at bind time (start failed) or just after launch
    // (caught by the probation health check); both roll back.
    assert.match(s.errorCode, /^SINGBOX_(START_FAILED|HEALTH_CHECK_FAILED)$/);
    assert.ok(s.appliedSeq < s.desiredSeq, "the failed revision is not acknowledged");

    // The last-known-good config is running again and serving traffic.
    await waitFor("the restored config to carry traffic", async () => {
      return ((await fetchVia(ctx.mainClient, 2048, { maxSeconds: 5 }))).ok;
    }, { timeoutMs: 60_000, intervalMs: 1000 });
    const sub = await fetchSubscription(ctx.mainSub.token);
    assert.doesNotMatch(sub.text, /harness-port-conflict/);

    await admin.call(FN.deleteNode, { id: ctx.conflictNodeId });
    await waitApplied("the config without the conflicting node");
    await blocker.close();
  });

  // ------------------------------------------------------ expiry and revocation

  await step("expiry: a subscription that lapses stops working on the proxy", async () => {
    ctx.expiringClient = await startClientFor("expiring", ctx.expiringProxy);
    assert.equal((await fetchVia(ctx.expiringClient, 1024)).ok, true);

    const expiresAt = new Date(Date.now() + 25_000);
    await admin.call(FN.updateSubscription, { id: ctx.expiringSub.id, expiresAt: expiresAt.toISOString() });
    await waitApplied("the shortened expiry");
    assert.equal((await fetchVia(ctx.expiringClient, 1024)).ok, true, "still valid before expiry");

    await sleep(Math.max(0, expiresAt.getTime() - Date.now()) + 1500);
    // The app stops publishing it immediately...
    assert.equal((await fetchSubscription(ctx.expiringSub.token)).status, 403);
    // ...and the agent drops the credential on its next poll.
    await waitFor("the proxy to refuse the expired credential", async () => {
      return !((await fetchVia(ctx.expiringClient, 1024, { maxSeconds: 5 }))).ok;
    }, { timeoutMs: 90_000, intervalMs: 2000 });
    await waitApplied("the config without the expired user");
    // The other subscriber is unaffected.
    assert.equal((await fetchVia(ctx.mainClient, 1024)).ok, true);
  });

  await step("revoke: cancelling a subscription cuts the user off", async () => {
    await admin.call(FN.updateSubscription, { id: ctx.mainSub.id, status: "cancelled" });
    assert.equal((await fetchSubscription(ctx.mainSub.token)).status, 403, "the link stops immediately");
    await waitFor("the proxy to refuse the revoked credential", async () => {
      return !((await fetchVia(ctx.mainClient, 1024, { maxSeconds: 5 }))).ok;
    }, { timeoutMs: 90_000, intervalMs: 2000 });
    const s = await waitApplied("the config without the revoked user");
    assert.equal(s.runtimeState, "running");
  });

  await step("restore: re-activating the subscription gates, then restores access", async () => {
    await admin.call(FN.updateSubscription, { id: ctx.mainSub.id, status: "active" });
    // Until the agent applies the re-activation the app must not advertise it:
    // the gate replays the cancelled state, so the link still answers 403.
    const held = await fetchSubscription(ctx.mainSub.token);
    assert.notEqual(held.status, 200, "an unapplied re-activation must not be served");
    assert.doesNotMatch(held.text, /vmess/);
    await waitApplied("the re-activation");
    const sub = await fetchSubscription(ctx.mainSub.token);
    assert.equal(sub.status, 200);
    await waitFor("the proxy to accept the restored credential", async () => {
      return ((await fetchVia(ctx.mainClient, 1024, { maxSeconds: 5 }))).ok;
    }, { timeoutMs: 30_000, intervalMs: 1000 });
  });
}
