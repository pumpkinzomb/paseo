import test from "node:test";
import assert from "node:assert/strict";
import { GoogleBridgeSessions } from "./session-broker.mjs";
import { googleReadScopes } from "./rest.mjs";

test("bearer grants only bound scopes and expires", () => {
  let now = 0;
  const sessions = new GoogleBridgeSessions({ clock: () => now });
  const session = sessions.openSession({
    agentId: "agent-1",
    provider: "codex",
    scopes: [googleReadScopes.docs],
  });
  assert.deepEqual(sessions.authorize(session.authorization, googleReadScopes.docs), {
    agentId: "agent-1",
    provider: "codex",
  });
  assert.throws(() => sessions.authorize(session.authorization, googleReadScopes.gmail), {
    code: "SCOPE_NOT_GRANTED",
  });
  now = 300000;
  assert.throws(() => sessions.authorize(session.authorization, googleReadScopes.docs), {
    code: "SESSION_UNAUTHORIZED",
  });
});

import { validateGoogleBridgeRequest } from "./session-broker.mjs";
test("revocation affects only the selected agent, revokeAll ends remaining sessions", () => {
  const sessions = new GoogleBridgeSessions();
  const one = sessions.openSession({
    agentId: "one",
    provider: "codex",
    scopes: [googleReadScopes.docs],
  });
  const two = sessions.openSession({
    agentId: "two",
    provider: "claude",
    scopes: [googleReadScopes.docs],
  });
  sessions.revokeAgent("one");
  assert.throws(() => sessions.authorize(one.authorization, googleReadScopes.docs), {
    code: "SESSION_UNAUTHORIZED",
  });
  assert.deepEqual(sessions.authorize(two.authorization, googleReadScopes.docs), {
    agentId: "two",
    provider: "claude",
  });
  sessions.revokeAll();
  assert.throws(() => sessions.authorize(two.authorization, googleReadScopes.docs), {
    code: "SESSION_UNAUTHORIZED",
  });
});
test("forged bearers and unsupported mail scopes are refused", () => {
  const sessions = new GoogleBridgeSessions();
  assert.throws(() => sessions.authorize("Bearer " + "x".repeat(43), googleReadScopes.docs), {
    code: "SESSION_UNAUTHORIZED",
  });
  assert.throws(
    () =>
      sessions.openSession({
        agentId: "one",
        provider: "codex",
        scopes: ["https://www.googleapis.com/auth/gmail.send"],
      }),
    { code: "INVALID_SCOPES" },
  );
});
test("session count is bounded and expired entries are reclaimed", () => {
  let time = 0;
  const sessions = new GoogleBridgeSessions({ clock: () => time });
  const input = { agentId: "one", provider: "codex", scopes: [googleReadScopes.docs] };
  for (let i = 0; i < 128; i++) sessions.openSession(input);
  assert.throws(() => sessions.openSession(input), { code: "SESSION_LIMIT" });
  time = 300000;
  assert.equal(sessions.openSession(input).expiresAt, 600000);
});
const nativeRequest = {
  host: "127.0.0.1:49152",
  origin: undefined,
  method: "POST",
  path: "/mcp",
  port: 49152,
};
test("native loopback MCP POST passes request boundary", () =>
  assert.equal(validateGoogleBridgeRequest(nativeRequest), undefined));
for (const invalid of [
  { origin: "https://evil.example" },
  { origin: "null" },
  { host: "evil.example:49152" },
  { host: "localhost:49152" },
  { method: "GET" },
  { path: "/mcp?token=secret" },
  { port: 0 },
]) {
  test(`request boundary rejects ${JSON.stringify(invalid)}`, () =>
    assert.throws(() => validateGoogleBridgeRequest({ ...nativeRequest, ...invalid }), {
      code: "INVALID_BRIDGE_REQUEST",
    }));
}

test("host lifecycle lease survives normal long work but retains hard 24-hour cap", () => {
  let now = 0;
  const sessions = new GoogleBridgeSessions({ clock: () => now, sessionTtlMs: 86400000 });
  const session = sessions.openSession({
    agentId: "one",
    provider: "codex",
    scopes: [googleReadScopes.docs],
  });
  now = 90 * 60000;
  assert.deepEqual(sessions.authorize(session.authorization, googleReadScopes.docs), {
    agentId: "one",
    provider: "codex",
  });
  now = 86400000;
  assert.throws(() => sessions.authorize(session.authorization, googleReadScopes.docs), {
    code: "SESSION_UNAUTHORIZED",
  });
});
