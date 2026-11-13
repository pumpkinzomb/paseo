import test from "node:test";
import assert from "node:assert/strict";
import { startGoogleOAuthCallback } from "./oauth-callback.mjs";
import { googleReadScopes } from "./rest.mjs";
async function setup(t, extras = {}) {
  const flow = await startGoogleOAuthCallback({
    clientId: "fixture.apps.googleusercontent.com",
    scopes: [googleReadScopes.docs],
    onExchange: async (form) => ({ codeReceived: form.get("code") === "fixture" }),
    ...extras,
  });
  t.after(() => flow.cancel());
  const authorization = new URL(flow.authorizationUrl);
  const callback = new URL(authorization.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set("code", "fixture");
  return { flow, callback };
}
test("loopback callback completes only valid state and does not reflect code", async (t) => {
  const { flow, callback } = await setup(t);
  const response = await fetch(callback);
  assert.equal(response.status, 200);
  assert.equal((await response.text()).includes("fixture"), false);
  assert.deepEqual(await flow.completion, { codeReceived: true });
});
test("forged callback does not consume attempt or exchange token", async (t) => {
  let called = false;
  const { flow, callback } = await setup(t, {
    onExchange: async () => {
      called = true;
    },
  });
  callback.searchParams.set("state", "wrong");
  assert.equal((await fetch(callback)).status, 400);
  assert.equal(called, false);
  assert.equal(flow.cancel(), true);
  await assert.rejects(flow.completion, { code: "OAUTH_CANCELLED" });
});
test("callback rejects browser cross-origin request", async (t) => {
  const { flow, callback } = await setup(t);
  assert.equal(
    (await fetch(callback, { headers: { Origin: "https://evil.example" } })).status,
    400,
  );
  flow.cancel();
});
test("consent denial ends callback and reports sanitized failure", async (t) => {
  const { flow, callback } = await setup(t);
  callback.searchParams.set("error", "access_denied");
  assert.equal((await fetch(callback)).status, 400);
  await assert.rejects(flow.completion, { code: "CONSENT_NOT_COMPLETED" });
});
test("exchange errors do not expose credential details", async (t) => {
  const { flow, callback } = await setup(t, {
    onExchange: async () => {
      throw new Error("secret");
    },
  });
  const response = await fetch(callback);
  assert.equal(response.status, 500);
  assert.equal((await response.text()).includes("secret"), false);
  await assert.rejects(flow.completion, { code: "TOKEN_EXCHANGE_FAILED" });
});
test("timeout closes pending callback", async (t) => {
  const { flow } = await setup(t, { timeoutMs: 10 });
  await assert.rejects(flow.completion, { code: "OAUTH_ATTEMPT_EXPIRED" });
});
