import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleTokenBroker } from "./token-broker.mjs";
import { googleReadScopes as scopes } from "./rest.mjs";
const clientId = "fixture.apps.googleusercontent.com";
function setup(overrides = {}) {
  const records = new Map();
  const calls = [];
  const store = {
    read: async (key) => records.get(key) ?? null,
    write: async (key, value) => {
      records.set(key, value);
    },
    delete: async (key) => {
      records.delete(key);
    },
  };
  const broker = createGoogleTokenBroker({
    clientId,
    store,
    request: async (url, options) => {
      calls.push({ url, options });
      return Response.json({
        access_token: "fixture-access",
        refresh_token: "fixture-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        scope: scopes.docs,
      });
    },
    ...overrides,
  });
  const authorize = () =>
    broker.acceptAuthorization({
      account: "one",
      exchange: new URLSearchParams({
        client_id: clientId,
        grant_type: "authorization_code",
        code: "fixture-code",
        code_verifier: "fixture-verifier",
      }),
      requestedScopes: [scopes.docs],
    });
  return { broker, records, calls, authorize };
}
test("authorization stores only refresh material and returns no token", async () => {
  const { authorize, broker, records, calls } = setup();
  assert.deepEqual(await authorize(), { scopes: [scopes.docs] });
  assert.deepEqual(JSON.parse(records.get("one")), {
    clientId,
    refreshToken: "fixture-refresh",
    scopes: [scopes.docs],
  });
  assert.equal(
    await broker.getAccessToken({ account: "one", scope: scopes.docs }),
    "fixture-access",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[0].options.redirect, "error");
});
test("parallel expired requests coalesce through cache and retain refresh token if not rotated", async () => {
  let count = 0;
  const { records, broker } = setup({
    request: async () => {
      count++;
      return Response.json({ access_token: "fresh", token_type: "Bearer", expires_in: 3600 });
    },
  });
  records.set("one", JSON.stringify({ clientId, refreshToken: "old", scopes: [scopes.docs] }));
  assert.deepEqual(
    await Promise.all(
      [1, 2, 3].map(() => broker.getAccessToken({ account: "one", scope: scopes.docs })),
    ),
    ["fresh", "fresh", "fresh"],
  );
  assert.equal(count, 1);
  assert.equal(JSON.parse(records.get("one")).refreshToken, "old");
});
test("refresh rotation persists before returning access token", async () => {
  const { records, broker } = setup();
  records.set("one", JSON.stringify({ clientId, refreshToken: "old", scopes: [scopes.docs] }));
  await broker.getAccessToken({ account: "one", scope: scopes.docs });
  assert.equal(JSON.parse(records.get("one")).refreshToken, "fixture-refresh");
});
test("revoked grant clears stored credentials and invalidates host sessions", async () => {
  const invalidated = [];
  const { records, broker } = setup({
    onInvalidated: (account) => invalidated.push(account),
    request: async () =>
      Response.json({ error: "invalid_grant", error_description: "private" }, { status: 400 }),
  });
  records.set("one", JSON.stringify({ clientId, refreshToken: "old", scopes: [scopes.docs] }));
  await assert.rejects(broker.getAccessToken({ account: "one", scope: scopes.docs }), {
    message: "LOGIN_REQUIRED",
  });
  assert.deepEqual(invalidated, ["one"]);
  assert.equal(records.size, 0);
});
test("unsupported/ungranted scopes do not contact token endpoint", async () => {
  const { authorize, broker, calls } = setup();
  await authorize();
  await assert.rejects(broker.getAccessToken({ account: "one", scope: scopes.gmail }), {
    code: "SCOPE_NOT_GRANTED",
  });
  await assert.rejects(
    broker.getAccessToken({ account: "one", scope: "https://www.googleapis.com/auth/gmail.send" }),
    { code: "UNSUPPORTED_SCOPE" },
  );
  assert.equal(calls.length, 1);
});
test("storage failure prevents presenting newly authorized credentials", async () => {
  const { authorize, broker } = setup({
    store: {
      read: async () => null,
      write: async () => {
        throw new Error("store failed");
      },
      delete: async () => {},
    },
  });
  await assert.rejects(authorize(), /store failed/);
  assert.deepEqual(await broker.status("one"), { status: "not-connected", scopes: [] });
});
test("forget clears cached tokens and queued refresh cannot resurrect credentials", async () => {
  const { authorize, broker, records } = setup();
  await authorize();
  await broker.forget("one");
  await assert.rejects(broker.getAccessToken({ account: "one", scope: scopes.docs }), {
    code: "LOGIN_REQUIRED",
  });
  assert.equal(records.size, 0);
});
test("response scope broadening rejected", async () => {
  const { authorize } = setup({
    request: async () =>
      Response.json({
        access_token: "a",
        refresh_token: "r",
        token_type: "Bearer",
        expires_in: 3600,
        scope: `${scopes.docs} ${scopes.gmail}`,
      }),
  });
  await assert.rejects(authorize(), { code: "UNEXPECTED_GRANTED_SCOPES" });
});

test("desktop client secret can come from host storage and is never returned", async () => {
  let body;
  const { authorize } = setup({
    getClientSecret: async () => "fixture-client-secret",
    request: async (url, options) => {
      body = new URLSearchParams(options.body);
      return Response.json({
        access_token: "a",
        refresh_token: "r",
        token_type: "Bearer",
        expires_in: 3600,
      });
    },
  });
  assert.deepEqual(await authorize(), { scopes: [scopes.docs] });
  assert.equal(body.get("client_secret"), "fixture-client-secret");
});

import { googleWriteScopes } from "./write.mjs";
test("stored and cached edit grants authorize reads without broadening consent", async () => {
  const { broker, records } = setup({
    request: async () =>
      Response.json({
        access_token: "edit-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: googleWriteScopes.docs,
      }),
  });
  records.set(
    "one",
    JSON.stringify({ clientId, refreshToken: "fixture-refresh", scopes: [googleWriteScopes.docs] }),
  );
  assert.equal(await broker.getAccessToken({ account: "one", scope: scopes.docs }), "edit-token");
  assert.equal(await broker.getAccessToken({ account: "one", scope: scopes.docs }), "edit-token");
  await assert.rejects(broker.getAccessToken({ account: "one", scope: scopes.gmail }), {
    code: "SCOPE_NOT_GRANTED",
  });
});
