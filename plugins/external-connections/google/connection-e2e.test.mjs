import test from "node:test";
import assert from "node:assert/strict";
import { createGoogleConnectionService } from "./host-service.mjs";
import { googleReadScopes } from "./rest.mjs";
import { googleWriteScopes } from "./write.mjs";

test("mock Google end-to-end: callback → secure-store contract → provider header → read/write → disconnect", async (t) => {
  const records = new Map();
  const requests = [];
  const scopes = [googleReadScopes.docs, googleWriteScopes.docs];
  const service = createGoogleConnectionService({
    clientId: "fixture.apps.googleusercontent.com",
    store: {
      read: async (key) => records.get(key) ?? null,
      write: async (key, value) => {
        records.set(key, value);
      },
      delete: async (key) => {
        records.delete(key);
      },
    },
    request: async (url, options) => {
      requests.push({ url: String(url), options });
      if (String(url) === "https://oauth2.googleapis.com/token") {
        const body = new URLSearchParams(options.body);
        assert.equal(body.get("code"), "fixture-code");
        assert.equal(body.get("code_verifier").length, 43);
        return Response.json({
          access_token: "fixture-access",
          refresh_token: "fixture-refresh",
          expires_in: 3600,
          token_type: "Bearer",
          scope: scopes.join(" "),
        });
      }
      assert.equal(options.headers.Authorization, "Bearer fixture-access");
      if (options.method === "GET")
        return Response.json({ title: "Fixture", revisionId: "revision-1" });
      assert.equal(String(url), "https://docs.googleapis.com/v1/documents/doc1:batchUpdate");
      assert.equal(JSON.parse(options.body).writeControl.requiredRevisionId, "revision-1");
      return Response.json({ documentId: "doc1" });
    },
  });
  t.after(() => service.dispose());
  const begin = await service.begin(scopes);
  const auth = new URL(begin.authorizationUrl);
  const callback = new URL(auth.searchParams.get("redirect_uri"));
  callback.searchParams.set("state", auth.searchParams.get("state"));
  callback.searchParams.set("code", "fixture-code");
  assert.equal((await fetch(callback)).status, 200);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await service.status(), { status: "credentials-stored", scopes });
  assert.equal(JSON.stringify(await service.status()).includes("fixture-refresh"), false);
  const launch = await service.openAgent({ agentId: "agent1", provider: "claude" });
  assert.equal(JSON.stringify(launch).includes("fixture-access"), false);
  async function call(name, args) {
    const response = await fetch(launch.url, {
      method: "POST",
      headers: { ...launch.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await call("docs.read", { id: "doc1" })).data.result.isError, undefined);
  assert.equal(
    (await call("docs.insertText", { id: "doc1", text: "addition", revisionId: "revision-1" })).data
      .result.isError,
    undefined,
  );
  assert.equal(requests.length, 3);
  await service.forget();
  assert.equal(records.size, 0);
  assert.equal((await call("docs.read", { id: "doc1" })).status, 401);
  assert.deepEqual(await service.status(), { status: "not-connected", scopes: [] });
});
