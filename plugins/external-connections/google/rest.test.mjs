import test from "node:test";
import assert from "node:assert/strict";
import { executeGoogleRead, googleReadScopes } from "./rest.mjs";

test("Gmail search uses only the fixed Google endpoint and minimum read scope", async () => {
  const calls = [];
  const result = await executeGoogleRead({
    tool: "gmail.search",
    input: { query: "hello", maxResults: 5 },
    getAccessToken: async (scope) => {
      assert.equal(scope, googleReadScopes.gmail);
      return "fixture";
    },
    request: async (url, options) => {
      calls.push([String(url), options]);
      return Response.json({ messages: [] });
    },
  });
  assert.deepEqual(result, { messages: [] });
  assert.equal(
    calls[0][0],
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=hello&maxResults=5",
  );
  assert.equal(calls[0][1].headers.Authorization, "Bearer fixture");
  assert.equal(calls[0][1].redirect, "error");
});

for (const [tool, input, scope, expected] of [
  [
    "gmail.read",
    { id: "abc123" },
    googleReadScopes.gmail,
    "https://gmail.googleapis.com/gmail/v1/users/me/messages/abc123?format=full",
  ],
  [
    "docs.read",
    { id: "document_1" },
    googleReadScopes.docs,
    "https://docs.googleapis.com/v1/documents/document_1",
  ],
  [
    "sheets.read",
    { id: "sheet_1", range: "Tab 1!A1:B2" },
    googleReadScopes.sheets,
    "https://sheets.googleapis.com/v4/spreadsheets/sheet_1/values/Tab%201!A1%3AB2",
  ],
]) {
  test(`${tool} uses its separate scope and fixed read endpoint`, async () => {
    await executeGoogleRead({
      tool,
      input,
      getAccessToken: async (value) => {
        assert.equal(value, scope);
        return "fixture";
      },
      request: async (url, options) => {
        assert.equal(String(url), expected);
        assert.equal(options.method, "GET");
        return Response.json({});
      },
    });
  });
}
for (const [tool, input, code] of [
  ["gmail.send", {}, "UNSUPPORTED_TOOL"],
  ["docs.read", { id: "../other" }, "INVALID_ID"],
  ["docs.read", { id: "https://evil.example" }, "INVALID_ID"],
  ["gmail.search", { query: "x", maxResults: 101 }, "INVALID_LIMIT"],
  ["sheets.read", { id: "x", range: "" }, "INVALID_INPUT"],
]) {
  test(`rejects ${tool} ${JSON.stringify(input)} before reading credentials`, async () => {
    await assert.rejects(
      executeGoogleRead({
        tool,
        input,
        getAccessToken: async () => {
          assert.fail("must not read credentials");
        },
      }),
      { code },
    );
  });
}
for (const [status, code] of [
  [401, "LOGIN_REQUIRED"],
  [403, "PERMISSION_OR_API_DISABLED"],
  [429, "RATE_LIMITED"],
  [500, "GOOGLE_REQUEST_FAILED"],
]) {
  test(`HTTP ${status} is actionable without leaking response body`, async () => {
    await assert.rejects(
      executeGoogleRead({
        tool: "docs.read",
        input: { id: "x" },
        getAccessToken: async () => "fixture",
        request: async () => new Response("private contents", { status }),
      }),
      { message: code, code },
    );
  });
}
test("transport errors are sanitized", async () => {
  await assert.rejects(
    executeGoogleRead({
      tool: "docs.read",
      input: { id: "x" },
      getAccessToken: async () => "fixture",
      request: async () => {
        throw new Error("secret token");
      },
    }),
    { message: "NETWORK_OR_TIMEOUT" },
  );
});
