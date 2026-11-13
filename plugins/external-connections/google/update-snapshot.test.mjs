import assert from "node:assert/strict";
import test from "node:test";
import { observeService, downstreamBlockers } from "./update-snapshot.mjs";
import { createHostGoogleService } from "./host-provisioning.mjs";
import { createGoogleConnectionService } from "./host-service.mjs";
import { createGoogleMcpBridge } from "./mcp-bridge.mjs";
import { GoogleBridgeSessions } from "./session-broker.mjs";
import { googleReadScopes } from "./rest.mjs";
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("snapshot never invokes downstream status and counts concurrent/rejected operations", async () => {
  const wait = deferred();
  const service = observeService(
    {
      status: () => wait.promise,
      begin: async () => {
        throw new Error("expected");
      },
    },
    () => [],
  );
  const a = service.status();
  const b = service.status();
  assert.deepEqual(service.getUpdateBlockers(), ["google status: 2 active"]);
  await assert.rejects(service.begin());
  wait.resolve();
  await Promise.all([a, b]);
  assert.deepEqual(service.getUpdateBlockers(), []);
  assert.deepEqual(
    downstreamBlockers(
      {
        status: () => {
          throw Error("must not call");
        },
      },
      "child",
    ),
    ["child: unknown"],
  );
  assert.deepEqual(
    downstreamBlockers(
      {
        getUpdateBlockers: () => {
          throw Error("secret");
        },
      },
      "child",
    ),
    ["child: unknown"],
  );
});
test("preparation tracked without probing helpers or Keychain", async () => {
  const wait = deferred();
  let calls = 0;
  const service = createHostGoogleService({
    stateDirectory: "/unused-private-fixture",
    runtimeMode: "development",
    prepareDevelopmentStore: () => {
      calls++;
      return wait.promise;
    },
    createProvisioned: () => ({
      configure: async () => {},
      getUpdateBlockers: () => [],
    }),
  });
  assert.deepEqual(service.getUpdateBlockers(), []);
  assert.equal(calls, 0);
  const configuring = service.configure({});
  assert(service.getUpdateBlockers().includes("google preparing"));
  wait.resolve({});
  await configuring;
  assert.deepEqual(service.getUpdateBlockers(), []);
});
test("OAuth callback completion remains pending after cancellation", async () => {
  const wait = deferred();
  const service = createGoogleConnectionService({
    clientId: "fixture.apps.googleusercontent.com",
    store: {},
    createBridge: () => ({
      getUpdateBlockers: () => [],
      revokeAgent: () => {},
    }),
    openCallback: async () => ({
      authorizationUrl: "http://fixture",
      completion: wait.promise,
      cancel: () => true,
    }),
  });
  await service.begin([]);
  await service.cancel();
  assert(service.getUpdateBlockers().some((s) => s.includes("OAuth pending")));
  wait.resolve();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(service.getUpdateBlockers(), []);
});
test("session count observes expiry without revoking and bridge snapshot is memory-only", () => {
  let now = 0;
  const sessions = new GoogleBridgeSessions({
    clock: () => now,
    sessionTtlMs: 1000,
  });
  const input = {
    agentId: "fixture",
    provider: "codex",
    scopes: [Object.values(googleReadScopes)[0]],
  };
  sessions.openSession(input);
  assert.equal(sessions.activeCount, 1);
  now = 1001;
  assert.equal(sessions.activeCount, 0);
  const bridge = createGoogleMcpBridge({
    getAccessToken: () => {
      throw Error("must not probe");
    },
  });
  assert.deepEqual(bridge.getUpdateBlockers(), []);
});
test("in-flight MCP request remains blocked after session revocation", async (t) => {
  const entered = deferred();
  const wait = deferred();
  const bridge = createGoogleMcpBridge({
    getAccessToken: async () => "fixture-token",
    request: async () => {
      entered.resolve();
      await wait.promise;
      return Response.json({ title: "fixture" });
    },
  });
  await bridge.start();
  t.after(() => bridge.stop());
  const session = bridge.openSession({
    agentId: "fixture",
    provider: "codex",
    scopes: [googleReadScopes.docs],
  });
  assert(bridge.getUpdateBlockers().includes("google MCP sessions: 1"));
  const response = fetch(session.url, {
    method: "POST",
    headers: { ...session.headers, "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "docs.read", arguments: { id: "fixture-doc" } },
    }),
  });
  await entered.promise;
  bridge.revokeAgent("fixture");
  assert(bridge.getUpdateBlockers().includes("google MCP requests: 1"));
  assert(bridge.getUpdateBlockers().includes("google MCP streams: 1"));
  wait.resolve();
  await (await response).json();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bridge.getUpdateBlockers(), []);
});
