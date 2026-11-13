const test = require("node:test");
const assert = require("node:assert/strict");
const { compileArguments, helperPath } = require("./google-keychain");
test("helper lives outside asar in macOS signed helper location", () => {
  assert.equal(helperPath("/build"), "/build/Paseo.app/Contents/Helpers/paseo-google-keychain");
});
test("compiler targets match supported macOS minimum and app architecture", () => {
  assert.deepEqual(compileArguments("/source", "/output", "arm64"), [
    "-O",
    "-target",
    "arm64-apple-macos13.0",
    "/source",
    "-o",
    "/output",
  ]);
  assert.deepEqual(compileArguments("/source", "/output", "x64"), [
    "-O",
    "-target",
    "x86_64-apple-macos13.0",
    "/source",
    "-o",
    "/output",
  ]);
  assert.throws(() => compileArguments("/source", "/output", "ia32"));
});
