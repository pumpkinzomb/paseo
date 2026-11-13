import test from "node:test";
import assert from "node:assert/strict";
import { executeGoogleWrite, googleWriteScopes } from "./write.mjs";
test("document insertion pins required revision and sends only insertText", async () => {
  let captured;
  await executeGoogleWrite({
    tool: "docs.insertText",
    input: { id: "doc1", text: "hello", revisionId: "rev1" },
    getAccessToken: async (scope) => {
      assert.equal(scope, googleWriteScopes.docs);
      return "fixture";
    },
    request: async (url, options) => {
      captured = { url, options };
      return Response.json({});
    },
  });
  assert.equal(captured.url, "https://docs.googleapis.com/v1/documents/doc1:batchUpdate");
  assert.equal(captured.options.method, "POST");
  assert.deepEqual(JSON.parse(captured.options.body), {
    writeControl: { requiredRevisionId: "rev1" },
    requests: [{ insertText: { text: "hello", endOfSegmentLocation: {} } }],
  });
  assert.equal(captured.options.redirect, "error");
});
test("sheet range writes RAW values rather than executing input formulas", async () => {
  let captured;
  await executeGoogleWrite({
    tool: "sheets.updateValues",
    input: { id: "sheet1", range: "Sheet 1!A1", values: [["=SUM(A2:A3)"]] },
    getAccessToken: async (scope) => {
      assert.equal(scope, googleWriteScopes.sheets);
      return "fixture";
    },
    request: async (url, options) => {
      captured = { url, options };
      return Response.json({});
    },
  });
  assert.equal(
    captured.url,
    "https://sheets.googleapis.com/v4/spreadsheets/sheet1/values/Sheet%201!A1?valueInputOption=RAW",
  );
  assert.equal(captured.options.method, "PUT");
  assert.deepEqual(JSON.parse(captured.options.body), {
    range: "Sheet 1!A1",
    majorDimension: "ROWS",
    values: [["=SUM(A2:A3)"]],
  });
});
for (const [tool, input] of [
  ["docs.insertText", { id: "x", text: "y" }],
  ["docs.insertText", { id: "x", text: "y", revisionId: "r", index: 0 }],
  ["sheets.updateValues", { id: "x", range: "A1", values: [[{}]] }],
  ["gmail.send", {}],
]) {
  test(`invalid write is rejected before credentials: ${tool} ${JSON.stringify(input)}`, async () => {
    await assert.rejects(
      executeGoogleWrite({
        tool,
        input,
        getAccessToken: async () => assert.fail("must not access credentials"),
      }),
    );
  });
}
